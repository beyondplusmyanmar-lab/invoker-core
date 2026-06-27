// Transport: the local dashboard server. STRICTLY a consumer (the UI never thinks). Every handler
// is a thin call into an already-built backend function — no sqlite logic, no scheduling, no
// coordinator behaviour, no verification logic of its own. The browser only paints what these
// JSON endpoints return; it holds no state machine, no websocket, no reconnect. setInterval + fetch.
//
// handleRequest is a pure (Request, ctx) → Response so the whole API is testable without a socket.

import type { Store } from "../../storage/db.ts";
import type { FetchProvider } from "../../providers/index.ts";
import type { ExecutionCoordinator } from "../../core/execution.ts";
import type { Limits } from "../../core/limits.ts";
import type { RetentionPolicy } from "../../core/retention.ts";
import { runJob, nextTick } from "../../core/runner.ts";
import { gatherHealth } from "../../core/health.ts";
import { verifyArtifact } from "../../core/verify.ts";
import { INDEX_HTML } from "./html.ts";

export interface UiContext {
  store: Store;
  version: string;
  fetcher: FetchProvider;
  coordinator: ExecutionCoordinator;
  limits: Limits;
  retention: RetentionPolicy;
  queueLimit: number;
  daemonAlive?: () => boolean;
  workspaceDir: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Build the health report the same way the CLI does (one source of truth). */
function health(ctx: UiContext) {
  return gatherHealth(ctx.store, {
    version: ctx.version,
    limits: ctx.limits,
    queueLimit: ctx.queueLimit,
    retention: ctx.retention,
    pending: ctx.coordinator.pendingCount(),
    workspaceDir: ctx.workspaceDir,
    daemonAlive: ctx.daemonAlive?.(),
  });
}

/** Schedules with their next fire time — what the Schedule page binds to. */
function schedules(ctx: UiContext) {
  const now = Date.now();
  return ctx.store.listSchedules().map((s) => ({ ...s, nextRunAt: s.enabled ? nextTick(s.cron, now) : null }));
}

/** Composite landing payload: one poll paints the whole Dashboard (incl. a verified last report). */
function dashboard(ctx: UiContext) {
  const runs = ctx.store.listRuns(5);
  const last = runs.find((r) => r.artifact);
  let lastReport: Record<string, unknown> | undefined;
  if (last?.artifact) {
    const v = verifyArtifact(ctx.store, last.artifact.sha256);
    lastReport = {
      job: last.jobName ?? last.capability,
      at: last.startedAt,
      renderer: last.artifact.type,
      sha: last.artifact.sha256,
      verified: v.ok,
    };
  }
  return {
    version: ctx.version,
    health: health(ctx),
    schedules: schedules(ctx),
    notifications: { unread: ctx.store.unreadNotificationCount(), items: ctx.store.listNotifications({ limit: 5 }) },
    reports: runs,
    lastReport,
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function handleRequest(req: Request, ctx: UiContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const get = req.method === "GET";
  const post = req.method === "POST";

  if (get && p === "/") return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

  // --- read surfaces (the UI only paints these) ---
  if (get && p === "/api/dashboard") return json(dashboard(ctx));
  if (get && p === "/api/health") return json(health(ctx));
  if (get && p === "/api/schedules") return json(schedules(ctx));
  if (get && p === "/api/runs") return json(ctx.store.listRuns(Number(url.searchParams.get("limit") ?? 50)));
  if (get && p === "/api/notifications") {
    return json({
      unread: ctx.store.unreadNotificationCount(),
      items: ctx.store.listNotifications({ limit: Number(url.searchParams.get("limit") ?? 50) }),
    });
  }

  // --- artifact bytes: Open / Export download the file the runtime already produced ---
  if (get && p === "/api/artifact") {
    const sha = url.searchParams.get("sha") ?? "";
    const art = ctx.store.findArtifactBySha(sha);
    if (!art) return json({ error: "not found" }, 404);
    const file = Bun.file(art.path);
    if (!(await file.exists())) return json({ error: "file pruned" }, 410);
    const name = `${(art.cacheKey ?? art.id).slice(0, 8)}.${art.type}`;
    return new Response(file, {
      headers: { "content-type": art.mime, "content-disposition": `attachment; filename="${name}"` },
    });
  }

  // --- operate surfaces (each delegates to the backend; the UI decides nothing) ---
  if (post && p === "/api/verify") {
    const { sha } = await body(req);
    return json(verifyArtifact(ctx.store, String(sha ?? "")));
  }
  if (post && (p === "/api/schedule/enable" || p === "/api/schedule/disable")) {
    const { id } = await body(req);
    const ok = ctx.store.setJobEnabled(String(id ?? ""), p.endsWith("enable"));
    return json({ ok }, ok ? 200 : 404);
  }
  if (post && p === "/api/schedule/run") {
    const { id } = await body(req);
    const jobItem = ctx.store.getJob(String(id ?? ""));
    if (!jobItem) return json({ ok: false, error: "no such schedule" }, 404);
    try {
      const result = await runJob(jobItem, ctx.store, ctx.fetcher, {
        coordinator: ctx.coordinator,
        limits: ctx.limits,
      });
      return json({ ok: true, sha: result.artifact?.artifactSha256, cacheHit: result.cacheHit });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return json({ ok: false, error: typeof code === "string" ? code : (err as Error).message }, 400);
    }
  }
  if (post && p === "/api/notifications/read") {
    const { id, all } = await body(req);
    const n = all ? ctx.store.markAllNotificationsRead() : ctx.store.markNotificationRead(String(id ?? "")) ? 1 : 0;
    return json({ ok: true, marked: n });
  }

  return json({ error: "not found" }, 404);
}

/** Start the dashboard on `port`. Returns the Bun server (call .stop() to close). */
export function startUiServer(ctx: UiContext, port: number) {
  return Bun.serve({ port, fetch: (req) => handleRequest(req, ctx) });
}
