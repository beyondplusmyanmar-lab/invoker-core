import { test, expect } from "bun:test";
import { renderDocument, docxRender } from "../src/engines/docx/index.ts";
import { assertDeterministic } from "../src/engines/conformance.ts";
import { unzipSync, strFromU8 } from "fflate";

const SAMPLE = {
  sheet: "Sales",
  columns: [
    { id: "item", header: "Item" },
    { id: "qty", header: "Qty", type: "number" },
    { id: "price", header: "Price", type: "currency" },
  ],
  rows: [
    ["Tea", 10, 1200],
    ["Coffee", 5, 1500],
    ["Water", 20, 500],
  ],
};

// ADR-007: determinism is tested, not assumed — and at ×10 to catch intermittent drift.
test("docx.render is byte-deterministic across 10 passes", async () => {
  const result = await assertDeterministic(async () => renderDocument(SAMPLE), 10);
  expect(result.hashes.length).toBe(10);
  expect(result.ok).toBe(true);
});

// An engine that claims deterministic:true must back the claim.
test("docxRender descriptor matches its conformance", async () => {
  expect(docxRender.deterministic).toBe(true);
  const result = await assertDeterministic(async () => renderDocument(SAMPLE), 10);
  expect(result.ok).toBe(docxRender.deterministic);
});

// The output is a real OOXML package: a zip carrying the three required parts, with the data
// surfaced as table cell text. Guards against "deterministic but empty/invalid".
test("docx.render emits a valid WordprocessingML package containing the data", () => {
  const parts = unzipSync(renderDocument(SAMPLE));
  expect(Object.keys(parts).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const doc = strFromU8(parts["word/document.xml"]!);
  expect(doc).toContain("<w:tbl>");
  expect(doc).toContain("Item"); // header cell
  expect(doc).toContain("Coffee"); // data cell
  expect(doc).toContain("Sales"); // heading from `sheet`
});

// XML-unsafe cell content must be escaped, or the package is corrupt (and nondeterministic risk).
test("docx.render escapes XML metacharacters in cells", () => {
  const doc = strFromU8(
    unzipSync(
      renderDocument({ columns: [{ id: "x", header: "X" }], rows: [["A & B < C > D"]] }),
    )["word/document.xml"]!,
  );
  expect(doc).toContain("A &amp; B &lt; C &gt; D");
  expect(doc).not.toContain("A & B");
});
