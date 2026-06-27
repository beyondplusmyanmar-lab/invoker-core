import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { FetchProvider } from "../providers/index.ts";
import type { Store } from "../storage/db.ts";
import type { InvokeResult } from "../abi/index.ts";
import { invoke } from "./invoke.ts";
import { decideRun, type ScheduledJob } from "./scheduler.ts";

/**
 * Run one job now: fetch (if it declares a source) → invoke → persist run + scheduler_state.
 * This is the scheduler transport's unit of work; it adds orchestration around invoke(),
 * never render or business logic.
 */
export async function runJob(
  job: ScheduledJob,
  store: Store,
  fetcher?: FetchProvider,
): Promise<InvokeResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  store.recordRun({
    id: runId,
    jobId: job.id,
    capability: job.capability,
    status: "running",
    cacheHit: false,
    startedAt,
  });

  try {
    const data = job.source ? await mustFetch(fetcher, job.source) : {};
    const result = await invoke(
      {
        id: runId,
        capability: job.capability,
        contractVersion: job.contractVersion,
        params: {},
        template: job.template,
        data,
      },
      store,
    );
    store.recordRun({
      id: runId,
      jobId: job.id,
      capability: job.capability,
      status: "completed",
      cacheHit: result.cacheHit,
      durationMs: result.durationMs,
      startedAt,
      finishedAt: Date.now(),
    });
    store.setSchedulerState(job.id, { lastRunAt: startedAt, lastStatus: "completed" });
    return result;
  } catch (err) {
    store.recordRun({
      id: runId,
      jobId: job.id,
      capability: job.capability,
      status: "failed",
      cacheHit: false,
      startedAt,
      finishedAt: Date.now(),
      error: (err as Error).message,
    });
    store.setSchedulerState(job.id, { lastRunAt: startedAt, lastStatus: "failed" });
    throw err;
  }
}

function mustFetch(fetcher: FetchProvider | undefined, source: string) {
  if (!fetcher) throw new Error(`job has a source (${source}) but no FetchProvider was supplied`);
  return fetcher.fetchJson(source);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most recent scheduled tick at or before `now`, searched forward from a lower bound.
 *
 * croner's `previousRun()` is relative to an instance's own execution history (null for a
 * fresh instance), so it can't answer "what was the last tick that should have fired?".
 * We anchor the search at the last successful run when known, else a bounded lookback,
 * and walk forward to the latest occurrence <= now.
 */
export function previousTick(cron: Cron, lowerBoundMs: number, now: number): number | null {
  let t = cron.nextRun(new Date(lowerBoundMs));
  if (!t || t.getTime() > now) return null;
  let last = t.getTime();
  for (let i = 0; i < 100_000; i++) {
    const next = cron.nextRun(new Date(last));
    if (!next || next.getTime() > now) break;
    last = next.getTime();
  }
  return last;
}

/** Filter to jobs whose most recent cron tick is due under their missed-run policy. */
export function dueJobs(jobs: ScheduledJob[], store: Store, now = Date.now()): ScheduledJob[] {
  return jobs.filter((job) => {
    if (!job.cron) return false; // unscheduled (manual `invoker run` only)
    const state = store.getSchedulerState(job.id);
    // Anchor at the last run if known; otherwise look back a bounded window so a
    // never-run job still sees a recently-elapsed tick (bounds the forward walk).
    const lowerBound = state.lastRunAt ?? now - Math.max(job.maxLagMs, DAY_MS);
    const prevTick = previousTick(new Cron(job.cron), lowerBound, now);
    return decideRun(job, prevTick, state, now).run;
  });
}
