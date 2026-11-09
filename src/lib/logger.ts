/** Minimal structured logger seam; embedders can pass pino/console/etc. */
export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const noop = () => {};
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
