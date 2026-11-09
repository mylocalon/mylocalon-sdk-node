/** Raised for malformed or unknown protocol messages (PROTOCOL_ERROR). */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** Raised when the Gateway refuses or terminates the tunnel. */
export class GatewayError extends Error {
  override name = "GatewayError";
  constructor(
    readonly code: string,
    message: string,
    readonly reconnect: boolean,
  ) {
    super(`${code}: ${message}`);
  }
}
