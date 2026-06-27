import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { runDoctor, runPilotCheck, gteVersion, type DoctorReport, type DoctorDeps } from "../src/core/doctor.ts";
import { DEFAULT_LIMITS } from "../src/core/limits.ts";
import { DEFAULT_RETENTION } from "../src/core/retention.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

function deps(store: Store, dir: string, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    workspace: dir,
    store,
    registry,
    version: "0.2.0-rc1",
    limits: DEFAULT_LIMITS,
    retention: DEFAULT_RETENTION,
    queueLimit: 10,
    ...over,
  };
}

async function withStore<T>(fn: (store: Store, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "invoker-doctor-"));
  const store = new Store(dir);
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const fetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "S", columns: [{ id: "i", header: "I" }], rows: [["Tea"]] };
  },
};
const find = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name)!;

test("gteVersion compares dotted versions", () => {
  expect(gteVersion("1.2.0", "1.1.0")).toBe(true);
  expect(gteVersion("1.0.9", "1.1.0")).toBe(false);
});

test("a healthy workspace PASSes: sqlite/determinism/store ok, no hard fault", async () => {
  await withStore(async (store, dir) => {
    const r = await runDoctor(deps(store, dir));
    expect(find(r, "SQLite").status).toBe("ok");
    expect(find(r, "Determinism").status).toBe("ok"); // excel.render ×10
    expect(find(r, "Artifact Store").status).toBe("ok");
    expect(find(r, "Disk").status).toBe("ok");
    expect(find(r, "Scheduler").status).toBe("warn"); // daemon not running
    expect(find(r, "Scheduler").suggestion).toBe("invoker daemon start");
    expect(r.ok).toBe(true); // warnings don't fail the default sweep
  });
});

test("--strict escalates warnings to FAIL", async () => {
  await withStore(async (store, dir) => {
    expect((await runDoctor(deps(store, dir))).ok).toBe(true);
    const strict = await runDoctor(deps(store, dir, { strict: true }));
    expect(strict.ok).toBe(false); // the daemon-not-running warning now fails
  });
});

test("an inline secret is an ADR-005 hard failure", async () => {
  await withStore(async (store, dir) => {
    const r = await runDoctor(deps(store, dir, { tokenRef: "sk_live_abc123" }));
    expect(find(r, "Secrets").status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

test("an invalid cron fails the Scheduler check", async () => {
  await withStore(async (store, dir) => {
    const bad: ScheduledJob = {
      id: "bad", name: "bad", capability: "excel.render", contractVersion: 1,
      cron: "not a cron", policy: SchedulePolicy.CatchUp, maxLagMs: 1000, enabled: true,
    };
    store.upsertJob(bad);
    const r = await runDoctor(deps(store, dir));
    expect(find(r, "Scheduler").status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

test("Manifests/Reports fail when a rendered artifact is corrupted", async () => {
  await withStore(async (store, dir) => {
    const job: ScheduledJob = {
      id: "daily", name: "Daily", capability: "excel.render", contractVersion: 1,
      source: "x", cron: "", policy: SchedulePolicy.CatchUp, maxLagMs: 1000, enabled: true,
    };
    store.upsertJob(job);
    const r = await runJob(job, store, fetcher);
    expect(find(await runDoctor(deps(store, dir)), "Reports").status).toBe("ok");

    require("node:fs").writeFileSync(r.artifact!.path, "corrupt");
    const after = await runDoctor(deps(store, dir));
    expect(find(after, "Reports").status).toBe("fail");
    expect(find(after, "Manifests").status).toBe("fail");
    expect(after.ok).toBe(false);
  });
});

// --- pilot mode --------------------------------------------------------------

test("pilot gates are green on a clean run; window starts on first check", async () => {
  await withStore(async (store, dir) => {
    const t0 = 1_700_000_000_000;
    const job: ScheduledJob = {
      id: "daily", name: "Daily", capability: "excel.render", contractVersion: 1,
      source: "x", cron: "", policy: SchedulePolicy.CatchUp, maxLagMs: 1000, enabled: true,
    };
    store.upsertJob(job);
    await runJob(job, store, fetcher);

    const day0 = runPilotCheck(deps(store, dir, { now: t0 }));
    expect(day0.daysRunning).toBe(0);
    expect(day0.ok).toBe(true);
    expect(day0.passed).toBe(false); // window not elapsed
    expect(day0.gates.find((g) => g.name === "Duplicate renders")!.value).toBe("0");

    // Seven days later, still clean → PILOT PASSED.
    const day7 = runPilotCheck(deps(store, dir, { now: t0 + 7 * 86_400_000 }));
    expect(day7.daysRunning).toBe(7);
    expect(day7.passed).toBe(true);
  });
});

test("a corrupt artifact trips the pilot's Corrupt artifacts gate", async () => {
  await withStore(async (store, dir) => {
    const job: ScheduledJob = {
      id: "daily", name: "Daily", capability: "excel.render", contractVersion: 1,
      source: "x", cron: "", policy: SchedulePolicy.CatchUp, maxLagMs: 1000, enabled: true,
    };
    store.upsertJob(job);
    const r = await runJob(job, store, fetcher);
    require("node:fs").writeFileSync(r.artifact!.path, "corrupt");

    const pilot = runPilotCheck(deps(store, dir));
    expect(pilot.ok).toBe(false);
    expect(pilot.gates.find((g) => g.name === "Corrupt artifacts")!.ok).toBe(false);
  });
});
