import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { runJob } from "../src/core/runner.ts";
import { registry } from "../src/core/registry.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

// A fake fetcher: returns generic sheet data, never touches the network.
const fakeFetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "Sales", columns: ["Item", "Qty"], rows: [["Tea", 10], ["Coffee", 5]] };
  },
};

const job: ScheduledJob = {
  id: "daily-sales",
  name: "Daily Sales",
  capability: "excel.render",
  contractVersion: 1,
  source: "https://example.test/api/sales",
  cron: "0 8 * * *",
  policy: SchedulePolicy.CatchUp,
  maxLagMs: 24 * 60 * 60 * 1000,
  enabled: true,
};

let dir: string;
beforeEach(() => {
  if (!registry.has(excelRender.id, excelRender.contractVersion)) registry.register(excelRender);
});

test("runJob fetches, renders, and records run + scheduler state", async () => {
  dir = mkdtempSync(join(tmpdir(), "invoker-runner-"));
  const store = new Store(dir);
  try {
    const result = await runJob(job, store, fakeFetcher);
    expect(result.dryRun).toBe(false);
    expect(result.cacheHit).toBe(false);
    expect(result.artifact?.type).toBe("xlsx");

    const state = store.getSchedulerState(job.id);
    expect(state.lastStatus).toBe("completed");
    expect(state.lastRunAt).toBeGreaterThan(0);

    // Second run with identical fetched data → cache hit (ADR-006 cacheKey).
    const again = await runJob(job, store, fakeFetcher);
    expect(again.cacheHit).toBe(true);
    expect(again.artifact?.artifactSha256).toBe(result.artifact?.artifactSha256);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runJob without a fetcher but with a source fails loudly and records failure", async () => {
  dir = mkdtempSync(join(tmpdir(), "invoker-runner-"));
  const store = new Store(dir);
  try {
    await expect(runJob(job, store, undefined)).rejects.toThrow(/FetchProvider/);
    expect(store.getSchedulerState(job.id).lastStatus).toBe("failed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
