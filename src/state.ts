/** Client-side tunnel states (PROTOCOL.md §11). */
export type TunnelState = "CREATED" | "CONNECTING" | "ACTIVE" | "DISCONNECTED" | "RECONNECTING" | "CLOSED";

const ALLOWED: Record<TunnelState, readonly TunnelState[]> = {
  CREATED: ["CONNECTING", "CLOSED"],
  CONNECTING: ["ACTIVE", "CLOSED"],
  ACTIVE: ["DISCONNECTED", "CLOSED"],
  DISCONNECTED: ["RECONNECTING", "CLOSED"],
  RECONNECTING: ["ACTIVE", "DISCONNECTED", "CLOSED"],
  CLOSED: [],
};

export class StateMachine {
  #state: TunnelState = "CREATED";

  constructor(private readonly onChange: (from: TunnelState, to: TunnelState) => void = () => {}) {}

  get state(): TunnelState {
    return this.#state;
  }

  /** Move to `to`; throws on an illegal transition (a bug, not a runtime condition). */
  to(to: TunnelState): void {
    const from = this.#state;
    if (from === to) return;
    if (!ALLOWED[from].includes(to)) throw new Error(`illegal tunnel transition ${from} → ${to}`);
    this.#state = to;
    this.onChange(from, to);
  }
}
