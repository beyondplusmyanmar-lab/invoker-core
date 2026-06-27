import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { FetchProvider } from "../providers/index.ts";
import type { Store } from "../storage/db.ts";
import type { InvokeResult } from "../abi/index.ts";
import { invoke } from "./invoke.ts";
import { runPipeline } from "./pipeline.ts";
import { decideRun, type ScheduledJob } from "./scheduler.ts";

/**
 * Run one job now: fetch (if it declares a source) → invoke OR runPipeline → persist run +
 * scheduler_state. This is the scheduler transport's unit of work; it adds orchestration
 * around invoke()/runPipeline, never render or business logic.
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
    const result =
      job.steps && job.steps.length > 0
        ? await runPipeline(job.steps, data, store)
        : await invoke(
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
    const finishedAt = Date.now();
    const art = result.artifact; // a pipeline's terminal artifact has its own id; carry it on the run
    store.recordRun({
      id: runId,
      jobId: job.id,
      capability: job.capability,
      status: "completed",
      cacheHit: result.cacheHit,
      durationMs: result.durationMs,
      startedAt,
      finishedAt,
      artifactSha256: art?.artifactSha256,
      artifactPath: art?.path,
      artifactType: art?.type,
      artifactSize: art?.size,
    });
    if (art) {
      // Self-describing sidecar: a report stays interpretable from the filesystem alone, even
      // if the sqlite index is lost — consistent with Hands being artifact authority.
      store.writeManifest(runId, {
        id: runId,
        job: job.name,
        capability: job.capability,
        renderer: art.type,
        engine_version: art.engineVersion,
        sha256: art.artifactSha256,
        size: art.size,
        generated_at: new Date(finishedAt).toISOString(),
        duration_ms: result.durationMs,
        cache_hit: result.cacheHit,
      });
    }
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

/**
 * The next scheduled tick strictly after `now`, for display on the schedule surface ("next run").
 * Returns null for a manual (empty) cron. Unlike `previousTick` this is what croner answers
 * natively, so it's a thin wrapper that also guards the manual case.
 */
export function nextTick(cron: string, now = Date.now()): number | null {
  if (!cron) return null;
  const t = new Cron(cron).nextRun(new Date(now));
  return t ? t.getTime() : null;
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
