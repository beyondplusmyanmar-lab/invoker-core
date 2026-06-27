import { test, expect } from "bun:test";
import { renderWorkbook } from "../src/engines/excel/index.ts";
import { sha256Hex } from "../src/core/hash.ts";

// Regression for the MacBook P1a finding: rendering must be byte-identical regardless of the
// host timezone, and must never crash. Pre-fix, fflate encoded the zip mtime (and exceljs date
// cells) in LOCAL time, so a +8 host and a -8 host produced different artifacts and a -8 host
// CRASHED ("date not in range 1980-2099", the 1980 zip epoch underflowing to 1979).
// renderWorkbook now pins the runtime to UTC, so all of these collapse to one sha.

const model = {
  sheet: "S",
  columns: [{ header: "X" }, { header: "N" }],
  rows: [
    ["a", 1],
    ["b", 2],
  ],
};

async function shaUnder(tz: string): Promise<string> {
  const prev = process.env.TZ;
  process.env.TZ = tz; // simulate a host in this zone before the render
  try {
    return sha256Hex(await renderWorkbook(model)); // re-pins to UTC internally
  } finally {
    process.env.TZ = prev;
  }
}

test("render is byte-identical across host timezones (and never crashes west of UTC)", async () => {
  const utc = await shaUnder("UTC");
  const la = await shaUnder("America/Los_Angeles"); // the pre-fix crash zone
  const kul = await shaUnder("Asia/Kuala_Lumpur"); // +8 (the laptop)
  const kir = await shaUnder("Pacific/Kiritimati"); // +14 (extreme east)
  expect(la).toBe(utc);
  expect(kul).toBe(utc);
  expect(kir).toBe(utc);
});
