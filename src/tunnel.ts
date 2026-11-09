import { EventEmitter } from "node:events";
import os from "node:os";
import { connectWs, type ConnectFn, type Connection } from "./connection.js";
import { HttpForwarder, type LocalForwarder } from "./forwarder.js";
import { GatewayError } from "./lib/errors.js";
import { silentLogger, type Logger } from "./lib/logger.js";
import type { ErrorMsg, GoAwayMsg, HelloMsg, HttpRequestMsg, ServerMessage, WelcomeMsg } from "./protocol/messages.js";
import { PROTOCOL_VERSION } from "./protocol/version.js";
import { Backoff, type BackoffOptions } from "./reconnect.js";
import { StateMachine, type TunnelState } from "./state.js";

export const SDK_VERSION = "0.1.0";

export interface TunnelOptions {
  /** e.g. wss://gateway.mylocalon.com/tunnel */
  gatewayUrl: string;
  /** A Gateway JWT. Provide this or `tokenProvider`. */
  token?: string;
  /**
   * Called before every HELLO so long-running processes can refresh JWTs.
   * Throw an error with `fatal: true` to stop reconnecting (e.g. revoked key).
   */
  tokenProvider?: () => Promise<string>;
  /** Local origin to expose, e.g. http://localhost:3000 */
  target: string;
  /** Request a reserved subdomain (must be owned by the token's user). */
  subdomain?: string;
  /** Auto-reconnect with resume after drops. Default true. */
  reconnect?: boolean;
  /** Max concurrent requests forwarded to the local app. Default 32. */
  maxConcurrency?: number;
  /** Per-request timeout against the local app. Default 30s. */
  requestTimeoutMs?: number;
  /** Identifies the embedding client in HELLO (the CLI sets its own). */
  client?: { name: string; version: string };
  logger?: Logger;
  backoff?: BackoffOptions;
  /** Test seams. */
  connect?: ConnectFn;
  forwarder?: LocalForwarder;
}

export interface TunnelInfo {
  tunnelId: string;
  subdomain: string;
  url: string;
}

export interface RequestEvent {
  reqId: string;
  method: string;
  path: string;
  status?: number;
  errorCode?: string;
  durationMs: number;
}

export interface ClosedEvent {
  reason: string;
  error?: GatewayError | Error;
}

const HELLO_TIMEOUT_MS = 10_000;
const DRAIN_MS = 2_000;
/** Codes where retrying cannot help, regardless of GOAWAY.reconnect. */
const FATAL = new Set(["VERSION_UNSUPPORTED", "AUTH_REVOKED", "SUBDOMAIN_FORBIDDEN", "TUNNEL_LIMIT"]);

/**
 * A single tunnel: one WSS connection to the Gateway forwarding public HTTP
 * requests to `target`.
 *
 * Events: `active` (TunnelInfo), `request` (RequestEvent), `disconnected`,
 * `reconnecting` (attempt), `closed` (ClosedEvent), `state` ({from,to}),
 * `error` (Error — only emitted when a listener is attached).
 */
export class Tunnel extends EventEmitter {
  readonly #opts: TunnelOptions;
  readonly #sm: StateMachine;
  readonly #connectFn: ConnectFn;
  readonly #forwarder: LocalForwarder;
  readonly #backoff: Backoff;
  readonly #log: Logger;
  readonly #maxConcurrency: number;

  #conn: Connection | undefined;
  #welcome: WelcomeMsg | undefined;
  #resume: { tunnelId: string; resumeToken: string } | undefined;
  #goaway: GoAwayMsg | undefined;
  #first: { resolve: (i: TunnelInfo) => void; reject: (e: Error) => void } | undefined;
  #watchdog: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #closing = false;
  #authFailures = 0;
  #inflight = 0;
  readonly #queue: (() => void)[] = [];

  constructor(opts: TunnelOptions) {
    super();
    if (!opts.token && !opts.tokenProvider) throw new TypeError("token or tokenProvider is required");
    this.#opts = opts;
    this.#forwarder = opts.forwarder ?? new HttpForwarder(opts.target, { timeoutMs: opts.requestTimeoutMs ?? 30_000 });
    this.#connectFn = opts.connect ?? connectWs;
    this.#backoff = new Backoff(opts.backoff);
    this.#log = opts.logger ?? silentLogger;
    this.#maxConcurrency = opts.maxConcurrency ?? 32;
    this.#sm = new StateMachine((from, to) => {
      this.#log.debug({ from, to }, "tunnel_state");
      this.emit("state", { from, to });
    });
  }

  get state(): TunnelState {
    return this.#sm.state;
  }
  get url(): string | undefined {
    return this.#welcome?.url;
  }
  get subdomain(): string | undefined {
    return this.#welcome?.subdomain;
  }
  get tunnelId(): string | undefined {
    return this.#welcome?.tunnelId;
  }

  /** Connects and resolves on the first WELCOME (state ACTIVE). */
  connect(): Promise<TunnelInfo> {
    if (this.state !== "CREATED") return Promise.reject(new Error(`connect() called in state ${this.state}`));
    this.#sm.to("CONNECTING");
    return new Promise((resolve, reject) => {
      this.#first = { resolve, reject };
      void this.#dial();
    });
  }

  /** Graceful shutdown: stop accepting, drain briefly, send CLOSE. */
  async close(): Promise<void> {
    if (this.state === "CLOSED" || this.#closing) return;
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#watchdog);
    const deadline = Date.now() + DRAIN_MS;
    while (this.#inflight > 0 && Date.now() < deadline) await sleep(25);
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn) {
      conn.send({ type: "CLOSE", ...(this.tunnelId ? { tunnelId: this.tunnelId } : {}) });
      await conn.close();
    }
    this.#finish({ reason: "client_close" });
  }

  // ------------------------------------------------------------- internals

  async #dial(): Promise<void> {
    let conn: Connection;
    let token: string;
    try {
      token = this.#opts.tokenProvider ? await this.#opts.tokenProvider() : this.#opts.token!;
      conn = await this.#connectFn(this.#opts.gatewayUrl);
    } catch (e) {
      this.#onDialFailure(e as Error);
      return;
    }
    if (this.#closing) {
      await conn.close();
      return;
    }
    this.#conn = conn;
    conn.onMessage((m) => this.#onMessage(conn, m));
    conn.onProtocolError((e) => {
      this.#log.warn({ err: e.message }, "protocol_error");
      conn.send({ type: "ERROR", code: "PROTOCOL_ERROR", message: e.message });
    });
    conn.onClose((code, reason) => this.#onClose(conn, code, reason));

    const hello: HelloMsg = {
      type: "HELLO",
      protocol: PROTOCOL_VERSION,
      token,
      client: {
        ...(this.#opts.client ?? { name: "mylocalon-sdk-node", version: SDK_VERSION }),
        os: os.platform(),
      },
      // Always include `tunnel` so a failed resume falls back to a fresh tunnel.
      tunnel: {
        ...(this.#opts.subdomain ? { subdomain: this.#opts.subdomain } : {}),
        targetHint: this.#opts.target,
      },
      ...(this.#resume ? { resume: this.#resume } : {}),
    };
    conn.send(hello);
    this.#arm(conn, HELLO_TIMEOUT_MS);
  }

  #onMessage(conn: Connection, m: ServerMessage): void {
    if (conn !== this.#conn) return; // stale socket
    if (this.#welcome) this.#arm(conn, this.#welcome.heartbeat.timeoutMs);

    switch (m.type) {
      case "WELCOME": {
        const prev = this.#welcome;
        this.#welcome = m;
        this.#resume = { tunnelId: m.tunnelId, resumeToken: m.resumeToken };
        this.#backoff.reset();
        this.#authFailures = 0;
        this.#arm(conn, m.heartbeat.timeoutMs);
        this.#sm.to("ACTIVE");
        const info = { tunnelId: m.tunnelId, subdomain: m.subdomain, url: m.url };
        if (prev && prev.url !== m.url) this.#log.warn({ from: prev.url, to: m.url }, "tunnel_url_changed");
        this.#log.info(info, "tunnel_active");
        this.emit("active", info);
        this.#first?.resolve(info);
        this.#first = undefined;
        break;
      }
      case "PING":
        conn.send({ type: "PONG", ts: m.ts });
        break;
      case "PONG":
        break;
      case "HTTP_REQUEST":
        this.#enqueue(conn, m);
        break;
      case "ERROR":
        this.#log.warn({ code: m.code, message: m.message }, "gateway_error");
        this.#emitError(new GatewayError(m.code, m.message, true));
        break;
      case "GOAWAY":
        this.#goaway = m;
        this.#log.info({ code: m.code, message: m.message, reconnect: m.reconnect }, "goaway");
        if (m.code === "RESUME_EXPIRED") this.#resume = undefined;
        break;
    }
  }

  #onClose(conn: Connection, code: number, reason: string): void {
    if (conn !== this.#conn) return;
    this.#conn = undefined;
    clearTimeout(this.#watchdog);
    if (this.#closing) return;

    const ga = this.#goaway;
    this.#goaway = undefined;
    const err = ga ? new GatewayError(ga.code, ga.message, ga.reconnect) : new Error(`connection closed (${code} ${reason})`);

    if (this.#first) {
      // Never reached ACTIVE: surface the failure to connect() rather than retrying.
      this.#first.reject(err);
      this.#first = undefined;
      this.#finish({ reason: ga?.code ?? "connect_failed", error: err });
      return;
    }

    if (this.state === "ACTIVE") {
      this.#sm.to("DISCONNECTED");
      this.#log.warn({ code, reason, goaway: ga?.code }, "tunnel_disconnected");
      this.emit("disconnected", { code, reason, ...(ga ? { goaway: ga.code } : {}) });
    } else if (this.state === "RECONNECTING") {
      this.#sm.to("DISCONNECTED");
    }

    if (!this.#shouldRetry(ga)) {
      this.#finish({ reason: ga?.code ?? "disconnected", error: err });
      return;
    }
    this.#scheduleReconnect(ga?.code === "RESUME_EXPIRED" ? 0 : undefined);
  }

  #shouldRetry(ga: GoAwayMsg | undefined): boolean {
    if (this.#opts.reconnect === false) return false;
    if (!ga) return true;
    if (FATAL.has(ga.code)) return false;
    if (ga.code === "AUTH_FAILED") {
      // A refreshed token may fix it — but only once in a row.
      return Boolean(this.#opts.tokenProvider) && ++this.#authFailures <= 1;
    }
    return ga.reconnect || ga.code === "RESUME_EXPIRED" || ga.code === "SUBDOMAIN_TAKEN";
  }

  #onDialFailure(e: Error): void {
    this.#log.warn({ err: e.message }, "dial_failed");
    if ((e as { fatal?: boolean }).fatal && !this.#first) {
      // e.g. the API key was revoked: retrying cannot help.
      this.#finish({ reason: "auth_failed", error: e });
      return;
    }
    if (this.#first) {
      this.#first.reject(e);
      this.#first = undefined;
      this.#finish({ reason: "connect_failed", error: e });
      return;
    }
    if (this.#closing) return;
    if (this.state === "RECONNECTING") this.#sm.to("DISCONNECTED");
    if (this.#opts.reconnect === false) {
      this.#finish({ reason: "disconnected", error: e });
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(delayMs?: number): void {
    const delay = delayMs ?? this.#backoff.next();
    this.#log.info({ delayMs: delay, attempt: this.#backoff.attempt }, "reconnect_scheduled");
    this.#reconnectTimer = setTimeout(() => {
      if (this.#closing) return;
      this.#sm.to("RECONNECTING");
      this.emit("reconnecting", this.#backoff.attempt);
      void this.#dial();
    }, delay);
  }

  /** Heartbeat watchdog: if the Gateway goes silent, treat the socket as dead. */
  #arm(conn: Connection, ms: number): void {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      this.#log.warn({ timeoutMs: ms }, "heartbeat_timeout");
      void conn.close();
    }, ms);
  }

  #enqueue(conn: Connection, req: HttpRequestMsg): void {
    const run = () => void this.#handle(conn, req);
    if (this.#inflight < this.#maxConcurrency) run();
    else this.#queue.push(run);
  }

  async #handle(conn: Connection, req: HttpRequestMsg): Promise<void> {
    this.#inflight++;
    const started = Date.now();
    let res;
    try {
      res = this.#closing
        ? errorFor(req, "UPSTREAM_UNREACHABLE", "tunnel is closing")
        : await this.#forwarder.forward(req, { maxBodyBytes: this.#welcome?.limits.maxBodyBytes ?? Infinity });
    } catch (e) {
      res = errorFor(req, "UPSTREAM_UNREACHABLE", (e as Error).message);
    } finally {
      this.#inflight--;
      this.#queue.shift()?.();
    }
    // Reply on the socket that carried the request; reqIds are per-connection.
    conn.send(res);
    const evt: RequestEvent = {
      reqId: req.reqId,
      method: req.method,
      path: req.path,
      durationMs: Date.now() - started,
      ...(res.type === "HTTP_RESPONSE" ? { status: res.status } : { errorCode: res.code }),
    };
    this.#log.info({ ...evt }, "http_forwarded");
    this.emit("request", evt);
  }

  #finish(evt: ClosedEvent): void {
    if (this.state === "CLOSED") return;
    clearTimeout(this.#watchdog);
    clearTimeout(this.#reconnectTimer);
    this.#sm.to("CLOSED");
    this.emit("closed", evt);
  }

  #emitError(e: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", e);
  }
}

function errorFor(req: HttpRequestMsg, code: ErrorMsg["code"], message: string): ErrorMsg {
  return { type: "ERROR", reqId: req.reqId, code, message, retryable: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
