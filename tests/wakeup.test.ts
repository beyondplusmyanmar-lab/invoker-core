import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { dueJobs } from "../src/core/runner.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";

// Simulates the laptop-wakeup case through the real croner + SQLite path:
// a tick passed while the machine was off; on wake, is the job due?

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "wake",
    name: "wake",
    capability: "excel.render",
    contractVersion: 1,
    cron: "* * * * *", // a tick is always in the recent past
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 24 * 60 * 60 * 1000,
    enabled: true,
    ...overrides,
  };
}

function withStore<T>(fn: (store: Store) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "invoker-wake-"));
  const store = new Store(dir);
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CatchUp: a missed tick is due on wake when no run is recorded", () => {
  withStore((store) => {
    const j = job();
    store.upsertJob(j);
    expect(dueJobs([j], store).map((x) => x.id)).toContain("wake");
  });
});

test("CatchUp: a satisfied tick does not re-run", () => {
  withStore((store) => {
    const j = job();
    store.upsertJob(j);
    // Mark as just run — the most recent tick is now satisfied.
    store.setSchedulerState(j.id, { lastRunAt: Date.now(), lastStatus: "completed" });
    expect(dueJobs([j], store)).toHaveLength(0);
  });
});

test("CatchUp: a tick older than maxLag is dropped, not caught up", () => {
  withStore((store) => {
    const j = job({ maxLagMs: 1 }); // effectively: only run if we woke up right at the tick
    store.upsertJob(j);
    expect(dueJobs([j], store)).toHaveLength(0);
  });
});

test("Resume: a stale missed tick still runs once on next launch", () => {
  withStore((store) => {
    const j = job({ policy: SchedulePolicy.Resume, maxLagMs: 1 });
    store.upsertJob(j);
    expect(dueJobs([j], store).map((x) => x.id)).toContain("wake");
  });
});

test("manual job (no cron) is skipped, not fed to croner", () => {
  withStore((store) => {
    // A `cron=manual` import persists a job with no cron expression. The daemon
    // tick must skip it; `new Cron(null)` would otherwise throw and kill the loop.
    // Not upserted: a null-cron row reaches the daemon only via a workspace DB
    // written by a nullable-cron schema (p1a-wiring). The guard short-circuits
    // before any store access, so passing the job directly exercises the path.
    const j = job({ id: "manual", name: "manual", cron: null as unknown as string });
    expect(() => dueJobs([j], store)).not.toThrow();
    expect(dueJobs([j], store)).toHaveLength(0);
  });
});
