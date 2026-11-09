import http from "node:http";
import https from "node:https";
import { decodeBody, encodeBody } from "./protocol/codec.js";
import type { ErrorMsg, Header, HttpRequestMsg, HttpResponseMsg } from "./protocol/messages.js";
import { stripHopByHop } from "./lib/headers.js";

/** Turns an HTTP_REQUEST into a call against the local app (SDK-NODE.md §6). */
export interface LocalForwarder {
  forward(req: HttpRequestMsg, opts?: { maxBodyBytes?: number }): Promise<HttpResponseMsg | ErrorMsg>;
}

export interface HttpForwarderOptions {
  /** Per-request timeout; exceeded → UPSTREAM_TIMEOUT (public 504). Default 30s. */
  timeoutMs?: number;
  /** Rewrite Host to the target's host (most dev servers require it). Default true. */
  rewriteHost?: boolean;
}

/**
 * Forwards over raw node:http rather than fetch: fetch transparently
 * decompresses bodies and forbids setting Host, which would break the
 * "exact bytes, headers and status" guarantee.
 */
export class HttpForwarder implements LocalForwarder {
  readonly #target: URL;
  readonly #timeoutMs: number;
  readonly #rewriteHost: boolean;

  constructor(target: string, opts: HttpForwarderOptions = {}) {
    this.#target = validateTarget(target);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#rewriteHost = opts.rewriteHost ?? true;
  }

  get target(): string {
    return this.#target.origin;
  }

  forward(req: HttpRequestMsg, opts: { maxBodyBytes?: number } = {}): Promise<HttpResponseMsg | ErrorMsg> {
    const started = Date.now();
    const body = decodeBody(req.bodyB64);
    const headers = buildHeaders(req.headers, this.#rewriteHost ? this.#target.host : undefined, body.length);
    const isHttps = this.#target.protocol === "https:";
    const lib = isHttps ? https : http;
    const max = opts.maxBodyBytes ?? Infinity;

    return new Promise((resolve) => {
      let settled = false;
      const done = (m: HttpResponseMsg | ErrorMsg) => {
        if (!settled) {
          settled = true;
          resolve(m);
        }
      };
      const fail = (code: ErrorMsg["code"], message: string): void =>
        done({ type: "ERROR", reqId: req.reqId, code, message, retryable: code !== "BODY_TOO_LARGE" });

      const r = lib.request(
        {
          protocol: this.#target.protocol,
          hostname: this.#target.hostname,
          port: this.#target.port || (isHttps ? 443 : 80),
          method: req.method,
          // path is sent verbatim (path + raw query); never re-parsed as a URL.
          path: req.path.startsWith("/") ? req.path : `/${req.path}`,
          headers,
          // Local dev certs are usually self-signed.
          ...(isHttps ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > max) {
              res.destroy();
              fail("BODY_TOO_LARGE", `response body exceeds ${max} bytes`);
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            done({
              type: "HTTP_RESPONSE",
              reqId: req.reqId,
              status: res.statusCode ?? 502,
              headers: responseHeaders(res.rawHeaders),
              bodyB64: encodeBody(Buffer.concat(chunks)),
              durationMs: Date.now() - started,
            });
          });
          res.on("error", (e) => fail("UPSTREAM_UNREACHABLE", e.message));
        },
      );
      r.setTimeout(this.#timeoutMs, () => {
        r.destroy();
        fail("UPSTREAM_TIMEOUT", `local app did not respond within ${this.#timeoutMs}ms`);
      });
      r.on("error", (e: NodeJS.ErrnoException) => {
        fail("UPSTREAM_UNREACHABLE", e.code ? `${e.code}: ${e.message}` : e.message);
      });
      r.end(body);
    });
  }
}

export function validateTarget(target: string): URL {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new TypeError(`invalid target URL: ${target}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TypeError(`target must be http(s), got ${u.protocol}`);
  }
  if (u.pathname !== "/" || u.search || u.hash) {
    throw new TypeError("target must be an origin, e.g. http://localhost:3000");
  }
  return u;
}

function buildHeaders(pairs: Header[], host: string | undefined, bodyLen: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of stripHopByHop(pairs)) {
    const n = k.toLowerCase();
    if (n === "content-length" || (host && n === "host")) continue;
    const cur = out[n];
    out[n] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  if (host) out["host"] = host;
  if (bodyLen > 0) out["content-length"] = String(bodyLen);
  return out;
}

/** rawHeaders is a flat [k, v, k, v] list preserving order and duplicates. */
function responseHeaders(raw: string[]): Header[] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!.toLowerCase(), raw[i + 1]!]);
  return stripHopByHop(pairs).filter(([k]) => k !== "content-length");
}
