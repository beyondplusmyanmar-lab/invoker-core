import { test, expect } from "bun:test";
import {
  enforceInputLimits,
  largestArrayLength,
  InputTooLargeError,
  DEFAULT_LIMITS,
} from "../src/core/limits.ts";

test("largestArrayLength finds the longest top-level array, shape-agnostically", () => {
  expect(largestArrayLength([1, 2, 3])).toBe(3);
  expect(largestArrayLength({ orders: [1, 2], notes: [1] })).toBe(2); // {orders:[...]} fetch shape
  expect(largestArrayLength({ rows: [1, 2, 3, 4] })).toBe(4); // {rows:[...]} render shape
  expect(largestArrayLength({ a: 1, b: "x" })).toBe(0);
  expect(largestArrayLength(null)).toBe(0);
});

test("input under both ceilings passes", () => {
  expect(() => enforceInputLimits({ orders: [1, 2, 3] })).not.toThrow();
});

test("too many rows is rejected with INPUT_TOO_LARGE", () => {
  const data = { orders: Array.from({ length: 11 }, (_, i) => i) };
  expect(() => enforceInputLimits(data, { ...DEFAULT_LIMITS, maxRows: 10 })).toThrow(InputTooLargeError);
  try {
    enforceInputLimits(data, { ...DEFAULT_LIMITS, maxRows: 10 });
  } catch (e) {
    expect((e as InputTooLargeError).code).toBe("INPUT_TOO_LARGE");
  }
});

test("too many bytes is rejected with INPUT_TOO_LARGE", () => {
  const data = { blob: "x".repeat(1000) };
  expect(() => enforceInputLimits(data, { ...DEFAULT_LIMITS, maxBytes: 100 })).toThrow(InputTooLargeError);
});
