import { sha256Hex } from "../core/hash.ts";

/**
 * The determinism conformance gate (ADR-007). Render the same input N times and assert
 * a single unique sha256. Default N=10: two passes will not catch intermittent
 * nondeterminism (UUIDs, temp files, occasional timestamps).
 */
export async function assertDeterministic(
  render: () => Promise<Uint8Array>,
  passes = 10,
): Promise<{ ok: boolean; hash?: string; hashes: string[] }> {
  const hashes: string[] = [];
  for (let i = 0; i < passes; i++) {
    hashes.push(sha256Hex(await render()));
  }
  const unique = new Set(hashes);
  return { ok: unique.size === 1, hash: unique.size === 1 ? hashes[0] : undefined, hashes };
}
