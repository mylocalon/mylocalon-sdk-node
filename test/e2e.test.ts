/**
 * SDK ↔ real Go Gateway on localhost (TESTING.md §1 "Integration").
 * Builds ../mylocalon-gateway, mints a dev JWT, and drives real traffic.
 * Skipped when Go or the gateway repo is not available.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Tunnel } from "../src/index.js";

const gwDir = join(import.meta.dirname, "../../mylocalon-gateway");
const hasGo = (() => {
  try {
    execFileSync("go", ["version"]);
    return existsSync(gwDir);
  } catch {
    return false;
  }
})();

const port = 20000 + Math.floor(Math.random() * 20000);
let gw: ChildProcess;
let app: http.Server;
let appUrl: string;
let tmp: string;
let token: () => string;

async function waitFor(fn: () => Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

function publicGet(sub: string, path: string, init: { method?: string; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `${sub}.localtest.me:${port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    r.on("error", reject);
    r.end(init.body);
  });
}

describe.skipIf(!hasGo)("e2e: SDK ↔ Gateway", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ml-e2e-"));
    const bin = join(tmp, "gateway");
    execFileSync("go", ["build", "-o", bin, "./cmd/gateway"], { cwd: gwDir });
    execFileSync("go", ["run", "./cmd/devtoken", "-gen-keys", "-out", join(tmp, "keys")], { cwd: gwDir });
    token = () =>
      execFileSync("go", ["run", "./cmd/devtoken", "-key", join(tmp, "keys/ed25519.key"), "-sub", "usr_e2e", "-subdomains", "e2eapp"], {
        cwd: gwDir,
      }).toString().trim();

    gw = spawn(bin, [], {
      env: {
        ...process.env,
        ML_ENV: "test",
        ML_LISTEN_ADDR: `127.0.0.1:${port}`,
        ML_ADMIN_ADDR: `127.0.0.1:${port + 1}`,
        ML_PUBLIC_PORT: String(port),
        ML_REDIS_URL: "",
        ML_JWT_PUBLIC_KEYS: join(tmp, "keys/ed25519.pub"),
        ML_MAX_BODY_BYTES: "1024",
        ML_LOG_LEVEL: "error",
      },
      stdio: "ignore",
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port + 1}/health`)).ok);

    app = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.writeHead(req.url?.startsWith("/teapot") ? 418 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, xfh: req.headers["x-forwarded-host"], body }));
      });
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    gw?.kill("SIGTERM");
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
  });

  it("forwards exact status, headers and body through the tunnel", async () => {
    const t = new Tunnel({ gatewayUrl: `ws://127.0.0.1:${port}/tunnel`, token: token(), target: appUrl });
    const info = await t.connect();
    expect(info.url).toBe(`http://${info.subdomain}.localtest.me:${port}`);

    const res = await publicGet(info.subdomain, "/teapot?x=1", { method: "POST", body: "hi" });
    expect(res.status).toBe(418);
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    const echoed = JSON.parse(res.body);
    expect(echoed).toMatchObject({ method: "POST", url: "/teapot?x=1", body: "hi", host: new URL(appUrl).host });
    expect(echoed.xfh).toBe(`${info.subdomain}.localtest.me:${port}`);

    await t.close();
    const gone = await publicGet(info.subdomain, "/");
    expect(gone.status).toBe(404);
  });

  it("reserved subdomain from the token works; a second claim is refused", async () => {
    const t = new Tunnel({ gatewayUrl: `ws://127.0.0.1:${port}/tunnel`, token: token(), target: appUrl, subdomain: "e2eapp" });
    expect((await t.connect()).subdomain).toBe("e2eapp");
    const t2 = new Tunnel({ gatewayUrl: `ws://127.0.0.1:${port}/tunnel`, token: token(), target: appUrl, subdomain: "e2eapp", reconnect: false });
    await expect(t2.connect()).rejects.toMatchObject({ code: "SUBDOMAIN_TAKEN" });
    await t.close();
  });

  it("local app down → public 502; oversized body → 413", async () => {
    const t = new Tunnel({ gatewayUrl: `ws://127.0.0.1:${port}/tunnel`, token: token(), target: "http://127.0.0.1:1" });
    const { subdomain } = await t.connect();
    expect((await publicGet(subdomain, "/")).status).toBe(502);
    expect((await publicGet(subdomain, "/", { method: "POST", body: "x".repeat(2048) })).status).toBe(413);
    await t.close();
  });

  it("invalid token → AUTH_FAILED", async () => {
    const t = new Tunnel({ gatewayUrl: `ws://127.0.0.1:${port}/tunnel`, token: "a.b.c", target: appUrl });
    await expect(t.connect()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});
