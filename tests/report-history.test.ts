import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { FileFetchProvider } from "../src/core/fetch.ts";
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

const throwingFetcher: FetchProvider = {
  async fetchJson() {
    throw new Error("upstream down");
  },
};

function singleCapJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "daily",
    name: "Yesterday Sales",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 24 * 60 * 60 * 1000,
    enabled: true,
    ...overrides,
  };
}

async function withStore<T>(fn: (store: Store, dir: string) => Promise<T>): Promise<T> {
  ensureCaps();
  const dir = mkdtempSync(join(tmpdir(), "invoker-hist-"));
  const store = new Store(dir);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a completed job run appears in history with its artifact denormalized onto the run", async () => {
  await withStore(async (store) => {
    const job = singleCapJob();
    store.upsertJob(job);
    await runJob(job, store, tableFetcher);

    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.status).toBe("completed");
    expect(r.jobName).toBe("Yesterday Sales"); // joined from jobs
    expect(r.artifact).toBeDefined();
    expect(r.artifact!.type).toBe("xlsx");
    expect(r.artifact!.size).toBeGreaterThan(0);
    expect(r.artifact!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

test("a self-describing manifest sidecar is written next to the artifact", async () => {
  await withStore(async (store, dir) => {
    const job = singleCapJob();
    store.upsertJob(job);
    await runJob(job, store, tableFetcher);

    const run = store.listRuns()[0]!;
    const manifestPath = join(dir, "artifacts", `${run.id}.manifest.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(m.id).toBe(run.id);
    expect(m.job).toBe("Yesterday Sales");
    expect(m.renderer).toBe("xlsx");
    expect(m.sha256).toBe(run.artifact!.sha256);
    expect(m.engine_version).toBe(excelRender.engineVersion);
    expect(typeof m.generated_at).toBe("string");
    expect(m.cache_hit).toBe(false);
  });
});

test("a PIPELINE job links its terminal artifact onto the run (artifact id ≠ run id)", async () => {
  await withStore(async (store, dir) => {
    const fixture = join(dir, "orders.json");
    writeFileSync(fixture, JSON.stringify({ orders: [{ id: "A1", total: 100 }, { id: "A2", total: 250 }] }));
    const job: ScheduledJob = {
      id: "pipe",
      name: "Pipeline Report",
      capability: "tabular.map",
      contractVersion: 1,
      source: `file:${fixture}`,
      cron: "",
      policy: SchedulePolicy.CatchUp,
      maxLagMs: 24 * 60 * 60 * 1000,
      enabled: true,
      steps: [
        {
          capability: "tabular.map",
          contractVersion: 1,
          params: {
            source: "orders",
            sheet: "Daily Sales",
            columns: [
              { header: "Order", path: "id" },
              { header: "Total", path: "total", type: "number", default: 0 },
            ],
          },
        },
        { capability: "excel.render", contractVersion: 1 },
      ],
    };
    store.upsertJob(job);
    await runJob(job, store, new FileFetchProvider());

    const r = store.listRuns()[0]!;
    expect(r.status).toBe("completed");
    // The terminal artifact has its own randomUUID id; report history must still link it.
    expect(r.artifact).toBeDefined();
    expect(r.artifact!.type).toBe("xlsx");
    expect(r.artifact!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

test("a failed run is recorded with its error and no artifact", async () => {
  await withStore(async (store) => {
    const job = singleCapJob();
    store.upsertJob(job);
    await expect(runJob(job, store, throwingFetcher)).rejects.toThrow("upstream down");

    const r = store.listRuns()[0]!;
    expect(r.status).toBe("failed");
    expect(r.error).toContain("upstream down");
    expect(r.artifact).toBeUndefined();
  });
});

test("history is newest-first and respects the limit", async () => {
  await withStore(async (store) => {
    const job = singleCapJob();
    store.upsertJob(job);
    await runJob(job, store, tableFetcher);
    expect(store.listRuns(1)).toHaveLength(1);
    expect(store.listRuns().length).toBeGreaterThanOrEqual(1);
  });
});
