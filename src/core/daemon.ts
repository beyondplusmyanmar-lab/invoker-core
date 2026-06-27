// P2 — the persistent scheduler. A long-running process that wraps the existing one-shot
// `tick` (dueJobs + runJob) in a supervised loop. It adds NO scheduling logic: dueness and
// missed-run policy already live in scheduler.ts/runner.ts. This file owns only process
// lifecycle — single-instance lock, heartbeat, and an abortable tick→sleep loop.
//
// Wake-robust by construction (ADR-006 + determinism): each pass recomputes dueness from the
// wall clock and last-run state, so a long machine sleep simply surfaces missed ticks to the
// policy on the next pass, and a re-run of an already-satisfied tick is a cache hit, not a
// duplicate. The daemon inherits idempotency; it does not invent it.

import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FetchProvider } from "../providers/index.ts";
import type { Store } from "../storage/db.ts";
import { runJob, dueJobs } from "./runner.ts";

export const DEFAULT_INTERVAL_MS = 60_000;

export function lockPath(workspace: string): string {
  return join(workspace, "daemon.lock");
}

/** Identity of the process that holds the single-instance lock. */
export interface LockInfo {
  pid: number;
  startedAt: number;
  host: string;
}

/**
 * Is a process with this pid currently alive? `signal 0` probes without delivering anything.
 * EPERM means the process exists but is not ours (still alive); ESRCH means it is gone.
 */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(workspace: string): LockInfo | undefined {
  const p = lockPath(workspace);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockInfo;
  } catch {
    return undefined; // a corrupt lock is treated as absent → reclaimable
  }
}

/**
 * Acquire the single-instance lock. Succeeds if it is free or held by a DEAD pid (stale
 * reclaim, e.g. after a crash). Refuses only when a LIVE daemon already holds it, returning
 * that holder so the caller can report it.
 */
export function acquireLock(
  workspace: string,
  pid = process.pid,
  now = Date.now(),
): { ok: true } | { ok: false; holder: LockInfo } {
  const held = readLock(workspace);
  if (held && held.pid !== pid && isAlive(held.pid)) {
    return { ok: false, holder: held };
  }
  writeFileSync(lockPath(workspace), JSON.stringify({ pid, startedAt: now, host: hostname() }));
  return { ok: true };
}

/** Remove the lock, but only if we (or a known-dead pid) own it — never yank a live holder's. */
export function releaseLock(workspace: string, pid = process.pid): void {
  const held = readLock(workspace);
  if (!held || held.pid === pid || !isAlive(held.pid)) {
    try {
      rmSync(lockPath(workspace));
    } catch {
      /* already gone */
    }
  }
}

export interface TickResult {
  at: number;
  ran: number;
  failed: number;
  jobIds: string[];
}

/**
 * One scheduler pass: run every job due now under its policy, resiliently. A single failing
 * job is already recorded by runJob; it must NOT kill the loop, so each run is isolated.
 */
export async function tickOnce(
  store: Store,
  opts: { fetcher?: FetchProvider; now?: number } = {},
): Promise<TickResult> {
  const at = opts.now ?? Date.now();
  const due = dueJobs(store.listJobs(), store, at);
  let ran = 0;
  let failed = 0;
  for (const job of due) {
    try {
      await runJob(job, store, opts.fetcher);
      ran++;
    } catch {
      failed++; // failure is persisted inside runJob; swallow here to keep the daemon alive
    }
  }
  return { at, ran, failed, jobIds: due.map((j) => j.id) };
}

/** Abortable sleep: resolves after `ms`, or immediately when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => done();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface DaemonLoopOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  fetcher?: FetchProvider;
  /** Injectable clock + sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onTick?: (r: TickResult) => void;
  pid?: number;
}

/**
 * The loop. tick → heartbeat → sleep, until the signal aborts. Owns the heartbeat row
 * (observability); the caller owns the lockfile (mutual exclusion) and OS signal wiring.
 * Returns the number of ticks completed, marking the heartbeat stopped on the way out.
 */
export async function runDaemonLoop(store: Store, opts: DaemonLoopOptions = {}): Promise<number> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const signal = opts.signal;
  const pid = opts.pid ?? process.pid;
  const startedAt = now();
  let ticks = 0;
  let lastTickAt: number | undefined;

  store.setDaemonHeartbeat({ pid, startedAt, ticks, status: "running" });

  while (!signal?.aborted) {
    const r = await tickOnce(store, { fetcher: opts.fetcher, now: now() });
    ticks++;
    lastTickAt = r.at;
    store.setDaemonHeartbeat({ pid, startedAt, lastTickAt, ticks, status: "running" });
    opts.onTick?.(r);
    if (signal?.aborted) break;
    await sleep(intervalMs, signal);
  }

  // Mark stopped without disturbing `lastTickAt` — it must stay pinned to the
  // last real tick, not the shutdown moment, or `status` over-reports activity.
  store.setDaemonHeartbeat({ pid, startedAt, lastTickAt, ticks, status: "stopped" });
  return ticks;
}
