import { test, expect } from "bun:test";
import { mapToTable, resolvePath, coerce, type Mapping } from "../src/engines/tabular/index.ts";

test("resolvePath handles dotted and indexed paths", () => {
  const obj = { customer: { name: "John" }, items: [{ price: 100 }, { price: 200 }] };
  expect(resolvePath(obj, "customer.name")).toBe("John");
  expect(resolvePath(obj, "items[1].price")).toBe(200);
  expect(resolvePath(obj, "missing.deep.path")).toBeUndefined();
});

test("coerce is conservative and deterministic", () => {
  expect(coerce("100", "number")).toBe(100);
  expect(coerce(100, "string")).toBe("100");
  expect(coerce("2026-06-26T00:00:00.000Z", "date")).toBe("2026-06-26T00:00:00.000Z");
  expect(coerce(null, "number")).toBeNull();
});

test("mapToTable extracts records into a TableModel with defaults applied", () => {
  const input = {
    orders: [
      { id: "O1", customer: { name: "John" }, total: 100 },
      { id: "O2", customer: { name: "Jane" } }, // missing total → default
    ],
  };
  const mapping: Mapping = {
    source: "orders",
    sheet: "Orders",
    columns: [
      { header: "Order", path: "id" },
      { header: "Customer", path: "customer.name" },
      { header: "Total", path: "total", type: "currency", default: 0 },
    ],
  };
  const table = mapToTable(input, mapping);
  expect(table.columns.map((c) => c.header)).toEqual(["Order", "Customer", "Total"]);
  expect(table.rows).toEqual([
    ["O1", "John", 100],
    ["O2", "Jane", 0],
  ]);
  expect(table.sheet).toBe("Orders");
});

test("mapToTable throws when source is not an array", () => {
  expect(() => mapToTable({ orders: {} }, { source: "orders", columns: [] })).toThrow(/array/);
});
