import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/db.ts";
import { registry } from "../src/core/registry.ts";
import { tabularMap } from "../src/engines/tabular/index.ts";
import { excelRender } from "../src/engines/excel/index.ts";
import { runJob } from "../src/core/runner.ts";
import { verifyArtifact, checkOoxml } from "../src/core/verify.ts";
import { SchedulePolicy, type ScheduledJob } from "../src/core/scheduler.ts";
import type { FetchProvider } from "../src/providers/index.ts";

function ensureCaps() {
  for (const c of [tabularMap, excelRender]) {
    if (!registry.has(c.id, c.contractVersion)) registry.register(c);
  }
}

const fetcher: FetchProvider = {
  async fetchJson() {
    return { sheet: "Sales", columns: [{ id: "item", header: "Item" }], rows: [["Tea"], ["Coffee"]] };
  },
};

function job(): ScheduledJob {
  return {
    id: "daily",
    name: "Yesterday Sales",
    capability: "excel.render",
    contractVersion: 1,
    source: "https://example.test/api",
    cron: "",
    policy: SchedulePolicy.CatchUp,
    maxLagMs: 86_400_000,
    enabled: true,
  };
}

async function withRenderedArtifact(
  fn: (store: Store, sha: string, path: string) => Promise<void> | void,
) {
  ensureCaps();
  const dir = mkdtempSync(join(tmpdir(), "invoker-verify-"));
  const store = new Store(dir);
  try {
    const j = job();
    store.upsertJob(j);
    const result = await runJob(j, store, fetcher);
    await fn(store, result.artifact!.artifactSha256, result.artifact!.path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a freshly rendered artifact verifies clean end to end", async () => {
  await withRenderedArtifact((store, sha) => {
    const r = verifyArtifact(store, sha);
    expect(r.found).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["Exists", "SHA256", "Size", "Manifest", "OOXML", "Deterministic"]);
    expect(r.meta.engine).toContain("excel.render");
    expect(r.meta.cache_hit).toBe("no");
  });
});

test("a short sha PREFIX resolves the artifact", async () => {
  await withRenderedArtifact((store, sha) => {
    expect(verifyArtifact(store, sha.slice(0, 10)).ok).toBe(true);
  });
});

test("corrupting the artifact bytes fails SHA256, Size, and OOXML", async () => {
  await withRenderedArtifact((store, sha, path) => {
    writeFileSync(path, "garbage not a zip");
    const r = verifyArtifact(store, sha);
    expect(r.ok).toBe(false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toContain("SHA256");
    expect(failed).toContain("Size");
    expect(failed).toContain("OOXML");
  });
});

test("deleting the artifact file fails Exists", async () => {
  await withRenderedArtifact((store, sha, path) => {
    rmSync(path);
    const r = verifyArtifact(store, sha);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "Exists")!.ok).toBe(false);
  });
});

test("tampering with the manifest sidecar fails the Manifest check", async () => {
  await withRenderedArtifact((store, sha) => {
    // The manifest lives at <runId>.manifest.json; find it via the run that produced this sha.
    const run = store.runsForArtifactSha(sha)[0]!;
    const mp = store.manifestPath(run.id);
    const tampered = JSON.parse(readFileSync(mp, "utf8"));
    tampered.duration_ms = 999999; // change a field → sidecar bytes no longer hash to the recorded value
    writeFileSync(mp, JSON.stringify(tampered, null, 2));

    const r = verifyArtifact(store, sha);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "Manifest")!.ok).toBe(false);
  });
});

test("verifying an unknown sha reports not-found, not a crash", async () => {
  await withRenderedArtifact((store) => {
    const r = verifyArtifact(store, "deadbeef");
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
  });
});

test("checkOoxml accepts a real package and rejects garbage", async () => {
  await withRenderedArtifact((_store, _sha, path) => {
    expect(checkOoxml(new Uint8Array(readFileSync(path))).ok).toBe(true);
    expect(checkOoxml(new TextEncoder().encode("nope")).ok).toBe(false);
  });
});
