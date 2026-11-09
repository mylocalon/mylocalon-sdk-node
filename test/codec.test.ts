import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, decodeBody, encode, encodeBody } from "../src/protocol/codec.js";
import { ProtocolError } from "../src/lib/errors.js";

// Shared, language-neutral fixtures (TESTING.md §2) — the Go Gateway runs the same set.
const dir = join(import.meta.dirname, "../../docs/fixtures");
const valid = readdirSync(dir).filter((f) => f.endsWith(".json"));
const invalid = readdirSync(join(dir, "invalid")).filter((f) => f.endsWith(".json"));

describe("protocol fixtures", () => {
  it("found fixtures", () => {
    expect(valid.length).toBeGreaterThan(5);
    expect(invalid.length).toBeGreaterThan(3);
  });

  it.each(valid)("round-trips %s", (f) => {
    const raw = readFileSync(join(dir, f), "utf8");
    const msg = decode(raw);
    expect(JSON.parse(encode(msg))).toEqual(JSON.parse(raw));
  });

  it.each(invalid)("rejects invalid/%s", (f) => {
    const raw = readFileSync(join(dir, "invalid", f), "utf8");
    expect(() => decode(raw)).toThrow(ProtocolError);
  });
});

describe("body base64", () => {
  it("round-trips binary", () => {
    const buf = Buffer.from([0, 1, 2, 250, 255]);
    expect(decodeBody(encodeBody(buf))).toEqual(buf);
  });
  it("requires padding", () => {
    expect(decodeBody("T0s=").toString()).toBe("OK");
    expect(() => decodeBody("T0s")).toThrow(ProtocolError);
  });
  it("empty is empty", () => {
    expect(decodeBody("").length).toBe(0);
  });
});
