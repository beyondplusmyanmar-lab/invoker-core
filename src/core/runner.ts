import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { FetchProvider } from "../providers/index.ts";
import type { Store } from "../storage/db.ts";
import type { InvokeResult } from "../abi/index.ts";
import { invoke } from "./invoke.ts";
import { runPipeline } from "./pipeline.ts";
import { decideRun, type ScheduledJob } from "./scheduler.ts";
import { sha256Hex, jsonHash } from "./hash.ts";
import { enforceInputLimits, DEFAULT_LIMITS, type Limits } from "./limits.ts";
import type { ExecutionCoordinator } from "./execution.ts";

/**
 * The timezone the scheduler evaluates crons in. It MUST be stable for the life of the process,
 * which is why it is captured here at module load — before any render runs. `renderWorkbook`
 * permanently sets `process.env.TZ = "UTC"` for artifact determinism (ADR-007); croner reads the
 * ambient zone, so without pinning it explicitly that mutation leaks into scheduling and shifts
 * every cron by the local UTC offset after the first render (a 6am report drifts to 6am UTC).
 * Default = the system zone, so "0 6 * * *" means 6am shop-local; INVOKER_TZ overrides it.
 */
export const SCHEDULER_TZ =
  process.env.INVOKER_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

/** A croner instance pinned to the scheduler zone — immune to the render's process-wide TZ pin. */
export function newCron(expr: string, tz: string = SCHEDULER_TZ): Cron {
  return new Cron(expr, { timezone: tz });
}

/** Runtime protections threaded into a job run (E1). Both optional and backward-compatible. */
export interface RunJobOptions {
  /** Collapses concurrent identical runs onto one render; bounds concurrency + duration. */
  coordinator?: ExecutionCoordinator;
  /** Input ceilings enforced at the data boundary. Defaults to DEFAULT_LIMITS. */
  limits?: Limits;
}

/**
 * The coordinator key: identifies "this job with this input". Two producers asking for the same
 * report with the same fetched data collapse onto one render. Distinct from invoke()'s cacheKey
 * (which is per-capability and per-step); this is per whole-job, so it covers pipelines too.
 */
export function logicalRequestHash(job: ScheduledJob, data: unknown): string {
  return sha256Hex(
    [
      job.id,
      job.capability,
      `c${job.contractVersion}`,
      `t${job.template ?? ""}`,
      job.steps?.length ? `s${jsonHash(job.steps)}` : "",
      `d${jsonHash(data ?? null)}`,
    ].join("|"),
  );
}

/** Prefer a capability/runtime error's stable UPPER_SNAKE `code`; fall back to its message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : (err as Error).message;
}

/**
 * Run one job now: fetch (if it declares a source) → invoke OR runPipeline → persist run +
 * scheduler_state. This is the scheduler transport's unit of work; it adds orchestration
 * around invoke()/runPipeline, never render or business logic.
 */
export async function runJob(
  job: ScheduledJob,
  store: Store,
  fetcher?: FetchProvider,
  opts: RunJobOptions = {},
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
    enforceInputLimits(data, opts.limits ?? DEFAULT_LIMITS); // reject oversized input before any render

    // The actual render. A pipeline's terminal artifact has its own id; a single-cap job binds the
    // artifact to this run's id. The signal is best-effort (no worker isolation in v0.2).
    const render = (): Promise<InvokeResult> =>
      job.steps && job.steps.length > 0
        ? runPipeline(job.steps, data, store)
        : invoke(
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

    // With a coordinator, concurrent identical requests collapse onto one render; the rest attach.
    let result: InvokeResult;
    let leader = true;
    if (opts.coordinator) {
      const outcome = await opts.coordinator.run(logicalRequestHash(job, data), render);
      result = outcome.result;
      leader = outcome.leader;
    } else {
      result = await render();
    }

    const finishedAt = Date.now();
    const art = result.artifact;
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
      collapsed: !leader, // attached to an in-flight render rather than rendering itself
    });
    // Only the leader actually rendered, so only it writes the artifact's manifest sidecar; the
    // attached waiters share that same artifact (and its existing manifest).
    if (art && leader) {
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
    // Stable code (TIMED_OUT / EXECUTION_BUSY / INPUT_TOO_LARGE / …) lands in the run's error column.
    store.recordRun({
      id: runId,
      jobId: job.id,
      capability: job.capability,
      status: "failed",
      cacheHit: false,
      startedAt,
      finishedAt: Date.now(),
      error: errorCode(err),
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
export function nextTick(cron: string, now = Date.now(), tz: string = SCHEDULER_TZ): number | null {
  if (!cron) return null;
  const t = newCron(cron, tz).nextRun(new Date(now));
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
    const prevTick = previousTick(newCron(job.cron), lowerBound, now);
    return decideRun(job, prevTick, state, now).run;
  });
}
