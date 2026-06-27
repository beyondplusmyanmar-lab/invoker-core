// `invoker doctor` — the day-one pilot-support tool. One read-only sweep that turns "it doesn't
// work" into a specific, suggested fix, faster than reading logs. Opinionated and binary: a clean
// PASS/FAIL over operational invariants the runtime already knows how to check. It invents nothing;
// it surfaces existing state. Pure and injectable so it is testable without a real workspace.
//
// Three modes (the CLI picks): default (FAIL only on a hard fault), --strict (warnings fail too),
// --pilot (check the actual 7-day pilot gates).

import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../storage/db.ts";
import type { CapabilityRegistry } from "./registry.ts";
import type { Limits } from "./limits.ts";
import type { RetentionPolicy } from "./retention.ts";
import { assertDeterministic } from "../engines/conformance.ts";
import { resolveSecret } from "./secrets.ts";
import { verifyArtifact } from "./verify.ts";
import { freeDiskBytes } from "./health.ts";
import { previousTick, newCron } from "./runner.ts";
import { readLock, isAlive } from "./daemon.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** A command/action that would clear the check, shown on warn/fail. */
  suggestion?: string;
}

export interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
  /** Lenient default: true unless a check FAILED. Strict: true only when every check is OK. */
  ok: boolean;
  strict: boolean;
}

export interface DoctorDeps {
  workspace: string;
  store: Store;
  registry: CapabilityRegistry;
  version: string;
  limits: Limits;
  retention: RetentionPolicy;
  queueLimit: number;
  tokenRef?: string;
  strict?: boolean;
  now?: number;
}

const NOTIF_STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const DISK_MIN_BYTES = 2 * 2 ** 30; // 2 GB
const VACUUM_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MISS_GRACE_MS = 60 * 60 * 1000; // a tick more than 1h overdue with no run counts as missed

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.now ?? Date.now();
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string, suggestion?: string) =>
    checks.push({ name, status, detail, suggestion });

  // SQLite — quick_check ----------------------------------------------------
  const dbOk = deps.store.dbIntegrityOk();
  add("SQLite", dbOk ? "ok" : "fail", dbOk ? "quick_check ok" : "integrity check FAILED", dbOk ? undefined : "restore the workspace db from a backup");

  // Determinism — ADR-007 ×10 (proves the renderers) ------------------------
  const verifiable = deps.registry.list().filter((c) => c.deterministic && c.sample);
  if (verifiable.length === 0) {
    add("Determinism", "warn", "no verifiable capability registered");
  } else {
    const failures: string[] = [];
    for (const cap of verifiable) {
      const data = cap.sample!();
      const r = await assertDeterministic(async () => {
        const out = await cap.execute({
          request: { id: "doctor", capability: cap.id, contractVersion: cap.contractVersion, params: {}, data },
          data,
        });
        if (out.kind !== "artifact") throw new Error("not artifact-producing");
        return out.bytes;
      }, 10);
      if (!r.ok) failures.push(cap.id);
    }
    add(
      "Determinism",
      failures.length ? "fail" : "ok",
      failures.length ? `×10 FAILED for ${failures.join(", ")}` : `×10 verified (${verifiable.map((c) => c.id).join(", ")})`,
    );
  }

  // Artifact Store — root writable ------------------------------------------
  const probe = join(deps.workspace, ".doctor-write-test");
  try {
    writeFileSync(probe, "ok");
    rmSync(probe);
    add("Artifact Store", "ok", `writable · ${deps.store.countArtifacts()} artifacts`);
  } catch (err) {
    add("Artifact Store", "fail", `workspace not writable: ${(err as Error).message}`, "check filesystem permissions");
  }

  // Manifests — verify a recent sample --------------------------------------
  const sample = deps.store.recentArtifactShas(5);
  if (sample.length === 0) {
    add("Manifests", "ok", "no artifacts yet");
  } else {
    const bad = sample.filter((sha) => !verifyArtifact(deps.store, sha).ok);
    add(
      "Manifests",
      bad.length ? "fail" : "ok",
      bad.length ? `${bad.length}/${sample.length} sampled artifacts failed verify` : `${sample.length} sampled, all intact`,
      bad.length ? `invoker artifact verify ${bad[0]!.slice(0, 12)}` : undefined,
    );
  }

  // Reports — the latest artifact verifies ----------------------------------
  const latest = deps.store.recentArtifactShas(1)[0];
  if (!latest) {
    add("Reports", "ok", "no reports yet");
  } else {
    const v = verifyArtifact(deps.store, latest);
    add("Reports", v.ok ? "ok" : "fail", v.ok ? `latest verifies (${latest.slice(0, 12)}…)` : "latest artifact failed verify");
  }

  // Scheduler — daemon heartbeat fresh / crons valid ------------------------
  const jobs = deps.store.listJobs();
  const badCron = jobs.filter((j) => j.cron && !validCron(j.cron));
  if (badCron.length) {
    add("Scheduler", "fail", `invalid cron: ${badCron.map((j) => j.id).join(", ")}`, "invoker schedule edit <id> --cron ...");
  } else {
    const lock = readLock(deps.workspace);
    const hb = deps.store.getDaemonHeartbeat();
    if (lock && isAlive(lock.pid)) {
      const fresh = hb?.lastTickAt != null && now - hb.lastTickAt <= HEARTBEAT_STALE_MS;
      add("Scheduler", fresh ? "ok" : "warn", fresh ? `daemon running, heartbeat fresh (${hb!.ticks} ticks)` : "daemon running but heartbeat stale");
    } else {
      add("Scheduler", "warn", "daemon not running", "invoker daemon start");
    }
  }

  // Schedules — at least one enabled ----------------------------------------
  const enabled = jobs.filter((j) => j.enabled && j.cron).length;
  add(
    "Schedules",
    enabled ? "ok" : "warn",
    enabled ? `${enabled} enabled` : "no enabled scheduled jobs",
    enabled ? undefined : "invoker schedule enable <id>",
  );

  // Notifications — heartbeat age -------------------------------------------
  const nhb = deps.store.getServiceHeartbeat("notifications");
  if (!nhb) {
    add("Notifications", "warn", "listener never started", "invoker notifications listen");
  } else if (nhb.status !== "connected" || now - nhb.lastSeen > NOTIF_STALE_MS) {
    add("Notifications", "warn", `heartbeat stale (>${NOTIF_STALE_MS / 1000}s)`, "invoker notifications listen");
  } else {
    add("Notifications", "ok", `connected${nhb.detail ? ` (${nhb.detail})` : ""}`);
  }

  // Coordinator — config sane (live pending lives in the running process) ----
  add(
    "Coordinator",
    "ok",
    `queue ${deps.queueLimit}, timeout ${Math.round(deps.limits.maxDurationMs / 60000)}m, ${deps.store.collapsedCount(now - DAY_MS)} collapses/24h`,
  );

  // Cleanup — under configured budgets --------------------------------------
  const over =
    deps.store.countArtifacts() > deps.retention.maxArtifacts ||
    deps.store.artifactsDiskBytes() > deps.retention.maxDiskBytes ||
    deps.store.countNotifications() > deps.retention.maxNotifications;
  add("Cleanup", over ? "warn" : "ok", over ? "over budget" : "under budgets", over ? "invoker cleanup" : undefined);

  // Retention — vacuum age --------------------------------------------------
  const lastVac = Number(deps.store.getMeta("last_vacuum_at") ?? 0);
  if (!lastVac) {
    add("Retention", "ok", "not vacuumed yet (daemon vacuums weekly)");
  } else {
    const age = now - lastVac;
    add("Retention", age <= VACUUM_MAX_AGE_MS ? "ok" : "warn", `vacuum ${Math.round(age / DAY_MS)}d ago`, age > VACUUM_MAX_AGE_MS ? "invoker cleanup" : undefined);
  }

  // Disk — > 2GB free -------------------------------------------------------
  const free = freeDiskBytes(deps.workspace);
  if (free == null) {
    add("Disk", "ok", "free space unknown");
  } else {
    add("Disk", free >= DISK_MIN_BYTES ? "ok" : "fail", `${(free / 2 ** 30).toFixed(1)} GB free`, free < DISK_MIN_BYTES ? "free disk space or lower retention budgets" : undefined);
  }

  // Secrets — ADR-005 token ref resolvable ----------------------------------
  if (!deps.tokenRef) {
    add("Secrets", "ok", "no token ref (offline / file: sources only)");
  } else {
    try {
      resolveSecret(deps.tokenRef);
      add("Secrets", "ok", `token ref resolves (${deps.tokenRef.split(":")[0]}:…)`);
    } catch (err) {
      const msg = (err as Error).message;
      add("Secrets", /inline secret/i.test(msg) ? "fail" : "warn", msg, "set INVOKER_TOKEN_REF to a resolvable reference");
    }
  }

  const strict = deps.strict ?? false;
  const ok = strict ? checks.every((c) => c.status === "ok") : checks.every((c) => c.status !== "fail");
  return { version: deps.version, checks, ok, strict };
}

// --- pilot mode --------------------------------------------------------------

export interface PilotGate {
  name: string;
  value: string;
  ok: boolean;
}

export interface PilotReport {
  daysRunning: number;
  daysTarget: number;
  gates: PilotGate[];
  /** All gates currently green. */
  ok: boolean;
  /** Green AND the full window has elapsed. */
  passed: boolean;
}

/**
 * Check the actual 7-day pilot gates. The window starts on the first `--pilot` run (recorded in
 * meta). Gates are measured from durable state: duplicate renders, corrupt artifacts, missed
 * schedules, DB integrity.
 */
export function runPilotCheck(deps: DoctorDeps, daysTarget = 7): PilotReport {
  const now = deps.now ?? Date.now();
  let start = Number(deps.store.getMeta("pilot_started_at") ?? 0);
  if (!start) {
    start = now;
    deps.store.setMeta("pilot_started_at", String(start));
  }
  const daysRunning = Math.floor((now - start) / DAY_MS);

  const duplicates = deps.store.duplicateRenderCount();
  const corrupt = deps.store.recentArtifactShas(100_000).filter((sha) => !verifyArtifact(deps.store, sha).ok).length;
  const missed = countMissedSchedules(deps, now);
  const dbOk = deps.store.dbIntegrityOk();

  const gates: PilotGate[] = [
    { name: "Duplicate renders", value: String(duplicates), ok: duplicates === 0 },
    { name: "Corrupt artifacts", value: String(corrupt), ok: corrupt === 0 },
    { name: "Missed schedules", value: String(missed), ok: missed === 0 },
    { name: "SQLite recoveries", value: dbOk ? "0" : "integrity FAILED", ok: dbOk },
  ];
  const ok = gates.every((g) => g.ok);
  return { daysRunning, daysTarget, gates, ok, passed: ok && daysRunning >= daysTarget };
}

/** Enabled cron jobs whose most recent due tick (>1h ago) produced no run. */
function countMissedSchedules(deps: DoctorDeps, now: number): number {
  let missed = 0;
  for (const job of deps.store.listJobs()) {
    if (!job.enabled || !job.cron || !validCron(job.cron)) continue;
    const state = deps.store.getSchedulerState(job.id);
    const lowerBound = state.lastRunAt ?? now - Math.max(job.maxLagMs, DAY_MS);
    const prevTick = previousTick(newCron(job.cron), lowerBound, now);
    if (prevTick == null) continue;
    const ranThisTick = state.lastRunAt != null && state.lastRunAt >= prevTick;
    if (!ranThisTick && now - prevTick > MISS_GRACE_MS) missed++;
  }
  return missed;
}

/** a >= b for dotted numeric versions (major.minor.patch). Non-numeric segments compare as 0. */
export function gteVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

function validCron(expr: string): boolean {
  try {
    newCron(expr);
    return true;
  } catch {
    return false;
  }
}
