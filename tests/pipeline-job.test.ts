import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { FileFetchProvider } from "../src/core/fetch.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";

function ensureCaps() {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
}

test("a pipeline job (file: source → tabular.map → excel.render) produces an artifact and caches", async () => {
  ensureCaps();
  const dir = mkdtempSync(join(tmpdir(), "invoker-pjob-"));
  const fixture = join(dir, "orders.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      orders: [
        { id: "A1", total: 100, status: "paid" },
        { id: "A2", total: 250, status: "paid" },
      ],
    }),
  );
  const mapping = {
    source: "orders",
    sheet: "Daily Sales",
    columns: [
      { header: "Order", path: "id" },
      { header: "Total", path: "total", type: "number", default: 0 },
      { header: "Status", path: "status" },
    ],
  };
  const job: ScheduledJob = {
    id: "daily-sales",
    name: "Daily Sales",
    capability: "excel.render", // terminal capability, for run records
    contractVersion: 1,
    source: `file:${fixture}`,
    steps: [
      { capability: "tabular.map", contractVersion: 1, params: mapping },
      { capability: "excel.render", contractVersion: 1 },
    ],
    cron: "", // unscheduled, manual run
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 1000,
    enabled: true,
  };

  const store = new Store(dir);
  try {
    const first = await runJob(job, store, new FileFetchProvider());
    expect(first.cacheHit).toBe(false);
    expect(first.artifact?.type).toBe("xlsx");
    expect(first.artifact?.artifactSha256).toBeTruthy();

    // Re-run with the same fixture → identical cacheKey → cache hit (ADR-006 + determinism).
    const second = await runJob(job, store, new FileFetchProvider());
    expect(second.cacheHit).toBe(true);
    expect(second.artifact?.artifactSha256).toBe(first.artifact?.artifactSha256);

    expect(store.getSchedulerState("daily-sales").lastStatus).toBe("completed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
