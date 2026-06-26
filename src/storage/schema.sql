-- invoker-core local state. One file per workspace. Never committed.

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  capability      TEXT NOT NULL,
  contract_version INTEGER NOT NULL DEFAULT 1,
  template        TEXT,
  cron            TEXT NOT NULL,
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
  error        TEXT
);

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

CREATE TABLE IF NOT EXISTS scheduler_state (
  job_id      TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_status TEXT
);
