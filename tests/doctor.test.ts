import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import { runDoctor, gteVersion, type DoctorReport } from "../src/core/doctor.ts";

async function withStore<T>(fn: (store: Store, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "invoker-doctor-"));
  const store = new Store(dir);
  if (!registry.has(excelRender.id, excelRender.contractVersion)) registry.register(excelRender);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const find = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name)!;

test("gteVersion compares dotted versions", () => {
  expect(gteVersion("1.2.0", "1.1.0")).toBe(true);
  expect(gteVersion("1.1.0", "1.1.0")).toBe(true);
  expect(gteVersion("1.0.9", "1.1.0")).toBe(false);
  expect(gteVersion("2.0.0", "1.9.9")).toBe(true);
});

test("healthy workspace: determinism ✓, relay ⚠, no failures", async () => {
  await withStore(async (store, dir) => {
    const r = await runDoctor({ workspace: dir, store, registry, bunVersion: "1.2.0" });

    expect(find(r, "bun").status).toBe("ok");
    expect(find(r, "sqlite").status).toBe("ok");
    expect(find(r, "capabilities").status).toBe("ok");
    expect(find(r, "determinism").status).toBe("ok"); // excel.render ×10
    expect(find(r, "relay").status).toBe("warn"); // P3 not built
    expect(find(r, "secrets").status).toBe("warn"); // no token ref
    expect(find(r, "daemon").status).toBe("ok"); // not running is fine
    expect(r.ok).toBe(true); // warnings don't fail the sweep
  });
});

test("--strict escalates warnings (relay, secrets) to failure", async () => {
  await withStore(async (store, dir) => {
    const lenient = await runDoctor({ workspace: dir, store, registry, bunVersion: "1.2.0" });
    expect(lenient.ok).toBe(true); // warnings tolerated

    const strict = await runDoctor({ workspace: dir, store, registry, bunVersion: "1.2.0", strict: true });
    expect(strict.strict).toBe(true);
    expect(strict.ok).toBe(false); // relay + secrets warnings now fail
    // individual check statuses are unchanged; only the verdict tightens
    expect(find(strict, "relay").status).toBe("warn");
  });
});

test("inline secret is an ADR-005 failure", async () => {
  await withStore(async (store, dir) => {
    const r = await runDoctor({ workspace: dir, store, registry, tokenRef: "sk_live_abc123" });
    expect(find(r, "secrets").status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

test("a resolvable env reference passes the secrets check", async () => {
  process.env.INVOKER_DOCTOR_TEST_TOKEN = "shhh";
  try {
    await withStore(async (store, dir) => {
      const r = await runDoctor({
        workspace: dir,
        store,
        registry,
        tokenRef: "env:INVOKER_DOCTOR_TEST_TOKEN",
      });
      expect(find(r, "secrets").status).toBe("ok");
    });
  } finally {
    delete process.env.INVOKER_DOCTOR_TEST_TOKEN;
  }
});

test("an invalid cron fails the scheduler check", async () => {
  await withStore(async (store, dir) => {
    const bad: ScheduledJob = {
      id: "bad",
      name: "bad",
      capability: "excel.render",
      contractVersion: 1,
      cron: "not a cron expression",
      policy: SchedulePolicy.CatchUp,
      maxLagMs: 1000,
      enabled: true,
    };
    store.upsertJob(bad);
    const r = await runDoctor({ workspace: dir, store, registry, bunVersion: "1.2.0" });
    expect(find(r, "scheduler").status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});
