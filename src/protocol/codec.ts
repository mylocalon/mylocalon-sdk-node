import { ProtocolError } from "../lib/errors.js";
import type { Header, Message } from "./messages.js";

const KNOWN = new Set([
  "HELLO", "WELCOME", "PING", "PONG", "HTTP_REQUEST", "HTTP_RESPONSE", "ERROR", "GOAWAY", "CLOSE",
]);

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encode(msg: Message): string {
  return JSON.stringify(msg);
}

/**
 * Parse one text frame. Unknown fields are kept but ignored (PROTOCOL §3);
 * unknown types and malformed messages throw ProtocolError.
 */
export function decode(data: string): Message {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (e) {
    throw new ProtocolError(`invalid json: ${(e as Error).message}`);
  }
  if (!isObj(raw)) throw new ProtocolError("message must be a JSON object");
  const type = raw["type"];
  if (typeof type !== "string" || type === "") throw new ProtocolError("missing type");
  if (!KNOWN.has(type)) throw new ProtocolError(`unknown type "${type}"`);

  switch (type) {
    case "HELLO":
      req(raw, "protocol", "number");
      req(raw, "token", "string");
      if (raw["resume"] !== undefined) {
        const r = raw["resume"];
        if (!isObj(r) || typeof r["tunnelId"] !== "string" || typeof r["resumeToken"] !== "string") {
          throw new ProtocolError("HELLO.resume requires tunnelId and resumeToken");
        }
      }
      break;
    case "WELCOME":
      for (const f of ["tunnelId", "subdomain", "url", "resumeToken"]) req(raw, f, "string");
      if (!isObj(raw["heartbeat"]) || !isObj(raw["limits"])) {
        throw new ProtocolError("WELCOME requires heartbeat and limits");
      }
      break;
    case "PING":
    case "PONG":
      req(raw, "ts", "number");
      break;
    case "HTTP_REQUEST":
      for (const f of ["reqId", "method", "path", "bodyB64"]) req(raw, f, "string");
      headers(raw["headers"]);
      body(raw["bodyB64"] as string);
      break;
    case "HTTP_RESPONSE": {
      req(raw, "reqId", "string");
      req(raw, "status", "number");
      req(raw, "bodyB64", "string");
      const s = raw["status"] as number;
      if (!Number.isInteger(s) || s < 100 || s > 999) throw new ProtocolError(`status out of range: ${s}`);
      headers(raw["headers"]);
      body(raw["bodyB64"] as string);
      break;
    }
    case "ERROR":
    case "GOAWAY":
      req(raw, "code", "string");
      break;
  }
  return raw as unknown as Message;
}

export function encodeBody(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64");
}

/** Strict standard padded base64; "" decodes to an empty buffer. */
export function decodeBody(b64: string): Buffer {
  body(b64);
  return Buffer.from(b64, "base64");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function req(o: Record<string, unknown>, field: string, t: "string" | "number"): void {
  if (typeof o[field] !== t) throw new ProtocolError(`${String(o["type"])}.${field} must be a ${t}`);
}

function headers(v: unknown): asserts v is Header[] {
  if (!Array.isArray(v)) throw new ProtocolError("headers must be an array of [name, value] pairs");
  for (const h of v) {
    if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== "string" || typeof h[1] !== "string") {
      throw new ProtocolError("header must be [name, value]");
    }
  }
}

function body(b64: string): void {
  if (b64 !== "" && (b64.length % 4 !== 0 || !B64.test(b64))) {
    throw new ProtocolError("invalid base64 body");
  }
}
