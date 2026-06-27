import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../src/storage/db.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";

/**
 * An alpha-era workspace has a `jobs` table created before `steps` (and the other
 * pipeline/contract columns) existed. `CREATE TABLE IF NOT EXISTS` never alters it, so
 * opening such a workspace with a newer build used to fail on the first `jobs add`:
 *   error: table jobs has no column named steps
 * migrate() must backfill the missing columns on open, without disturbing existing rows.
 */
function forgeAlphaWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "invoker-migration-"));
  const db = new Database(join(dir, "invoker.sqlite"));
  // The primordial jobs table: no contract_version / source / template / steps / max_lag_ms.
  db.exec(
    `CREATE TABLE jobs (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, capability TEXT NOT NULL,
       cron TEXT, policy TEXT NOT NULL DEFAULT 'catchup', enabled INTEGER NOT NULL DEFAULT 1
     )`,
  );
  db.exec("INSERT INTO jobs (id, name, capability, cron) VALUES ('old', 'Legacy', 'excel.render', '')");
  db.close();
  return dir;
}

function pipelineJob(): ScheduledJob {
  return {
    id: "daily",
    name: "Daily",
    capability: "excel.render",
    contractVersion: 1,
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

test("opening an alpha-era workspace backfills the missing jobs columns", () => {
  const dir = forgeAlphaWorkspace();
  try {
    const store = new Store(dir); // constructor runs migrate()
    try {
      // The write that used to throw "no column named steps" now succeeds.
      expect(() => store.upsertJob(pipelineJob())).not.toThrow();

      const ids = store.listJobs().map((j) => j.id).sort();
      expect(ids).toEqual(["daily", "old"]); // new job added, legacy job preserved
    } finally {
      store.close();
    }

    // The schema actually gained the columns, and the legacy row kept its data.
    const db = new Database(join(dir, "invoker.sqlite"));
    const names = (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["contract_version", "source", "template", "steps", "max_lag_ms"]) {
      expect(names).toContain(c);
    }
    const legacy = db.query("SELECT steps, policy, max_lag_ms FROM jobs WHERE id = 'old'").get() as {
      steps: string | null;
      policy: string;
      max_lag_ms: number;
    };
    db.close();
    expect(legacy.steps).toBeNull();            // backfilled nullable
    expect(legacy.policy).toBe("catchup");      // preserved
    expect(legacy.max_lag_ms).toBe(86_400_000); // backfilled with the schema default
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate() is idempotent — opening a current workspace twice is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "invoker-migration-idem-"));
  try {
    new Store(dir).close(); // fresh, full schema
    expect(() => new Store(dir).close()).not.toThrow(); // re-open re-runs migrate harmlessly
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
