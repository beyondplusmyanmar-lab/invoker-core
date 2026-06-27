// Retention — the disk-exhaustion guard. One shop, one laptop, indefinite runtime: artifacts and
// notifications grow without bound unless something prunes them. Boring on purpose (rc phase, not a
// feature): hard budgets, oldest-first eviction, weekly vacuum. No scheduler, no policies engine.
//
// Safe to prune by construction: artifacts are deterministic (ADR-007), so a pruned report is
// reproducible — the run + manifest stay in history as the audit record, only the bytes are
// reclaimed. `artifact verify` will honestly report Exists:✗ for a pruned artifact until it is
// re-rendered to byte-identical output.

import { existsSync, rmSync } from "node:fs";
import type { Store } from "../storage/db.ts";

export interface RetentionPolicy {
  maxArtifacts: number;
  maxDiskBytes: number;
  maxNotifications: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxArtifacts: 5000,
  maxDiskBytes: 20 * 2 ** 30, // 20 GB
  maxNotifications: 10000,
};

/** Minimal artifact facts needed to plan eviction. */
export interface ArtifactBrief {
  id: string;
  path: string;
  size: number;
  createdAt: number;
}

export interface CleanupReport {
  dryRun: boolean;
  artifactsDeleted: number;
  bytesFreed: number;
  notificationsDeleted: number;
}

/**
 * Pure: choose which artifacts to evict so the set fits BOTH the count and disk budgets. Oldest
 * first (a deterministic artifact is reproducible, so the oldest are the cheapest to lose).
 */
export function planArtifactCleanup(
  artifacts: ArtifactBrief[],
  policy: RetentionPolicy,
): { evict: ArtifactBrief[]; bytesFreed: number } {
  const oldestFirst = [...artifacts].sort((a, b) => a.createdAt - b.createdAt);
  let count = oldestFirst.length;
  let bytes = oldestFirst.reduce((s, a) => s + a.size, 0);
  const evict: ArtifactBrief[] = [];
  let bytesFreed = 0;
  for (const a of oldestFirst) {
    if (count <= policy.maxArtifacts && bytes <= policy.maxDiskBytes) break;
    evict.push(a);
    bytesFreed += a.size;
    count--;
    bytes -= a.size;
  }
  return { evict, bytesFreed };
}

/** Enforce the policy: evict over-budget artifacts (file + row) and trim old notifications. */
export function runCleanup(
  store: Store,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  opts: { dryRun?: boolean } = {},
): CleanupReport {
  const dryRun = opts.dryRun ?? false;
  const { evict, bytesFreed } = planArtifactCleanup(store.listArtifactBriefs(), policy);

  if (!dryRun) {
    for (const a of evict) {
      if (existsSync(a.path)) rmSync(a.path);
      store.deleteArtifact(a.id);
    }
  }

  const overNotif = Math.max(0, store.countNotifications() - policy.maxNotifications);
  const notificationsDeleted = dryRun ? overNotif : store.trimNotifications(policy.maxNotifications);

  return { dryRun, artifactsDeleted: evict.length, bytesFreed, notificationsDeleted };
}

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/**
 * Cheap periodic maintenance for the daemon: enforce budgets at most hourly, VACUUM at most weekly.
 * Gated by timestamps in the meta table so calling it every tick is nearly free. Returns the cleanup
 * report when one ran.
 */
export function maybeMaintain(
  store: Store,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now = Date.now(),
): { cleanup?: CleanupReport; vacuumed: boolean } {
  let cleanup: CleanupReport | undefined;
  if (now - Number(store.getMeta("last_cleanup_at") ?? 0) >= HOUR_MS) {
    cleanup = runCleanup(store, policy);
    store.setMeta("last_cleanup_at", String(now));
  }
  let vacuumed = false;
  if (now - Number(store.getMeta("last_vacuum_at") ?? 0) >= WEEK_MS) {
    store.vacuum();
    store.setMeta("last_vacuum_at", String(now));
    vacuumed = true;
  }
  return { cleanup, vacuumed };
}
