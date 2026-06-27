-- invoker-core local state. One file per workspace. Never committed.

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  capability      TEXT NOT NULL,
  contract_version INTEGER NOT NULL DEFAULT 1,
  source          TEXT,                            -- optional JSON fetch ref (http(s):// or file:)
  template        TEXT,
  steps           TEXT,                            -- optional pipeline (JSON PipelineStep[])
  cron            TEXT,                            -- NULL/'' = unscheduled (manual run only)
  policy          TEXT NOT NULL DEFAULT 'catchup',  -- catchup | skip | resume
  max_lag_ms      INTEGER NOT NULL DEFAULT 86400000,
  enabled         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT,
  capability   TEXT NOT NULL,
  status       TEXT NOT NULL,            -- pending | running | completed | failed
  cache_hit    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  error        TEXT,
  -- Terminal artifact, denormalized onto the run (report history). A pipeline job's artifact
  -- has its own id, so the run can't be id-joined to it; carrying the reference here makes the
  -- run the unit the manager sees: "this run produced this file".
  artifact_sha256 TEXT,
  artifact_path   TEXT,
  artifact_type   TEXT,
  artifact_size   INTEGER,
  -- sha256 of the manifest sidecar's own bytes, so `artifact verify` can detect sidecar tampering.
  manifest_sha256 TEXT,
  -- 1 when this producer attached to an in-flight render instead of rendering (coordinator collapse).
  -- Surfaces "duplicate renders prevented" on the health page — a direct pilot-gate signal.
  collapsed       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);

-- ADR-006: cache_key and artifact_sha256 are distinct, stored separately.
CREATE TABLE IF NOT EXISTS artifacts (
  id               TEXT PRIMARY KEY,
  cache_key        TEXT NOT NULL,
  artifact_sha256  TEXT NOT NULL,
  type             TEXT NOT NULL,
  mime             TEXT NOT NULL,
  path             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  engine_version   TEXT NOT NULL,
  template_version TEXT,
  deterministic    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_cache_key ON artifacts (cache_key);

-- ADR-008: plugins are explicit, versioned, trust-tiered.
CREATE TABLE IF NOT EXISTS plugins (
  name          TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  manifest_hash TEXT NOT NULL,
  publisher     TEXT,
  signature     TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,  -- 0 unverified, 1 verified, 2 trusted, 3 required
  installed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  installed_at  INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);

-- Inbound notifications received over the outbound Reverb/Pusher WebSocket (v0.2). A pure
-- listener: dedup is the only correctness property (UNIQUE event_id), no queue/replay/guarantee.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL UNIQUE,       -- source id, or a content hash when the source has none
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  read_at     INTEGER                     -- NULL = unread
);
CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications (received_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_state (
  job_id      TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_status TEXT
);

-- Small key/value store for runtime bookkeeping (e.g. last_cleanup_at, last_vacuum_at).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Liveness of long-running connectors (the notification listener; later the UI's BusinessAI link)
-- so a one-shot `invoker health` can report "connected / stale / absent" without sharing a process.
CREATE TABLE IF NOT EXISTS service_heartbeat (
  service   TEXT PRIMARY KEY,           -- e.g. 'notifications'
  status    TEXT NOT NULL,              -- connected | disconnected
  last_seen INTEGER NOT NULL,
  detail    TEXT
);

-- P2 daemon: single-row heartbeat so `daemon status` and `doctor` can read liveness
-- without parsing the lockfile. The lockfile owns mutual exclusion; this owns observability.
CREATE TABLE IF NOT EXISTS daemon_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  pid          INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  last_tick_at INTEGER,
  ticks        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL              -- running | stopped
);
