import { test, expect } from "bun:test";
import { nextTick } from "../src/core/runner.ts";

/**
 * Regression: `renderWorkbook` permanently sets `process.env.TZ = "UTC"` for artifact determinism.
 * croner reads the ambient zone, so the scheduler used to drift by the local UTC offset after the
 * first render — a "0 6 * * *" morning report jumped from 6am local to 6am UTC mid-pilot. The fix
 * pins cron evaluation to an explicit zone, immune to that mutation.
 */
test("cron evaluation is immune to a render flipping process.env.TZ to UTC", () => {
  const now = Date.parse("2026-06-27T11:57:00Z"); // 19:57 in Kuala Lumpur (+8)
  const saved = process.env.TZ;
  process.env.TZ = "UTC"; // simulate the post-render daemon state
  try {
    // With the shop zone pinned, "0 6 * * *" is 6am LOCAL (= 22:00Z), regardless of process.env.TZ.
    // The pre-fix code read the ambient (now UTC) zone and returned 06:00Z — the 8-hour drift.
    expect(new Date(nextTick("0 6 * * *", now, "Asia/Kuala_Lumpur")!).toISOString()).toBe(
      "2026-06-27T22:00:00.000Z",
    );
    // Anchor: the same expr in UTC really is 06:00Z — proving the zone is what moved it.
    expect(new Date(nextTick("0 6 * * *", now, "UTC")!).toISOString()).toBe(
      "2026-06-28T06:00:00.000Z",
    );
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("a manual (empty) cron has no next tick", () => {
  expect(nextTick("", Date.now())).toBeNull();
});
