import { test, expect } from "bun:test";
import { renderWorkbook, excelRender } from "../src/engines/excel/index.ts";
import { assertDeterministic } from "../src/engines/conformance.ts";

const SAMPLE = {
  sheet: "Sales",
  columns: ["Item", "Qty", "Price"],
  rows: [
    ["Tea", 10, 1200],
    ["Coffee", 5, 1500],
    ["Water", 20, 500],
  ],
};

// ADR-007: determinism is tested, not assumed — and at ×10 to catch intermittent drift.
test("excel.render is byte-deterministic across 10 passes", async () => {
  const result = await assertDeterministic(() => renderWorkbook(SAMPLE), 10);
  expect(result.hashes.length).toBe(10);
  expect(result.ok).toBe(true);
});

// An engine that claims deterministic:true must back the claim.
test("excelRender descriptor matches its conformance", async () => {
  expect(excelRender.deterministic).toBe(true);
  const result = await assertDeterministic(() => renderWorkbook(SAMPLE), 10);
  expect(result.ok).toBe(excelRender.deterministic);
});
