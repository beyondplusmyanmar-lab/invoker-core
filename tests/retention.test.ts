import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import {
  planArtifactCleanup,
  runCleanup,
  maybeMaintain,
  type ArtifactBrief,
  type RetentionPolicy,
} from "../src/core/retention.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  maxArtifacts: 1000,
  maxDiskBytes: 1e12,
  maxNotifications: 1000,
  ...over,
});

// --- pure planning -------------------------------------------------------------

test("planArtifactCleanup evicts oldest-first until BOTH budgets are satisfied", () => {
  const briefs: ArtifactBrief[] = [
    { id: "old", path: "/a", size: 100, createdAt: 1 },
    { id: "mid", path: "/b", size: 100, createdAt: 2 },
    { id: "new", path: "/c", size: 100, createdAt: 3 },
  ];
  // Count budget: keep 1 → evict the two oldest.
  const byCount = planArtifactCleanup(briefs, policy({ maxArtifacts: 1 }));
  expect(byCount.evict.map((a) => a.id)).toEqual(["old", "mid"]);
  expect(byCount.bytesFreed).toBe(200);

  // Disk budget: keep ≤150 bytes → evict oldest until total ≤150 (one left = 100).
  const byBytes = planArtifactCleanup(briefs, policy({ maxDiskBytes: 150 }));
  expect(byBytes.evict.map((a) => a.id)).toEqual(["old", "mid"]);

  // Under budget → evict nothing.
  expect(planArtifactCleanup(briefs, policy()).evict).toHaveLength(0);
});

// --- integration over a real store --------------------------------------------

const fetcher = (item: string): FetchProvider => ({
  async fetchJson() {
    return { sheet: "S", columns: [{ id: "i", header: "I" }], rows: [[item]] };
  },
});

function job(id: string): ScheduledJob {
  return {
    id,
    name: id,
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
  const dir = mkdtempSync(join(tmpdir(), "invoker-retention-"));
  const store = new Store(dir);
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runCleanup evicts over-budget artifacts and removes their files + rows", async () => {
  await withStore(async (store) => {
    // Three distinct artifacts (distinct content → distinct sha).
    const paths: string[] = [];
    for (const item of ["Tea", "Coffee", "Cocoa"]) {
      const j = job(`j-${item}`);
      store.upsertJob(j);
      const r = await runJob(j, store, fetcher(item));
      paths.push(r.artifact!.path);
    }
    expect(store.countArtifacts()).toBe(3);

    const report = runCleanup(store, policy({ maxArtifacts: 1 }));
    expect(report.artifactsDeleted).toBe(2);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(store.countArtifacts()).toBe(1);
    // The two oldest files are gone; the newest remains.
    expect(existsSync(paths[0]!)).toBe(false);
    expect(existsSync(paths[2]!)).toBe(true);
  });
});

test("dry-run reports what WOULD be removed without touching anything", async () => {
  await withStore(async (store) => {
    const j = job("j");
    store.upsertJob(j);
    const r = await runJob(j, store, fetcher("Tea"));

    const report = runCleanup(store, policy({ maxArtifacts: 0 }), { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.artifactsDeleted).toBe(1);
    expect(store.countArtifacts()).toBe(1); // untouched
    expect(existsSync(r.artifact!.path)).toBe(true);
  });
});

test("trimNotifications keeps the newest N", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      store.recordNotification({ eventId: `e${i}`, title: `t${i}`, body: "", type: "HQ", receivedAt: 1000 + i });
    }
    const report = runCleanup(store, policy({ maxNotifications: 2 }));
    expect(report.notificationsDeleted).toBe(3);
    expect(store.countNotifications()).toBe(2);
    // Newest survive.
    expect(store.listNotifications().map((n) => n.eventId)).toEqual(["e4", "e3"]);
  });
});

test("maybeMaintain is gated: runs once, then no-ops until the interval elapses", async () => {
  await withStore(async (store) => {
    const j = job("j");
    store.upsertJob(j);
    await runJob(j, store, fetcher("Tea"));

    const t0 = 1_000_000_000_000;
    const first = maybeMaintain(store, policy({ maxArtifacts: 0 }), t0);
    expect(first.cleanup?.artifactsDeleted).toBe(1);
    expect(first.vacuumed).toBe(true); // never vacuumed before

    // Immediately again → both gated off.
    const second = maybeMaintain(store, policy({ maxArtifacts: 0 }), t0 + 1000);
    expect(second.cleanup).toBeUndefined();
    expect(second.vacuumed).toBe(false);

    // An hour later → cleanup runs again (nothing left to delete), vacuum still gated.
    const later = maybeMaintain(store, policy({ maxArtifacts: 0 }), t0 + 3_600_001);
    expect(later.cleanup).toBeDefined();
    expect(later.vacuumed).toBe(false);
  });
});
