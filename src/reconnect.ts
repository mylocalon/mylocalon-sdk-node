export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  /** Injected RNG in [0,1) for deterministic tests. */
  random?: () => number;
}

/**
 * Jittered exponential backoff: 0.5s → 8s cap (PROTOCOL §10). "Equal jitter":
 * half the step is fixed, half random, so retries never collapse to 0.
 */
export class Backoff {
  #attempt = 0;
  readonly #initial: number;
  readonly #max: number;
  readonly #random: () => number;

  constructor(opts: BackoffOptions = {}) {
    this.#initial = opts.initialMs ?? 500;
    this.#max = opts.maxMs ?? 8000;
    this.#random = opts.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  next(): number {
    const step = Math.min(this.#max, this.#initial * 2 ** this.#attempt);
    this.#attempt++;
    return Math.round(step / 2 + this.#random() * (step / 2));
  }

  reset(): void {
    this.#attempt = 0;
  }
}
