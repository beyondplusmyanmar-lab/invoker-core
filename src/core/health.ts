// `invoker health` — the operability spine. Highest-ROI pilot tooling: one read-only snapshot of
// whether the runtime is alive and behaving, assembled entirely from durable state (sqlite + fs) so
// it works as a one-shot CLI without sharing a process with the daemon/listener. The same
// buildHealthReport is reused by the (future) UI Health page, which fills the live fields from its
// own in-memory connectors.

import * as nodeFs from "node:fs";
import type { Store } from "../storage/db.ts";

// statfsSync exists in Bun/Node at runtime but isn't in this @types/node; bind it without the type.
const statfsSync = (nodeFs as unknown as {
  statfsSync?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
}).statfsSync;
import type { DaemonHeartbeat } from "../storage/db.ts";
import type { Limits } from "./limits.ts";
import { DEFAULT_RETENTION, type RetentionPolicy } from "./retention.ts";

export type ConnStatus = "connected" | "stale" | "disconnected" | "absent";
export type SchedulerStatus = "running" | "stopped" | "absent";

export interface HealthReport {
  version: string;
  ok: boolean;
  scheduler: { status: SchedulerStatus; lastTickAt?: number; ticks?: number };
  notifications: { status: ConnStatus; lastSeen?: number; detail?: string };
  businessai: { status: ConnStatus; lastSeen?: number };
  coordinator: {
    pending: number;
    queueLimit: number;
    timeoutMs: number;
    maxRows: number;
    maxBytes: number;
    collapses24h: number;
  };
  artifacts: { count: number; diskBytes: number };
  retention: {
    maxArtifacts: number;
    maxDiskBytes: number;
    notifications: number;
    maxNotifications: number;
    lastCleanupAt?: number;
    lastVacuumAt?: number;
  };
  lastReport?: { job: string; at: number; renderer?: string; sha?: string };
  cacheHitRatio: number;
  db: "ok" | "error";
  diskFreeBytes?: number;
}

export interface HealthInputs {
  version: string;
  now: number;
  /** A connector heartbeat older than this (while still "connected") is reported "stale". */
  stalenessMs: number;
  daemon?: DaemonHeartbeat;
  /** Live process probe for the daemon lock holder; when omitted the persisted status is used. */
  daemonAlive?: boolean;
  notifications?: { status: string; lastSeen: number; detail?: string };
  businessai?: { status: string; lastSeen: number };
  coordinator: HealthReport["coordinator"];
  artifacts: HealthReport["artifacts"];
  retention: HealthReport["retention"];
  lastReport?: HealthReport["lastReport"];
  cacheHitRatio: number;
  dbOk: boolean;
  diskFreeBytes?: number;
}

function connStatus(
  hb: { status: string; lastSeen: number } | undefined,
  now: number,
  stalenessMs: number,
): ConnStatus {
  if (!hb) return "absent";
  if (hb.status !== "connected") return "disconnected";
  return now - hb.lastSeen <= stalenessMs ? "connected" : "stale";
}

/** Pure: assemble the report and derive overall health. DB integrity is the one hard invariant. */
export function buildHealthReport(i: HealthInputs): HealthReport {
  let scheduler: HealthReport["scheduler"];
  if (!i.daemon) {
    scheduler = { status: "absent" };
  } else {
    const alive = i.daemonAlive ?? i.daemon.status === "running";
    scheduler = { status: alive ? "running" : "stopped", lastTickAt: i.daemon.lastTickAt, ticks: i.daemon.ticks };
  }

  return {
    version: i.version,
    ok: i.dbOk,
    scheduler,
    notifications: {
      status: connStatus(i.notifications, i.now, i.stalenessMs),
      lastSeen: i.notifications?.lastSeen,
      detail: i.notifications?.detail,
    },
    businessai: {
      status: connStatus(i.businessai, i.now, i.stalenessMs),
      lastSeen: i.businessai?.lastSeen,
    },
    coordinator: i.coordinator,
    artifacts: i.artifacts,
    retention: i.retention,
    lastReport: i.lastReport,
    cacheHitRatio: i.cacheHitRatio,
    db: i.dbOk ? "ok" : "error",
    diskFreeBytes: i.diskFreeBytes,
  };
}

export interface GatherHealthOptions {
  version: string;
  limits: Limits;
  queueLimit: number;
  /** Live coordinator pending count when a long-running process owns one; 0 for the one-shot CLI. */
  pending?: number;
  retention?: RetentionPolicy;
  workspaceDir: string;
  daemonAlive?: boolean;
  now?: number;
  stalenessMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALENESS_MS = 10 * 60 * 1000; // a connected heartbeat older than 10m reads "stale"

const numOrUndef = (v: string | undefined): number | undefined => (v == null ? undefined : Number(v));

/** Gather durable facts from the store + filesystem and build the report. */
export function gatherHealth(store: Store, opts: GatherHealthOptions): HealthReport {
  const now = opts.now ?? Date.now();
  const last = store.lastReport();
  let diskFreeBytes: number | undefined;
  try {
    const fs = statfsSync?.(opts.workspaceDir);
    diskFreeBytes = fs ? Number(fs.bavail) * Number(fs.bsize) : undefined;
  } catch {
    diskFreeBytes = undefined;
  }

  return buildHealthReport({
    version: opts.version,
    now,
    stalenessMs: opts.stalenessMs ?? DEFAULT_STALENESS_MS,
    daemon: store.getDaemonHeartbeat(),
    daemonAlive: opts.daemonAlive,
    notifications: store.getServiceHeartbeat("notifications"),
    businessai: store.getServiceHeartbeat("businessai"),
    coordinator: {
      pending: opts.pending ?? 0,
      queueLimit: opts.queueLimit,
      timeoutMs: opts.limits.maxDurationMs,
      maxRows: opts.limits.maxRows,
      maxBytes: opts.limits.maxBytes,
      collapses24h: store.collapsedCount(now - DAY_MS),
    },
    artifacts: { count: store.countArtifacts(), diskBytes: store.artifactsDiskBytes() },
    retention: ((policy) => ({
      maxArtifacts: policy.maxArtifacts,
      maxDiskBytes: policy.maxDiskBytes,
      notifications: store.countNotifications(),
      maxNotifications: policy.maxNotifications,
      lastCleanupAt: numOrUndef(store.getMeta("last_cleanup_at")),
      lastVacuumAt: numOrUndef(store.getMeta("last_vacuum_at")),
    }))(opts.retention ?? DEFAULT_RETENTION),
    lastReport: last
      ? { job: last.jobName ?? last.capability, at: last.startedAt, renderer: last.type, sha: last.sha }
      : undefined,
    cacheHitRatio: store.cacheHitRatio(),
    dbOk: store.dbIntegrityOk(),
    diskFreeBytes,
  });
}
