// The support bundle (v0.2 pilot packaging). One `invoker support bundle` produces a single
// support-YYYYMMDD.zip the operator can attach to "Monday report is missing" without granting
// remote access. Deliberately boring: durable state and a redacted config, nothing live. No crash
// dumps, no telemetry, no traces — just enough to turn a remote-debugging session into a
// five-minute read. Assembled deterministically (sorted entries, fixed mtime) so two bundles from
// the same state are byte-identical.
import { existsSync, readFileSync } from "node:fs";
import type { Store } from "../storage/db.ts";
import { zipDeterministic } from "../engines/ooxml.ts";
import { tailLog } from "./log.ts";

/** Env names whose VALUE is (or could be) a secret — captured as *** so the bundle is safe to send. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PEPPER|CRED|AUTH/i;

/** How many tail entries each "recent" section carries — enough history, small enough to mail. */
const RUNS_LIMIT = 200;
const NOTIFICATIONS_LIMIT = 200;
const LOG_LINES = 100;

export interface SupportInputs {
  workspace: string;
  store: Store;
  /** Pre-gathered reports from the same code paths as `invoker health` / `invoker doctor`. */
  health: unknown;
  doctor: unknown;
  /** Process env to snapshot (only INVOKER_* keys are kept; secret-shaped values are redacted). */
  env: Record<string, string | undefined>;
  now?: Date;
}

export interface SupportBundle {
  filename: string;
  bytes: Uint8Array;
  /** The entry names included, in bundle order — printed back to the operator as a receipt. */
  entries: string[];
}

/** INVOKER_* env snapshot with secret-shaped values masked. Sorted for byte-stable output. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("INVOKER_")) continue;
    out[name] = SECRET_NAME.test(name) ? "***" : (env[name] ?? "");
  }
  return out;
}

/** The newest run that actually rendered (so it has a manifest sidecar on disk), or undefined. */
function latestManifestBytes(store: Store): Uint8Array | undefined {
  for (const run of store.listRuns(50)) {
    const p = store.manifestPath(run.id);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
  }
  return undefined;
}

/** Assemble the bundle in memory. Pure apart from reading the workspace's own files. */
export function buildSupportBundle(inp: SupportInputs): SupportBundle {
  const { store } = inp;
  const now = inp.now ?? new Date();
  const enc = new TextEncoder();
  const json = (obj: unknown): Uint8Array => enc.encode(JSON.stringify(obj, null, 2));

  const parts: Record<string, Uint8Array> = {
    "health.json": json(inp.health),
    "doctor.json": json(inp.doctor),
    "runs.json": json(store.listRuns(RUNS_LIMIT)),
    "schedules.json": json(store.listSchedules()),
    "notifications.json": json({
      unread: store.unreadNotificationCount(),
      items: store.listNotifications({ limit: NOTIFICATIONS_LIMIT }),
    }),
    "config.redacted.json": json(redactEnv(inp.env)),
    "sqlite.db": store.snapshotBytes(),
  };

  const manifest = latestManifestBytes(store);
  if (manifest) parts["artifacts/latest.manifest.json"] = manifest;

  const log = tailLog(inp.workspace, LOG_LINES);
  parts["logs/last100.log"] = enc.encode(log.length ? `${log}\n` : "(no log entries yet)\n");

  const yyyymmdd = now.toISOString().slice(0, 10).replaceAll("-", "");
  return {
    filename: `support-${yyyymmdd}.zip`,
    bytes: zipDeterministic(parts),
    entries: Object.keys(parts).sort(),
  };
}
