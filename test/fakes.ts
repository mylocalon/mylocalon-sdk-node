import type { Connection, ConnectFn } from "../src/connection.js";
import type { LocalForwarder } from "../src/forwarder.js";
import type { ClientMessage, ErrorMsg, HttpRequestMsg, HttpResponseMsg, ServerMessage, WelcomeMsg } from "../src/protocol/messages.js";

export class FakeConnection implements Connection {
  sent: ClientMessage[] = [];
  closed = false;
  #onMsg: ((m: ServerMessage) => void)[] = [];
  #onClose: ((c: number, r: string) => void)[] = [];

  send(m: ClientMessage): void {
    if (!this.closed) this.sent.push(m);
  }
  onMessage(cb: (m: ServerMessage) => void): void {
    this.#onMsg.push(cb);
  }
  onProtocolError(): void {}
  onClose(cb: (c: number, r: string) => void): void {
    this.#onClose.push(cb);
  }
  async close(): Promise<void> {
    this.drop(1000, "client");
  }

  // ---- gateway side
  deliver(m: ServerMessage): void {
    for (const cb of this.#onMsg) cb(m);
  }
  drop(code = 1006, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.#onClose) cb(code, reason);
  }
  last<T extends ClientMessage["type"]>(type: T): Extract<ClientMessage, { type: T }> | undefined {
    return this.sent.filter((m) => m.type === type).at(-1) as Extract<ClientMessage, { type: T }> | undefined;
  }
}

export class FakeGateway {
  conns: FakeConnection[] = [];
  failNext = 0;
  #waiters: ((c: FakeConnection) => void)[] = [];

  connect: ConnectFn = async () => {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("ECONNREFUSED");
    }
    const c = new FakeConnection();
    this.conns.push(c);
    this.#waiters.shift()?.(c);
    return c;
  };

  /** Resolves with the next connection (or the latest if already open). */
  nextConn(after = this.conns.length): Promise<FakeConnection> {
    if (this.conns.length > after) return Promise.resolve(this.conns[after]!);
    return new Promise((r) => this.#waiters.push(r));
  }
}

export const welcome = (over: Partial<WelcomeMsg> = {}): WelcomeMsg => ({
  type: "WELCOME",
  tunnelId: "tnl_1",
  subdomain: "abc123",
  url: "https://abc123.mylocalon.com",
  resumeToken: "rsm_1",
  heartbeat: { intervalMs: 15000, timeoutMs: 45000 },
  limits: { maxBodyBytes: 1024 },
  ...over,
});

export class EchoForwarder implements LocalForwarder {
  calls: HttpRequestMsg[] = [];
  async forward(req: HttpRequestMsg): Promise<HttpResponseMsg | ErrorMsg> {
    this.calls.push(req);
    return { type: "HTTP_RESPONSE", reqId: req.reqId, status: 200, headers: [], bodyB64: "T0s=" };
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
