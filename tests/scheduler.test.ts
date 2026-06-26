import { test, expect } from "bun:test";
import { decideRun, SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";

const HOUR = 60 * 60 * 1000;

function job(policy: SchedulePolicy, maxLagMs = 2 * HOUR): ScheduledJob {
  return {
    id: "j1",
    name: "daily",
    capability: "excel.render",
    contractVersion: 1,
    cron: "0 8 * * *",
    policy,
    maxLagMs,
    enabled: true,
  };
}

const NOW = 1_000_000_000_000;
const TICK = NOW - 30 * 60 * 1000; // a tick 30 minutes ago (within lag)
const STALE_TICK = NOW - 6 * HOUR; // a tick 6 hours ago (beyond 2h lag)

test("disabled job never runs", () => {
  const j = { ...job(SchedulePolicy.CatchUp), enabled: false };
  expect(decideRun(j, TICK, {}, NOW).run).toBe(false);
});

test("a tick already satisfied does not re-run", () => {
  const r = decideRun(job(SchedulePolicy.CatchUp), TICK, { lastRunAt: TICK + 1 }, NOW);
  expect(r.run).toBe(false);
});

test("Skip: runs on-time, drops a stale tick", () => {
  expect(decideRun(job(SchedulePolicy.Skip), TICK, {}, NOW).run).toBe(true);
  expect(decideRun(job(SchedulePolicy.Skip), STALE_TICK, {}, NOW).run).toBe(false);
});

test("CatchUp: runs within maxLag, drops beyond maxLag", () => {
  expect(decideRun(job(SchedulePolicy.CatchUp), TICK, {}, NOW).run).toBe(true);
  expect(decideRun(job(SchedulePolicy.CatchUp), STALE_TICK, {}, NOW).run).toBe(false);
});

test("Resume: runs a missed tick no matter how stale", () => {
  expect(decideRun(job(SchedulePolicy.Resume), STALE_TICK, {}, NOW).run).toBe(true);
});
