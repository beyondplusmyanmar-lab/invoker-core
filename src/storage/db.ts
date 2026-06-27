import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
// Imported as text so the bundler embeds it — a runtime readFileSync(schema.sql) is invisible to
// `bun build --compile` and the standalone binary crashes opening its workspace DB (ENOENT $bunfs).
import schemaSql from "./schema.sql" with { type: "text" };
import { sha256Hex } from "../core/hash.ts";
import type { Artifact } from "../abi/index.ts";
import type { SchedulePolicy, ScheduledJob, SchedulerState } from "../core/scheduler.ts";
import type { PipelineStep } from "../core/pipeline.ts";
import type { NotificationEvent } from "../core/notifications.ts";

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
  /** True when this producer attached to an in-flight render instead of rendering (collapse). */
  collapsed?: boolean;
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

/** A persisted notification — a received NotificationEvent plus its local id and read state. */
export interface NotificationRecord {
  id: string;
  eventId: string;
  title: string;
  body: string;
  type: string;
  receivedAt: number;
  readAt?: number;
}

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
    this.db.exec(schemaSql);
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
      "ALTER TABLE runs ADD COLUMN manifest_sha256 TEXT",
      "ALTER TABLE runs ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0",
      // jobs columns added after the original schema (pipeline + contract work); an
      // alpha-era workspace has a jobs table without them. Defaults mirror schema.sql.
      "ALTER TABLE jobs ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE jobs ADD COLUMN source TEXT",
      "ALTER TABLE jobs ADD COLUMN template TEXT",
      "ALTER TABLE jobs ADD COLUMN steps TEXT",
      "ALTER TABLE jobs ADD COLUMN policy TEXT NOT NULL DEFAULT 'catchup'",
      "ALTER TABLE jobs ADD COLUMN max_lag_ms INTEGER NOT NULL DEFAULT 86400000",
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
          artifact_sha256, artifact_path, artifact_type, artifact_size, collapsed)
         VALUES ($id, $jobId, $cap, $status, $cacheHit, $dur, $startedAt, $finishedAt, $error,
          $aSha, $aPath, $aType, $aSize, $collapsed)`,
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
        $collapsed: r.collapsed ? 1 : 0,
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
  writeManifest(runId: string, manifest: Record<string, unknown>): string {
    const path = join(this.artifactsDir, `${runId}.manifest.json`);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    writeFileSync(path, bytes);
    // Fingerprint the sidecar's own bytes so `artifact verify` can detect manifest tampering.
    this.db
      .query("UPDATE runs SET manifest_sha256 = $h WHERE id = $id")
      .run({ $h: sha256Hex(bytes), $id: runId });
    return path;
  }

  /** Path of a run's manifest sidecar (exists only for runs whose leader actually rendered). */
  manifestPath(runId: string): string {
    return join(this.artifactsDir, `${runId}.manifest.json`);
  }

  /** Find an artifact by full sha256 or a shorthand prefix (newest wins on an ambiguous prefix). */
  findArtifactBySha(shaPrefix: string): Artifact | undefined {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE artifact_sha256 LIKE ? ORDER BY created_at DESC LIMIT 1")
      .get(`${shaPrefix}%`) as Record<string, unknown> | null;
    return row ? rowToArtifact(row) : undefined;
  }

  /** Runs that produced/served a given artifact sha, newest-first, with each one's manifest hash. */
  runsForArtifactSha(sha: string): { id: string; manifestSha256?: string }[] {
    const rows = this.db
      .query("SELECT id, manifest_sha256 FROM runs WHERE artifact_sha256 = ? ORDER BY started_at DESC")
      .all(sha) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      manifestSha256: r.manifest_sha256 == null ? undefined : String(r.manifest_sha256),
    }));
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

  // --- notifications (v0.2) ------------------------------------------------

  /**
   * Persist a received notification. Dedup is the listener's only correctness property: an
   * `INSERT OR IGNORE` against `UNIQUE(event_id)` makes re-delivery idempotent. Returns true when
   * a new row was written, false when it deduped against an event already seen.
   */
  recordNotification(e: NotificationEvent): boolean {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO notifications (id, event_id, title, body, type, received_at)
         VALUES ($id, $eventId, $title, $body, $type, $receivedAt)`,
      )
      .run({
        $id: randomUUID(),
        $eventId: e.eventId,
        $title: e.title,
        $body: e.body,
        $type: e.type,
        $receivedAt: e.receivedAt,
      });
    return r.changes > 0;
  }

  /** Notifications newest-first; `unreadOnly` restricts to unread. */
  listNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): NotificationRecord[] {
    const where = opts.unreadOnly ? "WHERE read_at IS NULL" : "";
    const rows = this.db
      .query(`SELECT * FROM notifications ${where} ORDER BY received_at DESC, id LIMIT ?`)
      .all(opts.limit ?? 50) as Record<string, unknown>[];
    return rows.map(rowToNotification);
  }

  unreadNotificationCount(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL")
      .get() as { n: number };
    return Number(row.n);
  }

  /** Mark one notification read. Returns false if it doesn't exist or was already read. */
  markNotificationRead(id: string, now = Date.now()): boolean {
    const r = this.db
      .query("UPDATE notifications SET read_at = $now WHERE id = $id AND read_at IS NULL")
      .run({ $id: id, $now: now });
    return r.changes > 0;
  }

  /** Mark every unread notification read. Returns how many were affected. */
  markAllNotificationsRead(now = Date.now()): number {
    const r = this.db
      .query("UPDATE notifications SET read_at = $now WHERE read_at IS NULL")
      .run({ $now: now });
    return r.changes;
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

  // --- retention / maintenance (v0.2) --------------------------------------

  /** Minimal artifact facts for eviction planning. */
  listArtifactBriefs(): { id: string; path: string; size: number; createdAt: number }[] {
    const rows = this.db
      .query("SELECT id, path, size, created_at FROM artifacts")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      path: String(r.path),
      size: Number(r.size),
      createdAt: Number(r.created_at),
    }));
  }

  /** Remove an artifact's index row (the file is removed by the caller). */
  deleteArtifact(id: string): void {
    this.db.query("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  countNotifications(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
    return Number(row.n);
  }

  /** Keep the newest `max` notifications; delete the rest. Returns how many were deleted. */
  trimNotifications(max: number): number {
    const r = this.db
      .query(
        `DELETE FROM notifications WHERE id NOT IN (
           SELECT id FROM notifications ORDER BY received_at DESC, id LIMIT ?
         )`,
      )
      .run(max);
    return r.changes;
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  // --- health / observability (v0.2) ---------------------------------------

  /** Upsert a connector's liveness so a one-shot `invoker health` can report it. */
  setServiceHeartbeat(service: string, status: "connected" | "disconnected", detail?: string): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO service_heartbeat (service, status, last_seen, detail)
         VALUES ($s, $status, $now, $detail)`,
      )
      .run({ $s: service, $status: status, $now: Date.now(), $detail: detail ?? null });
  }

  getServiceHeartbeat(service: string): { status: string; lastSeen: number; detail?: string } | undefined {
    const row = this.db.query("SELECT * FROM service_heartbeat WHERE service = ?").get(service) as
      | Record<string, unknown>
      | null;
    if (!row) return undefined;
    return {
      status: String(row.status),
      lastSeen: Number(row.last_seen),
      detail: row.detail == null ? undefined : String(row.detail),
    };
  }

  /** Cache-hit ratio (0..1) over completed runs, optionally only those since `sinceMs`. */
  cacheHitRatio(sinceMs?: number): number {
    const where = sinceMs == null ? "" : "AND started_at >= ?";
    const row = this.db
      .query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(cache_hit), 0) AS hits
         FROM runs WHERE status = 'completed' ${where}`,
      )
      .get(...(sinceMs == null ? [] : [sinceMs])) as { total: number; hits: number };
    return row.total === 0 ? 0 : Number(row.hits) / Number(row.total);
  }

  /** Count of runs that collapsed onto an in-flight render (duplicate renders prevented) since `sinceMs`. */
  collapsedCount(sinceMs: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM runs WHERE collapsed = 1 AND started_at >= ?")
      .get(sinceMs) as { n: number };
    return Number(row.n);
  }

  /** The most recent completed run that produced an artifact — "last report" on the health page. */
  lastReport(): { jobName?: string; capability: string; startedAt: number; type?: string; sha?: string } | undefined {
    const row = this.db
      .query(
        `SELECT r.capability, r.started_at, r.artifact_type, r.artifact_sha256, j.name AS job_name
         FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.status = 'completed' AND r.artifact_sha256 IS NOT NULL
         ORDER BY r.started_at DESC, r.id LIMIT 1`,
      )
      .get() as Record<string, unknown> | null;
    if (!row) return undefined;
    return {
      jobName: row.job_name == null ? undefined : String(row.job_name),
      capability: String(row.capability),
      startedAt: Number(row.started_at),
      type: row.artifact_type == null ? undefined : String(row.artifact_type),
      sha: row.artifact_sha256 == null ? undefined : String(row.artifact_sha256),
    };
  }

  /** Recent artifact sha256s, newest-first — for doctor's sample verify and the pilot corruption sweep. */
  recentArtifactShas(limit: number): string[] {
    const rows = this.db
      .query("SELECT artifact_sha256 FROM artifacts ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => String(r.artifact_sha256));
  }

  /**
   * Count of duplicate fresh renders: completed runs that rendered (not cache-hit, not collapsed)
   * an artifact sha that an earlier fresh render already produced. A direct "0 duplicate renders"
   * pilot-gate signal — proves cache + coordinator + determinism are all doing their jobs.
   */
  duplicateRenderCount(): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(c - 1), 0) AS dups FROM (
           SELECT COUNT(*) AS c FROM runs
           WHERE status = 'completed' AND cache_hit = 0 AND collapsed = 0 AND artifact_sha256 IS NOT NULL
           GROUP BY artifact_sha256
         )`,
      )
      .get() as { dups: number };
    return Number(row.dups);
  }

  /** Total bytes of all recorded artifacts (summed from the index, no filesystem walk). */
  artifactsDiskBytes(): number {
    const row = this.db.query("SELECT COALESCE(SUM(size), 0) AS n FROM artifacts").get() as { n: number };
    return Number(row.n);
  }

  /** SQLite self-check — surfaced as DB ok/error on the health page. */
  dbIntegrityOk(): boolean {
    try {
      const row = this.db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
      return !!row && String(Object.values(row)[0]) === "ok";
    } catch {
      return false;
    }
  }

  /**
   * A consistent point-in-time snapshot of the entire database for the support bundle. Uses
   * SQLite's own serializer, so it captures committed WAL pages too — copying the .sqlite file
   * directly would miss anything still sitting in the -wal sidecar.
   */
  snapshotBytes(): Uint8Array {
    return new Uint8Array(this.db.serialize());
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

function rowToNotification(r: Record<string, unknown>): NotificationRecord {
  return {
    id: String(r.id),
    eventId: String(r.event_id),
    title: String(r.title),
    body: String(r.body),
    type: String(r.type),
    receivedAt: Number(r.received_at),
    readAt: r.read_at == null ? undefined : Number(r.read_at),
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
