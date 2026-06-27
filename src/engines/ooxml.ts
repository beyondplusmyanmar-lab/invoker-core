import { unzipSync, zipSync } from "fflate";

/**
 * Shared OOXML zip canonicalizer (ADR-007). xlsx and docx are both ZIP-of-XML packages, so
 * they MUST share ONE deterministic zip emitter — a second canonicalizer that could drift would
 * inject nondeterminism into the determinism layer. Canonicalize once, use everywhere.
 *
 * The ZIP format's epoch is 1980-01-01; fflate rejects earlier mtimes. Every entry is pinned to
 * it, and entries are emitted in sorted order so the package layout is byte-stable.
 */
export const FIXED_MTIME = new Date("1980-01-01T00:00:00Z");

/** Zip a set of parts deterministically: sorted entry order, fixed mtime. */
export function zipDeterministic(parts: Record<string, Uint8Array>): Uint8Array {
  const sorted: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const name of Object.keys(parts).sort()) {
    sorted[name] = [parts[name]!, { mtime: FIXED_MTIME, level: 6 }];
  }
  return zipSync(sorted, { mtime: FIXED_MTIME });
}

/** Re-emit an existing zip (e.g. exceljs output) with deterministic order + fixed mtime. */
export function normalizeZip(bytes: Uint8Array): Uint8Array {
  return zipDeterministic(unzipSync(bytes));
}
