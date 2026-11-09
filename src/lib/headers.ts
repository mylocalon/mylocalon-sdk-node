const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

/** Hop-by-hop headers, including any named by Connection, must not be forwarded. */
export function stripHopByHop(headers: [string, string][]): [string, string][] {
  const extra = new Set<string>();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === "connection") {
      for (const t of v.split(",")) extra.add(t.trim().toLowerCase());
    }
  }
  return headers.filter(([k]) => {
    const n = k.toLowerCase();
    return !HOP_BY_HOP.has(n) && !extra.has(n);
  });
}
