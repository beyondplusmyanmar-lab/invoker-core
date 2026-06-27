import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob, nextTick } from "../src/core/runner.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

function ensureCaps() {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
}

const tableFetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "Sales", columns: [{ id: "item", header: "Item" }], rows: [["Tea"], ["Coffee"]] };
  },
};

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "daily-sales",
    name: "Yesterday Sales",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "0 6 * * *",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 24 * 60 * 60 * 1000,
    enabled: true,
    ...overrides,
  };
}

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  ensureCaps();
  const dir = mkdtempSync(join(tmpdir(), "invoker-sched-"));
  const store = new Store(dir);
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a never-run schedule lists with no status fields", async () => {
  await withStore(async (store) => {
    store.upsertJob(job());
    const [row] = store.listSchedules();
    expect(row).toBeDefined();
    expect(row!.id).toBe("daily-sales");
    expect(row!.name).toBe("Yesterday Sales");
    expect(row!.enabled).toBe(true);
    expect(row!.cron).toBe("0 6 * * *");
    expect(row!.lastStatus).toBeUndefined();
    expect(row!.lastRunAt).toBeUndefined();
    expect(row!.renderer).toBeUndefined();
  });
});

test("after a run, the schedule carries last-run status, duration and renderer", async () => {
  await withStore(async (store) => {
    const j = job();
    store.upsertJob(j);
    await runJob(j, store, tableFetcher);

    const [row] = store.listSchedules();
    expect(row!.lastStatus).toBe("completed");
    expect(row!.lastRunAt).toBeGreaterThan(0);
    expect(row!.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(row!.lastCacheHit).toBe(false);
    expect(row!.renderer).toBe("xlsx"); // terminal artifact type
  });
});

test("the schedule reflects only the LATEST run, not the first", async () => {
  await withStore(async (store) => {
    const j = job();
    store.upsertJob(j);
    await runJob(j, store, tableFetcher); // miss
    await runJob(j, store, tableFetcher); // hit (deterministic → cached)

    const rows = store.listSchedules();
    expect(rows).toHaveLength(1); // one row per job despite two runs
    expect(rows[0]!.lastCacheHit).toBe(true); // the second run was a cache hit
    expect(store.listRuns().length).toBe(2); // history still has both
  });
});

test("setJobEnabled toggles in place and 404s on an unknown id", async () => {
  await withStore(async (store) => {
    store.upsertJob(job({ enabled: true }));
    expect(store.setJobEnabled("daily-sales", false)).toBe(true);
    expect(store.listSchedules()[0]!.enabled).toBe(false);
    expect(store.setJobEnabled("daily-sales", true)).toBe(true);
    expect(store.listSchedules()[0]!.enabled).toBe(true);
    expect(store.setJobEnabled("ghost", true)).toBe(false);
  });
});

test("nextTick returns the next occurrence after now, and null for a manual cron", () => {
  const now = Date.UTC(2026, 5, 27, 12, 0, 0); // noon UTC
  const next = nextTick("0 6 * * *", now); // 06:00 daily → tomorrow 06:00
  expect(next).not.toBeNull();
  expect(next!).toBeGreaterThan(now);
  const d = new Date(next!);
  expect(d.getHours()).toBe(6); // croner interprets the cron in local time
  expect(nextTick("", now)).toBeNull(); // manual job never has a next tick
});
