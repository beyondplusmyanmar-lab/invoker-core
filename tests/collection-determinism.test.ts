import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runPipeline, type PipelineStep } from "../src/core/pipeline.ts";

function ensureCaps() {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
}

const steps: PipelineStep[] = [
  {
    capability: "tabular.map",
    contractVersion: 1,
    params: {
      source: "rows",
      sheet: "S",
      columns: [
        { header: "A", path: "a", type: "number" },
        { header: "B", path: "b" },
      ],
    },
  },
  { capability: "excel.render", contractVersion: 1 },
];

async function sha(rows: unknown[], store: Store): Promise<string> {
  const r = await runPipeline(steps, { rows }, store);
  return r.artifact!.artifactSha256;
}

// PENDING ADR-011 — runtime-owned collection determinism (table.sort@v1).
//
// Today the pipeline preserves the upstream row order, so permuting the collection yields a
// DIFFERENT artifact: the runtime is deterministic w.r.t. a stable TableModel, not yet w.r.t.
// a logical collection. This test asserts the FUTURE invariant
//     ∀ permutations P:  artifact(P(collection)) == artifact(collection)
// and is marked `test.failing` so it documents the target without breaking the suite. When
// table.sort@v1 (with a total-order tiebreak) lands, this will start passing and `test.failing`
// will flip it to a real failure — the signal to delete this marker and celebrate L3.
test.failing("artifact is invariant under row permutation (pending ADR-011)", async () => {
  ensureCaps();
  const dir = mkdtempSync(join(tmpdir(), "invoker-coldet-"));
  const store = new Store(dir);
  try {
    const original = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
      { a: 3, b: "z" },
    ];
    const shuffled = [
      { a: 3, b: "z" },
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    expect(await sha(shuffled, store)).toBe(await sha(original, store));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
