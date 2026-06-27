// `invoker artifact verify <sha>` — prove a report is trustworthy from the filesystem alone, the
// literal expression of the artifact-authority ethos: "even if DOEH servers vanish, yesterday's
// report is on the manager's laptop AND demonstrably intact". Three layers agree or the check fails:
//   on-disk bytes  →  the DB artifact row  →  the self-describing manifest sidecar
// Integrity chain: recomputed-bytes-sha == artifact.sha256 == manifest.sha256, and the manifest's
// own bytes hash to the value recorded when it was written (tamper-evident sidecar).

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { unzipSync } from "fflate";
import { sha256Hex } from "./hash.ts";
import type { Store } from "../storage/db.ts";
import type { Artifact } from "../abi/index.ts";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  artifact: string;
  found: boolean;
  ok: boolean;
  checks: VerifyCheck[];
  /** Descriptive fields for display (engine, generated_at, duration, cache hit, full sha). */
  meta: Record<string, string>;
}

export interface ManifestSidecar {
  json: Record<string, unknown>;
  bytes: Uint8Array;
  /** The hash recorded when the manifest was written; undefined for pre-fingerprint manifests. */
  storedSha256?: string;
}

/** Structural OOXML check: a valid xlsx/docx is a zip package containing [Content_Types].xml. */
export function checkOoxml(bytes: Uint8Array): { ok: boolean; detail: string } {
  try {
    const entries = unzipSync(bytes);
    if (!entries["[Content_Types].xml"]) return { ok: false, detail: "missing [Content_Types].xml" };
    return { ok: true, detail: `${Object.keys(entries).length} parts` };
  } catch {
    return { ok: false, detail: "not a valid zip package" };
  }
}

/**
 * Pure verification: given the artifact row, its on-disk bytes (or undefined if missing), and its
 * manifest sidecar (or undefined), build the check report. No I/O — trivially testable.
 */
export function buildVerifyReport(
  artifact: Artifact,
  fileBytes: Uint8Array | undefined,
  manifest: ManifestSidecar | undefined,
): VerifyReport {
  const checks: VerifyCheck[] = [];
  const exists = fileBytes !== undefined;
  checks.push({ name: "Exists", ok: exists, detail: exists ? artifact.path : "file not found" });

  const actualSha = exists ? sha256Hex(fileBytes!) : "";
  const shaOk = exists && actualSha === artifact.artifactSha256;
  checks.push({
    name: "SHA256",
    ok: shaOk,
    detail: !exists ? "—" : shaOk ? `${actualSha.slice(0, 12)}…` : `mismatch (got ${actualSha.slice(0, 12)}…)`,
  });

  const sizeOk = exists && fileBytes!.byteLength === artifact.size;
  checks.push({
    name: "Size",
    ok: sizeOk,
    detail: !exists ? "—" : `${fileBytes!.byteLength} bytes${sizeOk ? "" : ` ≠ ${artifact.size}`}`,
  });

  let manifestOk = false;
  let manifestDetail = "no manifest sidecar";
  if (manifest) {
    const claimsSha = String(manifest.json.sha256 ?? "") === artifact.artifactSha256;
    const actualManifestHash = sha256Hex(manifest.bytes);
    const untampered = manifest.storedSha256 === undefined || manifest.storedSha256 === actualManifestHash;
    manifestOk = claimsSha && untampered;
    manifestDetail = !claimsSha
      ? "manifest sha ≠ artifact sha"
      : !untampered
        ? "tampered (hash ≠ recorded)"
        : `${actualManifestHash.slice(0, 12)}…`;
  }
  checks.push({ name: "Manifest", ok: manifestOk, detail: manifestDetail });

  if (artifact.type === "xlsx" || artifact.type === "docx") {
    const o = exists ? checkOoxml(fileBytes!) : { ok: false, detail: "—" };
    checks.push({ name: "OOXML", ok: o.ok, detail: o.detail });
  } else {
    checks.push({ name: "OOXML", ok: true, detail: `n/a (${artifact.type})` });
  }

  checks.push({
    name: "Deterministic",
    ok: artifact.deterministic,
    detail: artifact.deterministic ? "engine claims determinism" : "not claimed",
  });

  const meta: Record<string, string> = { sha256: artifact.artifactSha256 };
  const m = manifest?.json;
  if (m?.capability) meta.engine = `${m.capability}${m.engine_version ? ` (engine ${m.engine_version})` : ""}`;
  else meta.engine = `${artifact.type} (engine ${artifact.engineVersion})`;
  if (m?.generated_at) meta.generated = String(m.generated_at);
  if (m?.duration_ms != null) meta.duration = `${m.duration_ms} ms`;
  if (m?.cache_hit != null) meta.cache_hit = m.cache_hit ? "yes" : "no";

  return {
    artifact: basename(artifact.path),
    found: true,
    ok: checks.every((c) => c.ok),
    checks,
    meta,
  };
}

/** Resolve an artifact + its sidecar from the store/filesystem and verify it. */
export function verifyArtifact(store: Store, shaPrefix: string): VerifyReport {
  const artifact = store.findArtifactBySha(shaPrefix);
  if (!artifact) {
    return { artifact: shaPrefix, found: false, ok: false, checks: [], meta: {} };
  }
  const fileBytes = existsSync(artifact.path) ? new Uint8Array(readFileSync(artifact.path)) : undefined;

  let manifest: ManifestSidecar | undefined;
  for (const run of store.runsForArtifactSha(artifact.artifactSha256)) {
    const mp = store.manifestPath(run.id);
    if (existsSync(mp)) {
      const bytes = new Uint8Array(readFileSync(mp));
      manifest = {
        json: JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>,
        bytes,
        storedSha256: run.manifestSha256,
      };
      break;
    }
  }

  return buildVerifyReport(artifact, fileBytes, manifest);
}
