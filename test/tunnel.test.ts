import { describe, expect, it, vi } from "vitest";
import { Tunnel, type TunnelOptions } from "../src/tunnel.js";
import { GatewayError } from "../src/lib/errors.js";
import { EchoForwarder, FakeGateway, tick, welcome } from "./fakes.js";

function setup(over: Partial<TunnelOptions> = {}) {
  const gw = new FakeGateway();
  const fwd = new EchoForwarder();
  const t = new Tunnel({
    gatewayUrl: "wss://gw/tunnel",
    token: "jwt",
    target: "http://localhost:3000",
    connect: gw.connect,
    forwarder: fwd,
    backoff: { initialMs: 1, maxMs: 4, random: () => 0 },
    ...over,
  });
  const states: string[] = [];
  t.on("state", (s: { to: string }) => states.push(s.to));
  return { gw, fwd, t, states };
}

async function activate(over: Partial<TunnelOptions> = {}) {
  const s = setup(over);
  const p = s.t.connect();
  const c = await s.gw.nextConn(0);
  await tick();
  c.deliver(welcome());
  const info = await p;
  return { ...s, c, info };
}

describe("Tunnel", () => {
  it("sends HELLO and resolves on WELCOME", async () => {
    const { c, info, t, states } = await activate({ subdomain: "myapp" });
    const hello = c.last("HELLO")!;
    expect(hello).toMatchObject({ protocol: 1, token: "jwt", tunnel: { subdomain: "myapp", targetHint: "http://localhost:3000" } });
    expect(hello.resume).toBeUndefined();
    expect(info).toEqual({ tunnelId: "tnl_1", subdomain: "abc123", url: "https://abc123.mylocalon.com" });
    expect(t.state).toBe("ACTIVE");
    expect(states).toEqual(["CONNECTING", "ACTIVE"]);
  });

  it("replies PONG to PING", async () => {
    const { c } = await activate();
    c.deliver({ type: "PING", ts: 7 });
    expect(c.last("PONG")).toEqual({ type: "PONG", ts: 7 });
  });

  it("forwards HTTP_REQUEST and replies with the same reqId", async () => {
    const { c, fwd, t } = await activate();
    const events: unknown[] = [];
    t.on("request", (e) => events.push(e));
    c.deliver({ type: "HTTP_REQUEST", reqId: "rq_9", method: "GET", path: "/x", headers: [], bodyB64: "" });
    await vi.waitFor(() => expect(c.last("HTTP_RESPONSE")).toBeDefined());
    expect(c.last("HTTP_RESPONSE")).toMatchObject({ reqId: "rq_9", status: 200 });
    expect(fwd.calls[0]?.path).toBe("/x");
    expect(events[0]).toMatchObject({ reqId: "rq_9", status: 200 });
  });

  it("rejects connect() on a fatal GOAWAY", async () => {
    const { gw, t } = setup();
    const p = t.connect();
    const c = await gw.nextConn(0);
    c.deliver({ type: "GOAWAY", code: "AUTH_FAILED", message: "bad token", reconnect: false });
    c.drop(1008);
    await expect(p).rejects.toBeInstanceOf(GatewayError);
    await expect(p).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(t.state).toBe("CLOSED");
  });

  it("rejects connect() when the gateway is unreachable", async () => {
    const { gw, t } = setup();
    gw.failNext = 1;
    await expect(t.connect()).rejects.toThrow("ECONNREFUSED");
    expect(t.state).toBe("CLOSED");
  });

  it("resumes after a drop with tunnelId + resumeToken", async () => {
    const { gw, c, t, states } = await activate();
    c.drop(1006);
    expect(t.state).toBe("DISCONNECTED");
    const c2 = await gw.nextConn(1);
    await tick();
    expect(c2.last("HELLO")?.resume).toEqual({ tunnelId: "tnl_1", resumeToken: "rsm_1" });
    expect(c2.last("HELLO")?.tunnel).toBeDefined(); // fresh fallback allowed
    c2.deliver(welcome({ resumeToken: "rsm_2" }));
    expect(t.state).toBe("ACTIVE");
    expect(states).toEqual(["CONNECTING", "ACTIVE", "DISCONNECTED", "RECONNECTING", "ACTIVE"]);

    // The rotated token is used next time.
    c2.drop(1006);
    const c3 = await gw.nextConn(2);
    await tick();
    expect(c3.last("HELLO")?.resume?.resumeToken).toBe("rsm_2");
  });

  it("keeps retrying with backoff while the gateway is down", async () => {
    const { gw, c, t } = await activate();
    gw.failNext = 3;
    const attempts: number[] = [];
    t.on("reconnecting", (n: number) => attempts.push(n));
    c.drop(1006);
    const c2 = await gw.nextConn(1);
    await tick();
    c2.deliver(welcome());
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(t.state).toBe("ACTIVE");
  });

  it("reconnects on GOAWAY{reconnect:true} (gateway restart)", async () => {
    const { gw, c, t } = await activate();
    c.deliver({ type: "GOAWAY", code: "SHUTDOWN", message: "restart", reconnect: true });
    c.drop(1000);
    const c2 = await gw.nextConn(1);
    await tick();
    expect(c2.last("HELLO")?.resume).toBeDefined();
    expect(t.state).toBe("RECONNECTING");
  });

  it("stops on a fatal GOAWAY after being active", async () => {
    const { c, t } = await activate();
    const closed = new Promise((r) => t.on("closed", r));
    c.deliver({ type: "GOAWAY", code: "AUTH_REVOKED", message: "revoked", reconnect: false });
    c.drop(1008);
    await expect(closed).resolves.toMatchObject({ reason: "AUTH_REVOKED" });
    expect(t.state).toBe("CLOSED");
  });

  it("refreshes the token via tokenProvider on each HELLO", async () => {
    let n = 0;
    const { gw, c } = await activate({ token: undefined as never, tokenProvider: async () => `jwt${++n}` });
    expect(c.last("HELLO")?.token).toBe("jwt1");
    c.drop(1006);
    const c2 = await gw.nextConn(1);
    await tick();
    expect(c2.last("HELLO")?.token).toBe("jwt2");
  });

  it("a fatal tokenProvider error (revoked key) stops reconnecting", async () => {
    let n = 0;
    const { c, t } = await activate({
      token: undefined as never,
      tokenProvider: async () => {
        if (++n > 1) throw Object.assign(new Error("API key was rejected"), { fatal: true });
        return "jwt";
      },
    });
    const closed = new Promise((r) => t.on("closed", r));
    c.drop(1006);
    await expect(closed).resolves.toMatchObject({ reason: "auth_failed" });
    expect(t.state).toBe("CLOSED");
  });

  it("close() sends CLOSE and ends CLOSED without reconnecting", async () => {
    const { gw, c, t } = await activate();
    await t.close();
    expect(c.last("CLOSE")).toEqual({ type: "CLOSE", tunnelId: "tnl_1" });
    expect(t.state).toBe("CLOSED");
    await new Promise((r) => setTimeout(r, 20));
    expect(gw.conns.length).toBe(1);
  });

  it("does not reconnect when reconnect:false", async () => {
    const { c, t } = await activate({ reconnect: false });
    c.drop(1006);
    expect(t.state).toBe("CLOSED");
  });

  it("bounds concurrency", async () => {
    const gw = new FakeGateway();
    let active = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const t = new Tunnel({
      gatewayUrl: "wss://gw", token: "jwt", target: "http://localhost:1", connect: gw.connect, maxConcurrency: 2,
      forwarder: {
        forward: (r) => {
          active++;
          peak = Math.max(peak, active);
          return new Promise((res) => release.push(() => {
            active--;
            res({ type: "HTTP_RESPONSE", reqId: r.reqId, status: 200, headers: [], bodyB64: "" });
          }));
        },
      },
    });
    const p = t.connect();
    const c = await gw.nextConn(0);
    await tick();
    c.deliver(welcome());
    await p;
    for (let i = 0; i < 5; i++) c.deliver({ type: "HTTP_REQUEST", reqId: `r${i}`, method: "GET", path: "/", headers: [], bodyB64: "" });
    await tick();
    expect(peak).toBe(2);
    while (c.sent.filter((m) => m.type === "HTTP_RESPONSE").length < 5) {
      release.shift()?.();
      await tick();
    }
    expect(peak).toBe(2);
  });
});
