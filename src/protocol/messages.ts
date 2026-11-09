/** Typed messages for the mylocalon Tunnel Protocol v1 (docs/PROTOCOL.md §5–9). */

/** A header as a [name, value] pair; preserves order and duplicates. */
export type Header = [name: string, value: string];

export interface HelloMsg {
  type: "HELLO";
  protocol: number;
  token: string;
  client: { name: string; version: string; os?: string };
  tunnel?: { subdomain?: string; targetHint?: string };
  resume?: { tunnelId: string; resumeToken: string };
}

export interface WelcomeMsg {
  type: "WELCOME";
  tunnelId: string;
  subdomain: string;
  url: string;
  resumeToken: string;
  heartbeat: { intervalMs: number; timeoutMs: number };
  limits: { maxBodyBytes: number };
}

export interface PingMsg {
  type: "PING";
  ts: number;
}

export interface PongMsg {
  type: "PONG";
  ts: number;
}

export interface HttpRequestMsg {
  type: "HTTP_REQUEST";
  reqId: string;
  method: string;
  path: string;
  headers: Header[];
  bodyB64: string;
  bodyTruncated?: boolean;
  remoteIp?: string;
  receivedAt?: number;
}

export interface HttpResponseMsg {
  type: "HTTP_RESPONSE";
  reqId: string;
  status: number;
  headers: Header[];
  bodyB64: string;
  durationMs?: number;
}

export type ErrorCode =
  | "VERSION_UNSUPPORTED"
  | "AUTH_FAILED"
  | "AUTH_REVOKED"
  | "SUBDOMAIN_FORBIDDEN"
  | "SUBDOMAIN_TAKEN"
  | "TUNNEL_LIMIT"
  | "RATE_LIMITED"
  | "RESUME_EXPIRED"
  | "PROTOCOL_ERROR"
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_TIMEOUT"
  | "BODY_TOO_LARGE"
  | "INTERNAL"
  | "SHUTDOWN";

export interface ErrorMsg {
  type: "ERROR";
  reqId?: string;
  code: ErrorCode | (string & {});
  message: string;
  retryable?: boolean;
}

export interface GoAwayMsg {
  type: "GOAWAY";
  code: ErrorCode | (string & {});
  message: string;
  reconnect: boolean;
}

export interface CloseMsg {
  type: "CLOSE";
  tunnelId?: string;
}

/** Messages a client sends. */
export type ClientMessage = HelloMsg | PingMsg | PongMsg | HttpResponseMsg | ErrorMsg | CloseMsg;
/** Messages a client receives. */
export type ServerMessage = WelcomeMsg | PingMsg | PongMsg | HttpRequestMsg | ErrorMsg | GoAwayMsg;
export type Message = ClientMessage | ServerMessage;
