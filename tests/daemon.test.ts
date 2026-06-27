import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";
import {
  isAlive,
  acquireLock,
  releaseLock,
  readLock,
  tickOnce,
  runDaemonLoop,
} from "../src/core/daemon.ts";

const DEAD_PID = 2_147_483_646; // far above any live pid → ESRCH

const fakeFetcher: FetchProvider = {
  async fetchJson() {
    return {
      sheet: "Sales",
      columns: [{ id: "item", header: "Item" }],
      rows: [["Tea"], ["Coffee"]],
    };
  },
};

const throwingFetcher: FetchProvider = {
  async fetchJson() {
    throw new Error("upstream down");
  },
};

function dueJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "daily",
    name: "daily",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "* * * * *", // a tick is always in the recent past
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 24 * 60 * 60 * 1000,
    enabled: true,
    ...overrides,
  };
}

async function withStore<T>(fn: (store: Store, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "invoker-daemon-"));
  const store = new Store(dir);
  if (!registry.has(excelRender.id, excelRender.contractVersion)) registry.register(excelRender);
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("isAlive: self is alive, a far-future pid is not", () => {
  expect(isAlive(process.pid)).toBe(true);
  expect(isAlive(DEAD_PID)).toBe(false);
  expect(isAlive(0)).toBe(false);
});

test("acquireLock: free → ok, live holder → refused, dead holder → reclaimed", async () => {
  await withStore(async (_store, dir) => {
    // free
    expect(acquireLock(dir).ok).toBe(true);
    expect(readLock(dir)?.pid).toBe(process.pid);

    // a different live holder (us) refuses a foreign acquirer
    const refused = acquireLock(dir, DEAD_PID === process.pid ? 1 : 999_999);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.holder.pid).toBe(process.pid);

    // a dead holder is reclaimable
    releaseLock(dir);
    expect(acquireLock(dir, DEAD_PID).ok).toBe(true); // lock now owned by a dead pid
    const reclaim = acquireLock(dir, process.pid);
    expect(reclaim.ok).toBe(true);
    expect(readLock(dir)?.pid).toBe(process.pid);
  });
});

test("tickOnce: runs due jobs and reports counts", async () => {
  await withStore(async (store) => {
    store.upsertJob(dueJob());
    const r = await tickOnce(store, { fetcher: fakeFetcher, now: Date.now() });
    expect(r.ran).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.jobIds).toContain("daily");
  });
});

test("tickOnce: a failing job is isolated (failed++, loop survives)", async () => {
  await withStore(async (store) => {
    store.upsertJob(dueJob());
    const r = await tickOnce(store, { fetcher: throwingFetcher, now: Date.now() });
    expect(r.ran).toBe(0);
    expect(r.failed).toBe(1);
    // failure was persisted by runJob
    expect(store.getSchedulerState("daily").lastStatus).toBe("failed");
  });
});

test("tickOnce: no due jobs → zero work", async () => {
  await withStore(async (store) => {
    store.upsertJob(dueJob({ enabled: false }));
    const r = await tickOnce(store, { fetcher: fakeFetcher, now: Date.now() });
    expect(r.ran).toBe(0);
    expect(r.failed).toBe(0);
  });
});

test("runDaemonLoop: ticks, writes heartbeat, stops on abort", async () => {
  await withStore(async (store) => {
    store.upsertJob(dueJob());
    const controller = new AbortController();
    let sleeps = 0;
    const ticks = await runDaemonLoop(store, {
      signal: controller.signal,
      fetcher: fakeFetcher,
      intervalMs: 1,
      now: () => Date.now(),
      pid: 4242,
      sleep: async () => {
        if (++sleeps >= 3) controller.abort(); // stop after 3 passes
      },
    });

    expect(ticks).toBe(3);
    const hb = store.getDaemonHeartbeat();
    expect(hb?.status).toBe("stopped");
    expect(hb?.pid).toBe(4242);
    expect(hb?.ticks).toBe(3);
    expect(hb?.lastTickAt).toBeGreaterThan(0);
  });
});

test("runDaemonLoop: stopped heartbeat pins lastTickAt to the last real tick", async () => {
  await withStore(async (store) => {
    store.upsertJob(dueJob());
    const controller = new AbortController();
    const tickTimes: number[] = [];
    let clock = 1000;
    let sleeps = 0;
    await runDaemonLoop(store, {
      signal: controller.signal,
      fetcher: fakeFetcher,
      intervalMs: 1,
      now: () => (clock += 1000), // monotonic & distinct, so a shutdown stamp would differ
      pid: 4242,
      onTick: (r) => tickTimes.push(r.at),
      sleep: async () => {
        if (++sleeps >= 2) controller.abort();
      },
    });

    const hb = store.getDaemonHeartbeat();
    expect(hb?.status).toBe("stopped");
    // last tick must be the final real tick, not a later shutdown timestamp
    expect(hb?.lastTickAt).toBe(tickTimes.at(-1));
  });
});
