// P4 — `invoker doctor`. A single read-only health sweep that aggregates checks the runtime
// already knows how to do (capability verify, sqlite open, cache, secrets, scheduler) into one
// ✓/⚠/✗ report. It invents no new checks; it surfaces existing invariants. Pure and injectable
// so it is testable without a real workspace.

import { Cron } from "croner";
import type { Store } from "../storage/db.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { assertDeterministic } from "../engines/conformance.ts";
import { resolveSecret } from "./secrets.ts";
import { dueJobs } from "./runner.ts";
import { readLock, isAlive } from "./daemon.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when no check failed (warnings are tolerated). Drives the CLI exit code. */
  ok: boolean;
}

export interface DoctorDeps {
  workspace: string;
  store: Store;
  registry: CapabilityRegistry;
  /** Secret reference for outbound fetches (process.env.INVOKER_TOKEN_REF). */
  tokenRef?: string;
  /** Bun.version, when running under Bun. */
  bunVersion?: string;
  now?: number;
}

const MIN_BUN = "1.1.0";

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  // bun ---------------------------------------------------------------------
  if (!deps.bunVersion) {
    add("bun", "warn", "version unknown (not running under Bun?)");
  } else {
    const ok = gteVersion(deps.bunVersion, MIN_BUN);
    add("bun", ok ? "ok" : "warn", `v${deps.bunVersion}${ok ? "" : ` (<${MIN_BUN} recommended)`}`);
  }

  // sqlite / workspace — a constructed store means the db opened ------------
  try {
    deps.store.countArtifacts();
    add("sqlite", "ok", `workspace ${deps.workspace}`);
  } catch (err) {
    add("sqlite", "fail", (err as Error).message);
  }

  // capabilities ------------------------------------------------------------
  const caps = deps.registry.list();
  add(
    "capabilities",
    caps.length ? "ok" : "fail",
    caps.length ? caps.map((c) => `${c.id}@v${c.contractVersion}`).join(", ") : "none registered",
  );

  // determinism — ADR-007 ×10 self-test for every capability that claims it -
  const claims = caps.filter((c) => c.deterministic);
  const verifiable = claims.filter((c) => c.sample);
  if (claims.length === 0) {
    add("determinism", "ok", "no capability claims determinism");
  } else if (verifiable.length === 0) {
    add("determinism", "warn", "claimed but no sample() to verify");
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
      "determinism",
      failures.length ? "fail" : "ok",
      failures.length
        ? `×10 FAILED for ${failures.join(", ")}`
        : `×10 verified for ${verifiable.map((c) => c.id).join(", ")}`,
    );
  }

  // plugins — ADR-008 -------------------------------------------------------
  const plugins = deps.store.listPlugins();
  const unverified = plugins.filter((p) => p.verified === 0).length;
  add(
    "plugins",
    unverified ? "warn" : "ok",
    plugins.length
      ? `${plugins.length} installed${unverified ? `, ${unverified} unverified` : ""}`
      : "none installed",
  );

  // secrets — ADR-005 -------------------------------------------------------
  if (!deps.tokenRef) {
    add("secrets", "warn", "INVOKER_TOKEN_REF unset (offline only)");
  } else {
    try {
      resolveSecret(deps.tokenRef);
      add("secrets", "ok", `token ref resolves (${deps.tokenRef.split(":")[0]}:…)`);
    } catch (err) {
      const msg = (err as Error).message;
      // An inline raw secret is a hard ADR-005 violation; a merely-unresolvable ref is a warning.
      const inline = /inline secret/i.test(msg);
      add("secrets", inline ? "fail" : "warn", msg);
    }
  }

  // scheduler ---------------------------------------------------------------
  const jobs = deps.store.listJobs();
  const badCron = jobs.filter((j) => !validCron(j.cron));
  const due = badCron.length ? [] : dueJobs(jobs, deps.store, deps.now);
  add(
    "scheduler",
    badCron.length ? "fail" : "ok",
    badCron.length
      ? `${badCron.length} job(s) with invalid cron: ${badCron.map((j) => j.id).join(", ")}`
      : `${jobs.length} job(s), ${due.length} due now`,
  );

  // daemon liveness (P2) — informational; not-running is normal -------------
  const lock = readLock(deps.workspace);
  if (lock && isAlive(lock.pid)) {
    const hb = deps.store.getDaemonHeartbeat();
    add("daemon", "ok", `running (pid ${lock.pid}${hb ? `, ${hb.ticks} ticks` : ""})`);
  } else {
    add("daemon", "ok", lock ? "not running (stale lock)" : "not running");
  }

  // cache -------------------------------------------------------------------
  add("cache", "ok", `${deps.store.countArtifacts()} artifact(s) cached`);

  // relay (P3) — not built yet ----------------------------------------------
  add("relay", "warn", "not configured (WS relay is P3, not yet built)");

  return { checks, ok: checks.every((c) => c.status !== "fail") };
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
    new Cron(expr);
    return true;
  } catch {
    return false;
  }
}
