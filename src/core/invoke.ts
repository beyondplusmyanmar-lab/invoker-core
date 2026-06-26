import type { Artifact, InvokeRequest, InvokeResult } from "../abi/index.ts";
import { registry } from "./registry.ts";
import { jsonHash, sha256Hex } from "./hash.ts";
import type { Store } from "../storage/db.ts";

/**
 * The cache key (ADR-006): computable BEFORE rendering. Combines the three version
 * dimensions + the stable hash of the input data. Drives the cheap skip and --dry-run.
 */
export function computeCacheKey(req: InvokeRequest, engineVersion: string): string {
  return sha256Hex(
    [
      req.capability,
      `c${req.contractVersion}`,
      `e${engineVersion}`,
      `t${req.template ?? ""}`,
      `tv${req.templateVersion ?? ""}`,
      `d${jsonHash(req.data ?? req.params)}`,
    ].join("|"),
  );
}

/**
 * The single convergence point (ADR-002). Every transport funnels through here.
 * Contains orchestration of fetch→cache→render→persist, but no business logic.
 */
export async function invoke(req: InvokeRequest, store: Store): Promise<InvokeResult> {
  const started = performance.now();
  const cap = registry.resolve(req.capability, req.contractVersion);
  const cacheKey = computeCacheKey(req, cap.engineVersion);

  if (cap.cacheable) {
    const cached = store.findArtifactByCacheKey(cacheKey);
    if (cached) {
      return { artifact: cached, cacheKey, cacheHit: true, durationMs: elapsed(started), dryRun: !!req.dryRun };
    }
  }

  // Dry-run: we know the cacheKey and that it missed; render nothing (ADR-006).
  if (req.dryRun) {
    return { cacheKey, cacheHit: false, durationMs: elapsed(started), dryRun: true };
  }

  const out = await cap.execute({ request: req, data: req.data ?? {} });
  const artifactSha256 = sha256Hex(out.bytes);
  const path = store.artifactPath(req.id, out.type);
  await Bun.write(path, out.bytes);

  const artifact: Artifact = {
    id: req.id,
    type: out.type,
    mime: out.mime,
    path,
    size: out.bytes.byteLength,
    cacheKey,
    artifactSha256,
    engineVersion: cap.engineVersion,
    templateVersion: req.templateVersion,
    deterministic: cap.deterministic,
    createdAt: Date.now(),
  };
  store.saveArtifact(artifact);

  return { artifact, cacheKey, cacheHit: false, durationMs: elapsed(started), dryRun: false };
}

const elapsed = (since: number): number => Math.round(performance.now() - since);
