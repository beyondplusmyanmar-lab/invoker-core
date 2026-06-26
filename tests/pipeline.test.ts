import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { registry } from "../src/core/registry.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";

// Mirrors the doeh/daily-sales shape: operational JSON → tabular.map → TableModel → xlsx.
const FACTS = {
  orders: [
    { id: "O1", customer: { name: "John" }, total: 1200, status: "completed" },
    { id: "O2", customer: { name: "Jane" }, total: 800, status: "completed" },
  ],
};

const MAPPING = {
  source: "orders",
  sheet: "Daily Sales",
  columns: [
    { header: "Order", path: "id" },
    { header: "Customer", path: "customer.name" },
    { header: "Total", path: "total", type: "currency", default: 0 },
    { header: "Status", path: "status" },
  ],
};

beforeEach(() => {
  for (const cap of [tabularMap, excelRender]) {
    if (!registry.has(cap.id, cap.contractVersion)) registry.register(cap);
  }
});

function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "invoker-pipe-"));
  const store = new Store(dir);
  return fn(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("map → render pipeline produces a deterministic artifact and caches on re-run", async () => {
  await withStore(async (store) => {
    const steps = [
      { capability: "tabular.map", contractVersion: 1, params: MAPPING },
      { capability: "excel.render", contractVersion: 1 },
    ];

    const first = await runPipeline(steps, FACTS, store);
    expect(first.artifact?.type).toBe("xlsx");
    expect(first.cacheHit).toBe(false);
    const sha = first.artifact!.artifactSha256;

    // Same facts + same mapping → identical artifact, served from cache.
    const second = await runPipeline(steps, FACTS, store);
    expect(second.cacheHit).toBe(true);
    expect(second.artifact!.artifactSha256).toBe(sha);
  });
});

test("a different mapping on the same facts is a distinct cache key (not a false hit)", async () => {
  await withStore(async (store) => {
    const base = await runPipeline(
      [
        { capability: "tabular.map", contractVersion: 1, params: MAPPING },
        { capability: "excel.render", contractVersion: 1 },
      ],
      FACTS,
      store,
    );
    const altMapping = { ...MAPPING, columns: MAPPING.columns.slice(0, 2) };
    const alt = await runPipeline(
      [
        { capability: "tabular.map", contractVersion: 1, params: altMapping },
        { capability: "excel.render", contractVersion: 1 },
      ],
      FACTS,
      store,
    );
    expect(alt.cacheHit).toBe(false);
    expect(alt.artifact!.artifactSha256).not.toBe(base.artifact!.artifactSha256);
  });
});
