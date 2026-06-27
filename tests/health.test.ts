import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { ExecutionCoordinator } from "../src/core/execution.ts";
import { buildHealthReport, gatherHealth, type HealthInputs } from "../src/core/health.ts";
import { DEFAULT_LIMITS } from "../src/core/limits.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

const baseInputs = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  version: "0.2.0-beta",
  now: 1_000_000,
  stalenessMs: 600_000,
  coordinator: { pending: 0, queueLimit: 10, timeoutMs: 300_000, maxRows: 50_000, maxBytes: 1e8, collapses24h: 0 },
  artifacts: { count: 0, diskBytes: 0 },
  cacheHitRatio: 0,
  dbOk: true,
  ...over,
});

// --- pure status derivation ----------------------------------------------------

test("a fresh notifications heartbeat reads connected; an old one reads stale", () => {
  const fresh = buildHealthReport(baseInputs({ notifications: { status: "connected", lastSeen: 950_000 } }));
  expect(fresh.notifications.status).toBe("connected");

  const old = buildHealthReport(baseInputs({ notifications: { status: "connected", lastSeen: 100_000 } }));
  expect(old.notifications.status).toBe("stale"); // >10m old

  const down = buildHealthReport(baseInputs({ notifications: { status: "disconnected", lastSeen: 990_000 } }));
  expect(down.notifications.status).toBe("disconnected");

  const none = buildHealthReport(baseInputs());
  expect(none.notifications.status).toBe("absent");
});

test("scheduler status reflects the daemon heartbeat + live probe", () => {
  const hb = { pid: 1, startedAt: 0, lastTickAt: 990_000, ticks: 5, status: "running" as const };
  expect(buildHealthReport(baseInputs({ daemon: hb, daemonAlive: true })).scheduler.status).toBe("running");
  expect(buildHealthReport(baseInputs({ daemon: hb, daemonAlive: false })).scheduler.status).toBe("stopped");
  expect(buildHealthReport(baseInputs()).scheduler.status).toBe("absent");
});

test("overall ok tracks DB integrity", () => {
  expect(buildHealthReport(baseInputs({ dbOk: true })).ok).toBe(true);
  const bad = buildHealthReport(baseInputs({ dbOk: false }));
  expect(bad.ok).toBe(false);
  expect(bad.db).toBe("error");
});

// --- integration over a real store --------------------------------------------

const fetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "Sales", columns: [{ id: "item", header: "Item" }], rows: [["Tea"]] };
  },
};

function job(): ScheduledJob {
  return {
    id: "daily",
    name: "Yesterday Sales",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

async function withStore<T>(fn: (store: Store, dir: string) => Promise<T>): Promise<T> {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
  const dir = mkdtempSync(join(tmpdir(), "invoker-health-"));
  const store = new Store(dir);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gatherHealth reports artifacts, last report, cache ratio, and a healthy DB after a run", async () => {
  await withStore(async (store, dir) => {
    const j = job();
    store.upsertJob(j);
    await runJob(j, store, fetcher); // miss
    await runJob(j, store, fetcher); // hit (deterministic → cached)

    const r = gatherHealth(store, { version: "0.2.0-beta", limits: DEFAULT_LIMITS, queueLimit: 10, workspaceDir: dir });
    expect(r.db).toBe("ok");
    expect(r.ok).toBe(true);
    expect(r.artifacts.count).toBe(1);
    expect(r.artifacts.diskBytes).toBeGreaterThan(0);
    expect(r.lastReport!.job).toBe("Yesterday Sales");
    expect(r.lastReport!.renderer).toBe("xlsx");
    expect(r.cacheHitRatio).toBeCloseTo(0.5); // one miss, one hit
    expect(r.diskFreeBytes).toBeGreaterThan(0);
  });
});

test("collapsed concurrent runs surface as collapses24h on the health report", async () => {
  await withStore(async (store, dir) => {
    const j = job();
    store.upsertJob(j);
    const coordinator = new ExecutionCoordinator();
    // Three at once → 1 renders, 2 collapse.
    await Promise.all([
      runJob(j, store, fetcher, { coordinator }),
      runJob(j, store, fetcher, { coordinator }),
      runJob(j, store, fetcher, { coordinator }),
    ]);
    const r = gatherHealth(store, { version: "0.2.0-beta", limits: DEFAULT_LIMITS, queueLimit: 10, workspaceDir: dir });
    expect(r.coordinator.collapses24h).toBe(2);
  });
});

test("a notifications heartbeat written to the store shows up in gatherHealth", async () => {
  await withStore(async (store, dir) => {
    store.setServiceHeartbeat("notifications", "connected", "2 channels");
    const r = gatherHealth(store, { version: "0.2.0-beta", limits: DEFAULT_LIMITS, queueLimit: 10, workspaceDir: dir });
    expect(r.notifications.status).toBe("connected");
    expect(r.notifications.detail).toBe("2 channels");
  });
});
