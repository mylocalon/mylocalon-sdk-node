import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tunnel } from "../src/tunnel.js";
import { EchoForwarder, FakeGateway, welcome } from "./fakes.js";

// Deterministic time (TESTING.md §7): heartbeat watchdog + backoff schedule.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function active(random = () => 0) {
  const gw = new FakeGateway();
  const t = new Tunnel({
    gatewayUrl: "wss://gw",
    token: "jwt",
    target: "http://localhost:3000",
    connect: gw.connect,
    forwarder: new EchoForwarder(),
    backoff: { random },
  });
  const p = t.connect();
  await vi.advanceTimersByTimeAsync(0);
  gw.conns[0]!.deliver(welcome({ heartbeat: { intervalMs: 15_000, timeoutMs: 45_000 } }));
  await p;
  return { gw, t };
}

describe("timers", () => {
  it("silent gateway → watchdog drops the socket at timeoutMs, then resumes", async () => {
    const { gw, t } = await active();
    const c = gw.conns[0]!;
    await vi.advanceTimersByTimeAsync(30_000);
    c.deliver({ type: "PING", ts: 1 }); // any message re-arms the watchdog
    await vi.advanceTimersByTimeAsync(44_000);
    expect(c.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.closed).toBe(true);
    expect(t.state).toBe("DISCONNECTED");

    await vi.advanceTimersByTimeAsync(250); // first backoff step (random=0 → 250ms)
    expect(gw.conns).toHaveLength(2);
    expect(gw.conns[1]!.last("HELLO")?.resume).toEqual({ tunnelId: "tnl_1", resumeToken: "rsm_1" });
  });

  it("backoff grows 0.5s → 8s cap while the gateway stays down", async () => {
    const { gw, t } = await active(() => 0.999999);
    gw.failNext = 100;
    const at: number[] = [];
    const t0 = Date.now();
    t.on("reconnecting", () => at.push(Date.now() - t0));
    gw.conns[0]!.drop(1006);
    await vi.advanceTimersByTimeAsync(40_000);
    const gaps = at.map((v, i) => v - (at[i - 1] ?? 0));
    expect(gaps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    await t.close();
  });
});
