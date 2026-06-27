// E1 — the ExecutionCoordinator. The runtime now has four independent producers (cron, AI chat,
// notification, UI button) that can all ask for the same report at once. This collapses concurrent
// identical requests onto ONE execution: the first caller for a logical-request hash runs it; the
// rest ATTACH to the same promise. 4 triggers → 1 render, 3 attach.
//
// Deliberately brutal and small (v0.2 needs no scheduler):
//   - collapse identical concurrent work by key
//   - cap concurrent DISTINCT work at maxPending; beyond that, reject (ExecutionBusyError) — no
//     hidden queue, no waiting, no priorities, no starvation
//   - bound each execution by a wall-clock timeout (ExecutionTimeoutError); the AbortSignal is
//     best-effort (v0.2 has no worker isolation, so a runaway render isn't force-killed — the
//     timeout bounds the CALLER and lets the run be recorded TIMED_OUT)
//
// `run(key, factory)` encapsulates acquire/attach/release so a caller can never leak a lock — a
// deliberate refinement over a raw acquire()/release() handle pair.

/** A new distinct execution would exceed the concurrency cap. Stable code for logs/runs/APIs. */
export class ExecutionBusyError extends Error {
  readonly code = "EXECUTION_BUSY";
  constructor(message: string) {
    super(message);
    this.name = "ExecutionBusyError";
  }
}

/** An execution exceeded its wall-clock budget. */
export class ExecutionTimeoutError extends Error {
  readonly code = "TIMED_OUT";
  constructor(message: string) {
    super(message);
    this.name = "ExecutionTimeoutError";
  }
}

export interface CoordinatorOptions {
  /** Max concurrent DISTINCT executions before new keys are rejected. Default 10. */
  maxPending?: number;
  /** Per-execution wall-clock budget. Default 5 minutes. */
  maxDurationMs?: number;
  now?: () => number;
}

export interface ExecutionOutcome<T> {
  result: T;
  /** True for the caller that actually ran the work; false for callers that attached to it. */
  leader: boolean;
}

export interface PendingExecution {
  key: string;
  startedAt: number;
  waiters: number;
}

interface RunningExecution {
  promise: Promise<unknown>;
  startedAt: number;
  waiters: number;
  abort: AbortController;
}

export const DEFAULT_MAX_PENDING = 10;
export const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;

export class ExecutionCoordinator {
  private readonly running = new Map<string, RunningExecution>();
  private readonly maxPending: number;
  private readonly maxDurationMs: number;
  private readonly now: () => number;

  constructor(opts: CoordinatorOptions = {}) {
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run `factory` under `key`. Concurrent callers with the same key attach to the one in-flight
   * execution. A new key is rejected with ExecutionBusyError once maxPending distinct executions
   * are already running (attaches never count against the cap — they add no load).
   */
  async run<T>(key: string, factory: (signal: AbortSignal) => Promise<T>): Promise<ExecutionOutcome<T>> {
    const existing = this.running.get(key);
    if (existing) {
      existing.waiters++;
      try {
        return { result: (await existing.promise) as T, leader: false };
      } finally {
        existing.waiters--;
      }
    }
    if (this.running.size >= this.maxPending) {
      throw new ExecutionBusyError(
        `runtime busy: ${this.running.size}/${this.maxPending} executions in flight`,
      );
    }
    const abort = new AbortController();
    const rec: RunningExecution = {
      startedAt: this.now(),
      waiters: 0,
      abort,
      promise: this.guard(factory, abort),
    };
    this.running.set(key, rec);
    try {
      return { result: (await rec.promise) as T, leader: true };
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * Bound the work by a wall-clock timeout. On timeout the result is authoritatively TIMED_OUT,
   * even if aborting the work then makes it resolve synchronously — a settle-once latch guarantees
   * the timeout wins over a racing late resolution (a plain Promise.race can't). The work promise
   * is a zombie afterwards (no worker isolation in v0.2); its late settlement is swallowed.
   */
  private guard<T>(factory: (signal: AbortSignal) => Promise<T>, abort: AbortController): Promise<T> {
    const work = factory(abort.signal);
    work.catch(() => {}); // never let a late zombie rejection surface as unhandledRejection
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        act();
      };
      const timer = setTimeout(() => {
        abort.abort(); // best-effort cancellation
        finish(() => reject(new ExecutionTimeoutError(`execution exceeded ${this.maxDurationMs}ms`)));
      }, this.maxDurationMs);
      work.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  /** In-flight executions (for a telemetry/status surface). */
  pending(): PendingExecution[] {
    return [...this.running.entries()].map(([key, r]) => ({
      key,
      startedAt: r.startedAt,
      waiters: r.waiters,
    }));
  }

  pendingCount(): number {
    return this.running.size;
  }
}
