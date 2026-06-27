import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { ExecutionCoordinator } from "../src/core/execution.ts";
import { DEFAULT_LIMITS } from "../src/core/limits.ts";
import { DEFAULT_RETENTION } from "../src/core/retention.ts";
import { handleRequest, type UiContext } from "../src/transports/ui/server.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

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
    cron: "0 6 * * *",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

async function withCtx<T>(fn: (ctx: UiContext, store: Store) => Promise<T>): Promise<T> {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
  const dir = mkdtempSync(join(tmpdir(), "invoker-ui-"));
  const store = new Store(dir);
  const ctx: UiContext = {
    store,
    version: "0.2.0-beta",
    fetcher,
    coordinator: new ExecutionCoordinator(),
    limits: DEFAULT_LIMITS,
    retention: DEFAULT_RETENTION,
    queueLimit: 10,
    workspaceDir: dir,
  };
  try {
    return await fn(ctx, store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

test("GET / serves the dashboard HTML", async () => {
  await withCtx(async (ctx) => {
    const res = await handleRequest(req("GET", "/"), ctx);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("DOEH Hands");
  });
});

test("GET /api/dashboard returns a composite payload with a verified last report", async () => {
  await withCtx(async (ctx, store) => {
    const j = job();
    store.upsertJob(j);
    await runJob(j, store, fetcher);

    const d = (await (await handleRequest(req("GET", "/api/dashboard"), ctx)).json()) as Record<string, any>;
    expect(d.version).toBe("0.2.0-beta");
    expect(d.health.db).toBe("ok");
    expect(d.schedules).toHaveLength(1);
    expect(d.schedules[0].nextRunAt).toBeGreaterThan(0);
    expect(d.lastReport.job).toBe("Yesterday Sales");
    expect(d.lastReport.verified).toBe(true); // server-side verify, painted as a green shield
  });
});

test("POST /api/schedule/run renders and returns the artifact sha", async () => {
  await withCtx(async (ctx, store) => {
    store.upsertJob(job());
    const r = (await (await handleRequest(req("POST", "/api/schedule/run", { id: "daily" }), ctx)).json()) as Record<string, any>;
    expect(r.ok).toBe(true);
    expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(store.listRuns().length).toBeGreaterThan(0);
  });
});

test("POST /api/schedule/disable + enable toggle the job; unknown id 404s", async () => {
  await withCtx(async (ctx, store) => {
    store.upsertJob(job());
    await handleRequest(req("POST", "/api/schedule/disable", { id: "daily" }), ctx);
    expect(store.listSchedules()[0]!.enabled).toBe(false);
    await handleRequest(req("POST", "/api/schedule/enable", { id: "daily" }), ctx);
    expect(store.listSchedules()[0]!.enabled).toBe(true);

    const res = await handleRequest(req("POST", "/api/schedule/enable", { id: "ghost" }), ctx);
    expect(res.status).toBe(404);
  });
});

test("POST /api/verify mirrors the verifier; the artifact is downloadable", async () => {
  await withCtx(async (ctx, store) => {
    const j = job();
    store.upsertJob(j);
    const result = await runJob(j, store, fetcher);
    const sha = result.artifact!.artifactSha256;

    const v = (await (await handleRequest(req("POST", "/api/verify", { sha }), ctx)).json()) as Record<string, any>;
    expect(v.ok).toBe(true);

    const dl = await handleRequest(req("GET", `/api/artifact?sha=${sha}`), ctx);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

test("POST /api/notifications/read marks read; an unknown route 404s", async () => {
  await withCtx(async (ctx, store) => {
    store.recordNotification({ eventId: "e1", title: "HQ", body: "", type: "HQ", receivedAt: Date.now() });
    const r = (await (await handleRequest(req("POST", "/api/notifications/read", { all: true }), ctx)).json()) as Record<string, any>;
    expect(r.marked).toBe(1);
    expect(store.unreadNotificationCount()).toBe(0);

    expect((await handleRequest(req("GET", "/api/nope"), ctx)).status).toBe(404);
  });
});
