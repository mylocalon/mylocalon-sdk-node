import http from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpForwarder, validateTarget } from "../src/forwarder.js";
import { decodeBody, encodeBody } from "../src/protocol/codec.js";
import type { HttpRequestMsg, HttpResponseMsg } from "../src/protocol/messages.js";

let server: http.Server;
let target: string;
let seen: http.IncomingMessage & { body?: string };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = Object.assign(req, { body: Buffer.concat(chunks).toString() });
      if (req.url === "/slow") return; // never respond
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
        res.end(gzipSync("hello"));
        return;
      }
      if (req.url === "/big") {
        res.end(Buffer.alloc(5000));
        return;
      }
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.writeHead(201, { "content-type": "application/json", "x-echo-path": req.url ?? "" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = (over: Partial<HttpRequestMsg> = {}): HttpRequestMsg => ({
  type: "HTTP_REQUEST",
  reqId: "rq_1",
  method: "POST",
  path: "/api/users?limit=10",
  headers: [
    ["content-type", "application/json"],
    ["x-dup", "a"],
    ["x-dup", "b"],
    ["connection", "keep-alive, x-secret-hop"],
    ["x-secret-hop", "drop-me"],
    ["x-forwarded-host", "abc.mylocalon.com"],
  ],
  bodyB64: encodeBody(Buffer.from('{"name":"a"}')),
  ...over,
});

describe("HttpForwarder", () => {
  it("forwards method, path, headers and body; returns exact response", async () => {
    const f = new HttpForwarder(target);
    const res = (await f.forward(req())) as HttpResponseMsg;
    expect(res.type).toBe("HTTP_RESPONSE");
    expect(res.reqId).toBe("rq_1");
    expect(res.status).toBe(201);
    expect(decodeBody(res.bodyB64).toString()).toBe('{"ok":true}');
    expect(res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v)).toEqual(["a=1", "b=2"]);
    expect(res.headers.find(([k]) => k === "x-echo-path")?.[1]).toBe("/api/users?limit=10");

    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"name":"a"}');
    expect(seen.headers["host"]).toBe(new URL(target).host);
    expect(seen.headers["x-dup"]).toBe("a, b");
    expect(seen.headers["x-secret-hop"]).toBeUndefined();
    expect(seen.headers["x-forwarded-host"]).toBe("abc.mylocalon.com");
  });

  it("passes compressed bodies through byte-for-byte", async () => {
    const res = (await new HttpForwarder(target).forward(req({ method: "GET", path: "/gzip", bodyB64: "" }))) as HttpResponseMsg;
    expect(res.headers).toContainEqual(["content-encoding", "gzip"]);
    expect(decodeBody(res.bodyB64)).toEqual(gzipSync("hello"));
  });

  it("UPSTREAM_UNREACHABLE when the app is down", async () => {
    const res = await new HttpForwarder("http://127.0.0.1:1").forward(req());
    expect(res).toMatchObject({ type: "ERROR", reqId: "rq_1", code: "UPSTREAM_UNREACHABLE" });
  });

  it("UPSTREAM_TIMEOUT when the app is slow", async () => {
    const res = await new HttpForwarder(target, { timeoutMs: 100 }).forward(req({ path: "/slow" }));
    expect(res).toMatchObject({ type: "ERROR", code: "UPSTREAM_TIMEOUT" });
  });

  it("BODY_TOO_LARGE above the gateway limit", async () => {
    const res = await new HttpForwarder(target).forward(req({ method: "GET", path: "/big", bodyB64: "" }), { maxBodyBytes: 1000 });
    expect(res).toMatchObject({ type: "ERROR", code: "BODY_TOO_LARGE" });
  });

  it("validates the target", () => {
    expect(() => validateTarget("ftp://x")).toThrow();
    expect(() => validateTarget("http://localhost:3000/path")).toThrow();
    expect(validateTarget("http://localhost:3000").port).toBe("3000");
  });
});
