// Input ceilings — the self-DoS guard at the data boundary. A runaway upstream (a fetch that
// returns millions of rows) should be rejected cheaply, before it is handed to a renderer that
// would burn memory and the worker-timeout budget. Configurable; the defaults are the v0.2 fence.

export interface Limits {
  maxRows: number;
  maxBytes: number;
  maxDurationMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRows: 50_000,
  maxBytes: 100 * 1024 * 1024, // 100 MB
  maxDurationMs: 5 * 60 * 1000, // 5 min (mirrors the coordinator's per-execution budget)
};

/** Input exceeded a configured ceiling. Stable UPPER_SNAKE code for runs/logs/APIs. */
export class InputTooLargeError extends Error {
  readonly code = "INPUT_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "InputTooLargeError";
  }
}

/**
 * A cheap, shape-agnostic row proxy: the longest top-level array in the data. Covers both the
 * `{ orders: [...] }` fetch shape and the `{ rows: [...] }` render-model shape without knowing
 * either. Good enough to catch "absurdly large input"; not a semantic row count.
 */
export function largestArrayLength(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    let max = 0;
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length > max) max = v.length;
    }
    return max;
  }
  return 0;
}

/** Reject input that breaches the byte or row ceiling. Throws InputTooLargeError. */
export function enforceInputLimits(data: unknown, limits: Limits = DEFAULT_LIMITS): void {
  const serialized = typeof data === "string" ? data : JSON.stringify(data ?? null);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.maxBytes) {
    throw new InputTooLargeError(`input ${bytes} bytes exceeds maxBytes ${limits.maxBytes}`);
  }
  const rows = largestArrayLength(data);
  if (rows > limits.maxRows) {
    throw new InputTooLargeError(`input ${rows} rows exceeds maxRows ${limits.maxRows}`);
  }
}
