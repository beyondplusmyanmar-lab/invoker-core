import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Artifact } from "../abi/index.ts";
import type { SchedulePolicy, ScheduledJob, SchedulerState } from "../core/scheduler.ts";

export interface RunRecord {
  id: string;
  jobId?: string;
  capability: string;
  status: "pending" | "running" | "completed" | "failed";
  cacheHit: boolean;
  durationMs?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/**
 * Local persistence. Holds jobs, runs, artifacts, cache lookups, plugins, templates,
 * and scheduler state. SQLite from day one: cheap, portable, and the natural home for
 * cache-hit logic and missed-run state.
 */
export class Store {
  private readonly db: Database;

  constructor(private readonly workspaceDir: string) {
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
    this.db = new Database(join(workspaceDir, "invoker.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  private get artifactsDir(): string {
    return join(this.workspaceDir, "artifacts");
  }

  artifactPath(id: string, type: string): string {
    return join(this.artifactsDir, `${id}.${type}`);
  }

  findArtifactByCacheKey(cacheKey: string): Artifact | undefined {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE cache_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(cacheKey) as Record<string, unknown> | null;
    return row ? rowToArtifact(row) : undefined;
  }

  saveArtifact(a: Artifact): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO artifacts
         (id, cache_key, artifact_sha256, type, mime, path, size,
          engine_version, template_version, deterministic, created_at)
         VALUES ($id, $cacheKey, $sha, $type, $mime, $path, $size,
          $ev, $tv, $det, $createdAt)`,
      )
      .run({
        $id: a.id,
        $cacheKey: a.cacheKey,
        $sha: a.artifactSha256,
        $type: a.type,
        $mime: a.mime,
        $path: a.path,
        $size: a.size,
        $ev: a.engineVersion,
        $tv: a.templateVersion ?? null,
        $det: a.deterministic ? 1 : 0,
        $createdAt: a.createdAt,
      });
  }

  // --- jobs ---------------------------------------------------------------

  upsertJob(j: ScheduledJob): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO jobs
         (id, name, capability, contract_version, source, template, cron, policy, max_lag_ms, enabled)
         VALUES ($id, $name, $cap, $cv, $source, $template, $cron, $policy, $lag, $enabled)`,
      )
      .run({
        $id: j.id,
        $name: j.name,
        $cap: j.capability,
        $cv: j.contractVersion,
        $source: j.source ?? null,
        $template: j.template ?? null,
        $cron: j.cron,
        $policy: j.policy,
        $lag: j.maxLagMs,
        $enabled: j.enabled ? 1 : 0,
      });
  }

  getJob(id: string): ScheduledJob | undefined {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | null;
    return row ? rowToJob(row) : undefined;
  }

  listJobs(): ScheduledJob[] {
    const rows = this.db.query("SELECT * FROM jobs ORDER BY name").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToJob);
  }

  // --- runs ----------------------------------------------------------------

  recordRun(r: RunRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO runs
         (id, job_id, capability, status, cache_hit, duration_ms, started_at, finished_at, error)
         VALUES ($id, $jobId, $cap, $status, $cacheHit, $dur, $startedAt, $finishedAt, $error)`,
      )
      .run({
        $id: r.id,
        $jobId: r.jobId ?? null,
        $cap: r.capability,
        $status: r.status,
        $cacheHit: r.cacheHit ? 1 : 0,
        $dur: r.durationMs ?? null,
        $startedAt: r.startedAt,
        $finishedAt: r.finishedAt ?? null,
        $error: r.error ?? null,
      });
  }

  // --- scheduler state -----------------------------------------------------

  getSchedulerState(jobId: string): SchedulerState {
    const row = this.db
      .query("SELECT last_run_at, last_status FROM scheduler_state WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | null;
    if (!row) return {};
    return {
      lastRunAt: row.last_run_at == null ? undefined : Number(row.last_run_at),
      lastStatus: row.last_status == null ? undefined : String(row.last_status),
    };
  }

  setSchedulerState(jobId: string, state: SchedulerState): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO scheduler_state (job_id, last_run_at, last_status)
         VALUES ($id, $lastRunAt, $lastStatus)`,
      )
      .run({
        $id: jobId,
        $lastRunAt: state.lastRunAt ?? null,
        $lastStatus: state.lastStatus ?? null,
      });
  }

  // --- daemon heartbeat (P2) ----------------------------------------------

  setDaemonHeartbeat(hb: DaemonHeartbeat): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO daemon_state (id, pid, started_at, last_tick_at, ticks, status)
         VALUES (1, $pid, $startedAt, $lastTickAt, $ticks, $status)`,
      )
      .run({
        $pid: hb.pid,
        $startedAt: hb.startedAt,
        $lastTickAt: hb.lastTickAt ?? null,
        $ticks: hb.ticks,
        $status: hb.status,
      });
  }

  getDaemonHeartbeat(): DaemonHeartbeat | undefined {
    const row = this.db.query("SELECT * FROM daemon_state WHERE id = 1").get() as
      | Record<string, unknown>
      | null;
    if (!row) return undefined;
    return {
      pid: Number(row.pid),
      startedAt: Number(row.started_at),
      lastTickAt: row.last_tick_at == null ? undefined : Number(row.last_tick_at),
      ticks: Number(row.ticks),
      status: String(row.status) as DaemonHeartbeat["status"],
    };
  }

  // --- plugins (read-only view for doctor, ADR-008) ------------------------

  listPlugins(): PluginSummary[] {
    const rows = this.db
      .query("SELECT name, version, enabled, verified FROM plugins ORDER BY name")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      name: String(r.name),
      version: String(r.version),
      enabled: Number(r.enabled) === 1,
      verified: Number(r.verified),
    }));
  }

  countArtifacts(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}

/** Single-row daemon liveness record (P2). The lockfile owns exclusion; this owns visibility. */
export interface DaemonHeartbeat {
  pid: number;
  startedAt: number;
  lastTickAt?: number;
  ticks: number;
  status: "running" | "stopped";
}

/** A trust-tiered plugin row, summarised for `invoker doctor` (ADR-008). */
export interface PluginSummary {
  name: string;
  version: string;
  enabled: boolean;
  /** 0 unverified · 1 verified · 2 trusted · 3 required. */
  verified: number;
}

function rowToJob(r: Record<string, unknown>): ScheduledJob {
  return {
    id: String(r.id),
    name: String(r.name),
    capability: String(r.capability),
    contractVersion: Number(r.contract_version),
    source: r.source == null ? undefined : String(r.source),
    template: r.template == null ? undefined : String(r.template),
    cron: String(r.cron),
    policy: String(r.policy) as SchedulePolicy,
    maxLagMs: Number(r.max_lag_ms),
    enabled: Number(r.enabled) === 1,
  };
}

function rowToArtifact(r: Record<string, unknown>): Artifact {
  return {
    id: String(r.id),
    type: String(r.type),
    mime: String(r.mime),
    path: String(r.path),
    size: Number(r.size),
    cacheKey: String(r.cache_key),
    artifactSha256: String(r.artifact_sha256),
    engineVersion: String(r.engine_version),
    templateVersion: r.template_version == null ? undefined : String(r.template_version),
    deterministic: Number(r.deterministic) === 1,
    createdAt: Number(r.created_at),
  };
}
