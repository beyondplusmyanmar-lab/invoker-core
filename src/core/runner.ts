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

/**
 * Filter to jobs whose most recent cron tick is due under their missed-run policy.
 * croner computes `previousRun()` relative to the real current time, so `now` defaults
 * to Date.now() to keep the lag math consistent.
 */
export function dueJobs(jobs: ScheduledJob[], store: Store, now = Date.now()): ScheduledJob[] {
  return jobs.filter((job) => {
    const prev = new Cron(job.cron).previousRun();
    const prevTick = prev ? prev.getTime() : null;
    const state = store.getSchedulerState(job.id);
    return decideRun(job, prevTick, state, now).run;
  });
}
