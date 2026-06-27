import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Artifact } from "../abi/index.ts";
import type { SchedulePolicy, ScheduledJob, SchedulerState } from "../core/scheduler.ts";
import type { PipelineStep } from "../core/pipeline.ts";

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
  /** Terminal artifact reference, denormalized onto the run for report history. */
  artifactSha256?: string;
  artifactPath?: string;
  artifactType?: string;
  artifactSize?: number;
}

/** A run joined with its job's name + artifact, newest-first — what the History panel binds to. */
export interface RunListItem {
  id: string;
  jobId?: string;
  jobName?: string;
  capability: string;
  status: "pending" | "running" | "completed" | "failed";
  cacheHit: boolean;
  durationMs?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  artifact?: { sha256: string; path: string; type: string; size: number };
}

/**
 * A scheduled job joined to its latest run — the "current status" view the manager's schedule
 * surface binds to. History (`runs`) is the full audit; this is the single live row per job:
 * is it enabled, when did it last run, did it succeed, how long did it take, what did it render.
 */
export interface ScheduleRow {
  id: string;
  name: string;
  capability: string;
  /** "" = manual (never fires on a tick; run by hand only). */
  cron: string;
  policy: SchedulePolicy;
  enabled: boolean;
  /** Terminal renderer of the most recent run (artifact type), if any has produced one. */
  renderer?: string;
  lastRunAt?: number;
  lastStatus?: "pending" | "running" | "completed" | "failed";
  lastDurationMs?: number;
  lastCacheHit?: boolean;
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
    this.migrate();
  }

  /**
   * Additive, idempotent column migrations. `CREATE TABLE IF NOT EXISTS` never alters an existing
   * table, so a workspace created by an earlier schema needs the new columns added explicitly.
   * Each ADD COLUMN throws "duplicate column" once the column exists — caught and ignored. This is
   * the minimal migration story; a versioned framework arrives later (v0.4).
   */
  private migrate(): void {
    const additions = [
      "ALTER TABLE runs ADD COLUMN artifact_sha256 TEXT",
      "ALTER TABLE runs ADD COLUMN artifact_path TEXT",
      "ALTER TABLE runs ADD COLUMN artifact_type TEXT",
      "ALTER TABLE runs ADD COLUMN artifact_size INTEGER",
    ];
    for (const sql of additions) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already present */
      }
    }
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
         (id, name, capability, contract_version, source, template, steps, cron, policy, max_lag_ms, enabled)
         VALUES ($id, $name, $cap, $cv, $source, $template, $steps, $cron, $policy, $lag, $enabled)`,
      )
      .run({
        $id: j.id,
        $name: j.name,
        $cap: j.capability,
        $cv: j.contractVersion,
        $source: j.source ?? null,
        $template: j.template ?? null,
        $steps: j.steps && j.steps.length ? JSON.stringify(j.steps) : null,
        $cron: j.cron || null,
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

  /** Toggle a job's enabled flag in place. Returns false if no such job (so the CLI can 404). */
  setJobEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .query("UPDATE jobs SET enabled = $enabled WHERE id = $id")
      .run({ $id: id, $enabled: enabled ? 1 : 0 });
    return r.changes > 0;
  }

  /**
   * Every job joined to its latest run — the schedule surface's status view. The correlated
   * subquery picks the newest run per job (started_at desc, id as a stable tiebreak), so the
   * join stays one row per job even with hundreds of runs.
   */
  listSchedules(): ScheduleRow[] {
    const rows = this.db
      .query(
        `SELECT j.*,
                r.status      AS last_status,
                r.started_at  AS last_run_at,
                r.duration_ms AS last_duration_ms,
                r.cache_hit   AS last_cache_hit,
                r.artifact_type AS last_renderer
         FROM jobs j
         LEFT JOIN runs r ON r.id = (
           SELECT id FROM runs WHERE job_id = j.id ORDER BY started_at DESC, id LIMIT 1
         )
         ORDER BY j.name`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToScheduleRow);
  }

  // --- runs ----------------------------------------------------------------

  recordRun(r: RunRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO runs
         (id, job_id, capability, status, cache_hit, duration_ms, started_at, finished_at, error,
          artifact_sha256, artifact_path, artifact_type, artifact_size)
         VALUES ($id, $jobId, $cap, $status, $cacheHit, $dur, $startedAt, $finishedAt, $error,
          $aSha, $aPath, $aType, $aSize)`,
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
        $aSha: r.artifactSha256 ?? null,
        $aPath: r.artifactPath ?? null,
        $aType: r.artifactType ?? null,
        $aSize: r.artifactSize ?? null,
      });
  }

  /** Recent runs, newest-first, each joined to its job name + denormalized artifact. */
  listRuns(limit = 50): RunListItem[] {
    const rows = this.db
      .query(
        `SELECT r.*, j.name AS job_name
         FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
         ORDER BY r.started_at DESC, r.id LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToRunItem);
  }

  /** Write a self-describing manifest sidecar next to an artifact (survives without the DB). */
  writeManifest(id: string, manifest: Record<string, unknown>): string {
    const path = join(this.artifactsDir, `${id}.manifest.json`);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return path;
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
    steps: r.steps == null ? undefined : (JSON.parse(String(r.steps)) as PipelineStep[]),
    cron: r.cron == null ? "" : String(r.cron),
    policy: String(r.policy) as SchedulePolicy,
    maxLagMs: Number(r.max_lag_ms),
    enabled: Number(r.enabled) === 1,
  };
}

function rowToScheduleRow(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    name: String(r.name),
    capability: String(r.capability),
    cron: r.cron == null ? "" : String(r.cron),
    policy: String(r.policy) as SchedulePolicy,
    enabled: Number(r.enabled) === 1,
    renderer: r.last_renderer == null ? undefined : String(r.last_renderer),
    lastRunAt: r.last_run_at == null ? undefined : Number(r.last_run_at),
    lastStatus: r.last_status == null ? undefined : (String(r.last_status) as ScheduleRow["lastStatus"]),
    lastDurationMs: r.last_duration_ms == null ? undefined : Number(r.last_duration_ms),
    lastCacheHit: r.last_cache_hit == null ? undefined : Number(r.last_cache_hit) === 1,
  };
}

function rowToRunItem(r: Record<string, unknown>): RunListItem {
  const sha = r.artifact_sha256;
  return {
    id: String(r.id),
    jobId: r.job_id == null ? undefined : String(r.job_id),
    jobName: r.job_name == null ? undefined : String(r.job_name),
    capability: String(r.capability),
    status: String(r.status) as RunListItem["status"],
    cacheHit: Number(r.cache_hit) === 1,
    durationMs: r.duration_ms == null ? undefined : Number(r.duration_ms),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? undefined : Number(r.finished_at),
    error: r.error == null ? undefined : String(r.error),
    artifact:
      sha == null
        ? undefined
        : {
            sha256: String(sha),
            path: String(r.artifact_path),
            type: String(r.artifact_type),
            size: Number(r.artifact_size),
          },
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
