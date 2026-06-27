import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";
import { appendLog } from "../src/core/log.ts";
import { buildSupportBundle, redactEnv } from "../src/core/support.ts";

const FIXED_NOW = new Date("2026-06-27T09:00:00Z");

const fetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "Sales", columns: [{ id: "item", header: "Item" }], rows: [["Tea"], ["Coffee"]] };
  },
};

function job(): ScheduledJob {
  return {
    id: "daily",
    name: "Yesterday Sales",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

async function withSeededWorkspace(fn: (store: Store, dir: string) => Promise<void> | void) {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
  const dir = mkdtempSync(join(tmpdir(), "invoker-support-"));
  const store = new Store(dir);
  try {
    const j = job();
    store.upsertJob(j);
    await runJob(j, store, fetcher); // one real run → a manifest sidecar on disk
    appendLog(dir, "daemon start pid=1 interval=60000ms");
    await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const env = {
  INVOKER_HOME: "/home/op/.invoker",
  INVOKER_MAX_PENDING: "4",
  INVOKER_NOTIFY_URL: "wss://reverb.example.test",
  INVOKER_TOKEN_REF: "env:SECRET_SOURCE",
  INVOKER_NOTIFY_TOKEN_REF: "file:/etc/x",
  INVOKER_NOTIFY_KEY: "app-key-abc",
  PATH: "/usr/bin", // non-INVOKER: must be dropped
};

test("the bundle contains every expected entry, deterministically named", async () => {
  await withSeededWorkspace((store, dir) => {
    const b = buildSupportBundle({ workspace: dir, store, health: { ok: true }, doctor: { ok: true }, env, now: FIXED_NOW });
    expect(b.filename).toBe("support-20260627.zip");

    const files = unzipSync(b.bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      "artifacts/latest.manifest.json",
      "config.redacted.json",
      "doctor.json",
      "health.json",
      "logs/last100.log",
      "notifications.json",
      "runs.json",
      "schedules.json",
      "sqlite.db",
    ]);
    // sqlite.db is a real database snapshot, not the live file copy.
    expect(new TextDecoder().decode(files["sqlite.db"]!.slice(0, 15))).toBe("SQLite format 3");
    // the seeded run and schedule show up in the durable-state slices.
    expect(JSON.parse(new TextDecoder().decode(files["runs.json"]!)).length).toBeGreaterThan(0);
    expect(JSON.parse(new TextDecoder().decode(files["schedules.json"]!))[0].id).toBe("daily");
    expect(JSON.parse(new TextDecoder().decode(files["artifacts/latest.manifest.json"]!)).capability).toBe("excel.render");
    expect(new TextDecoder().decode(files["logs/last100.log"]!)).toContain("daemon start");
  });
});

test("config.redacted.json keeps INVOKER_* and masks secret-shaped values", async () => {
  await withSeededWorkspace((store, dir) => {
    const b = buildSupportBundle({ workspace: dir, store, health: {}, doctor: {}, env, now: FIXED_NOW });
    const cfg = JSON.parse(new TextDecoder().decode(unzipSync(b.bytes)["config.redacted.json"]!));
    expect(cfg.INVOKER_MAX_PENDING).toBe("4");
    expect(cfg.INVOKER_NOTIFY_URL).toBe("wss://reverb.example.test");
    expect(cfg.INVOKER_TOKEN_REF).toBe("***");
    expect(cfg.INVOKER_NOTIFY_TOKEN_REF).toBe("***");
    expect(cfg.INVOKER_NOTIFY_KEY).toBe("***");
    expect("PATH" in cfg).toBe(false);
  });
});

test("two bundles from identical state are byte-identical", async () => {
  await withSeededWorkspace((store, dir) => {
    const a = buildSupportBundle({ workspace: dir, store, health: { ok: true }, doctor: { ok: true }, env, now: FIXED_NOW });
    const b = buildSupportBundle({ workspace: dir, store, health: { ok: true }, doctor: { ok: true }, env, now: FIXED_NOW });
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });
});

test("redactEnv drops non-INVOKER keys and sorts output", () => {
  const out = redactEnv({ ZZZ: "x", INVOKER_B: "2", INVOKER_A: "1", INVOKER_API_KEY: "sek" });
  expect(Object.keys(out)).toEqual(["INVOKER_A", "INVOKER_API_KEY", "INVOKER_B"]);
  expect(out.INVOKER_API_KEY).toBe("***");
});

test("a workspace with no log yet still produces a logs entry", async () => {
  await withSeededWorkspace((store, dir) => {
    // build from a sibling workspace dir that has no invoker.log
    const empty = mkdtempSync(join(tmpdir(), "invoker-support-nolog-"));
    try {
      const b = buildSupportBundle({ workspace: empty, store, health: {}, doctor: {}, env, now: FIXED_NOW });
      const log = new TextDecoder().decode(unzipSync(b.bytes)["logs/last100.log"]!);
      expect(log).toContain("no log entries yet");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
