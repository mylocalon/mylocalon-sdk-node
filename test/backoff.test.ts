import { describe, expect, it } from "vitest";
import { Backoff } from "../src/reconnect.js";

describe("Backoff", () => {
  it("grows exponentially to the 8s cap with equal jitter", () => {
    const min = new Backoff({ random: () => 0 });
    const max = new Backoff({ random: () => 0.999999 });
    const lo = Array.from({ length: 7 }, () => min.next());
    const hi = Array.from({ length: 7 }, () => max.next());
    expect(lo).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000]);
    expect(hi).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("reset starts over", () => {
    const b = new Backoff({ random: () => 0 });
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(250);
  });
});
