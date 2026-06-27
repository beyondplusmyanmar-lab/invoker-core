import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { runJob } from "../src/core/runner.ts";
import { ExecutionCoordinator } from "../src/core/execution.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { Capability } from "../src/abi/capability.ts";
import type { FetchProvider } from "../src/providers/index.ts";

/** A counting artifact capability whose render blocks until released — proves collapse vs. duplicate. */
function countingCap(state: { runs: number; gate: Promise<void> }): Capability {
  return {
    id: "test.counting",
    contractVersion: 1,
    engineVersion: "1.0.0",
    deterministic: true,
    supportsDryRun: false,
    cacheable: true,
    async execute() {
      state.runs++;
      await state.gate;
      return { kind: "artifact", bytes: new TextEncoder().encode("report"), type: "bin", mime: "application/octet-stream" };
    },
  };
}

const fetcher: FetchProvider = { async fetchJson() { return { orders: [{ id: "A1" }] }; } };

function job(): ScheduledJob {
  return {
    id: "daily",
    name: "Daily",
    capability: "test.counting",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "invoker-coord-"));
  const store = new Store(dir);
  return fn(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test("four concurrent identical job runs render ONCE; all share the artifact (4 producers → 1 render)", async () => {
  let release!: () => void;
  const state = { runs: 0, gate: new Promise<void>((r) => (release = r)) };
  const cap = countingCap(state);
  if (!registry.has(cap.id, cap.contractVersion)) registry.register(cap);

  await withStore(async (store) => {
    const j = job();
    store.upsertJob(j);
    const coordinator = new ExecutionCoordinator();

    // Cron + AI + notification + button, all at once.
    const all = Promise.all([
      runJob(j, store, fetcher, { coordinator }),
      runJob(j, store, fetcher, { coordinator }),
      runJob(j, store, fetcher, { coordinator }),
      runJob(j, store, fetcher, { coordinator }),
    ]);
    await Bun.sleep(20); // let all four fetch + reach the coordinator
    expect(state.runs).toBe(1); // ONE render, despite four producers
    expect(coordinator.pendingCount()).toBe(1);

    release();
    const results = await all;
    const shas = new Set(results.map((r) => r.artifact!.artifactSha256));
    expect(shas.size).toBe(1); // all four served the same artifact
    expect(store.countArtifacts()).toBe(1);
    expect(store.listRuns()).toHaveLength(4); // every producer is still logged in history
  });
});

test("input over the row ceiling fails the run with INPUT_TOO_LARGE before rendering", async () => {
  const bigFetcher: FetchProvider = {
    async fetchJson() {
      return { orders: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
    },
  };
  await withStore(async (store) => {
    const j = job();
    store.upsertJob(j);
    await expect(
      runJob(j, store, bigFetcher, { limits: { maxRows: 10, maxBytes: 1e9, maxDurationMs: 1000 } }),
    ).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(store.listRuns()[0]!.status).toBe("failed");
    expect(store.listRuns()[0]!.error).toBe("INPUT_TOO_LARGE");
  });
});
