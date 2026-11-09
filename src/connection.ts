import WebSocket from "ws";
import { decode, encode } from "./protocol/codec.js";
import type { ClientMessage, ServerMessage } from "./protocol/messages.js";
import { SUBPROTOCOL } from "./protocol/version.js";

/** Transport seam (SDK-NODE.md §6): the real one wraps `ws`; tests use a fake. */
export interface Connection {
  send(msg: ClientMessage): void;
  onMessage(cb: (m: ServerMessage) => void): void;
  /** Called for frames that fail to decode. */
  onProtocolError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  close(): Promise<void>;
}

export type ConnectFn = (url: string) => Promise<Connection>;

const DIAL_TIMEOUT_MS = 10_000;

/** Dial the Gateway over WSS with the mylocalon.v1 subprotocol. */
export const connectWs: ConnectFn = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [SUBPROTOCOL], { handshakeTimeout: DIAL_TIMEOUT_MS, maxPayload: 64 << 20 });
    const onError = (e: Error) => reject(e);
    ws.once("error", onError);
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`gateway refused upgrade: HTTP ${res.statusCode}`));
      ws.terminate();
    });
    ws.once("open", () => {
      ws.off("error", onError);
      if (ws.protocol !== SUBPROTOCOL) {
        ws.terminate();
        reject(new Error(`gateway did not accept subprotocol ${SUBPROTOCOL}`));
        return;
      }
      resolve(new WsConnection(ws));
    });
  });

class WsConnection implements Connection {
  readonly #closed: Promise<void>;
  readonly #onMsg: ((m: ServerMessage) => void)[] = [];
  readonly #onErr: ((e: Error) => void)[] = [];

  constructor(private readonly ws: WebSocket) {
    this.#closed = new Promise((r) => ws.once("close", () => r()));
    // Errors surface as a subsequent "close"; swallow to avoid unhandled events.
    ws.on("error", () => {});
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Reserved for the v1.x binary body mode.
        for (const cb of this.#onErr) cb(new Error("binary frames are not allowed in v1"));
        return;
      }
      let m: ServerMessage;
      try {
        m = decode(data.toString()) as ServerMessage;
      } catch (e) {
        for (const cb of this.#onErr) cb(e as Error);
        return;
      }
      for (const cb of this.#onMsg) cb(m);
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  onMessage(cb: (m: ServerMessage) => void): void {
    this.#onMsg.push(cb);
  }

  onProtocolError(cb: (err: Error) => void): void {
    this.#onErr.push(cb);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.ws.on("close", (code, reason) => cb(code, reason.toString()));
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.ws.close(1000);
    const t = setTimeout(() => this.ws.terminate(), 2000);
    return this.#closed.finally(() => clearTimeout(t));
  }
}
