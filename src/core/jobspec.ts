// P1a — import a job from a TOML file into a ScheduledJob. Generic and domain-agnostic
// (ADR-001): capabilities are opaque ids, params are opaque data. A step may inline `params`
// or reference a `params_file`/`mapping` (a TOML/JSON file whose contents become the step's
// params). Relative `file:` sources and param files are resolved to absolute at import time,
// anchored at the TOML's directory, so the stored job runs from anywhere.

import { dirname, isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileRefToPath } from "./fetch.ts";
import { SchedulePolicy, type ScheduledJob } from "./scheduler.ts";
import type { PipelineStep } from "./pipeline.ts";

interface RawStep {
  capability: string;
  contract_version?: number;
  params?: Record<string, unknown>;
  /** A file whose parsed contents become this step's params (alias: `mapping`). */
  params_file?: string;
  mapping?: string;
}

interface RawJob {
  id?: string;
  name?: string;
  capability?: string;
  contract_version?: number;
  source?: string;
  template?: string;
  cron?: string;
  policy?: string;
  max_lag_ms?: number;
  steps?: RawStep[];
}

/** Parse a TOML/JSON file by extension. Bun parses both natively. */
async function parseConfig(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  return path.endsWith(".json")
    ? (JSON.parse(text) as Record<string, unknown>)
    : (Bun.TOML.parse(text) as Record<string, unknown>);
}

export async function importJobSpec(tomlPath: string): Promise<ScheduledJob> {
  const abs = resolve(tomlPath);
  const dir = dirname(abs);
  const raw = (await parseConfig(abs)) as RawJob;

  const steps: PipelineStep[] = [];
  for (const s of raw.steps ?? []) {
    const [capId, vtag] = String(s.capability).split("@v");
    let params = s.params;
    const paramsFile = s.params_file ?? s.mapping;
    if (paramsFile) {
      const pAbs = resolve(dir, paramsFile);
      params = await parseConfig(pAbs);
    }
    steps.push({ capability: capId!, contractVersion: vtag ? Number(vtag) : 1, params });
  }

  // Resolve a relative file: source to an absolute one (anchored at the TOML's dir).
  let source = raw.source;
  if (source?.startsWith("file:")) {
    const p = fileRefToPath(source);
    source = `file:${isAbsolute(p) ? p : resolve(dir, p)}`;
  }

  const terminal = steps[steps.length - 1];
  const id = String(raw.id ?? slug(raw.name ?? "job"));
  const [capId, vtag] = String(raw.capability ?? "").split("@v");

  return {
    id,
    name: String(raw.name ?? id),
    capability: terminal?.capability ?? capId ?? "",
    contractVersion: terminal?.contractVersion ?? (vtag ? Number(vtag) : raw.contract_version ?? 1),
    source,
    template: raw.template,
    steps: steps.length ? steps : undefined,
    cron: raw.cron ? String(raw.cron) : "",
    policy: (raw.policy as SchedulePolicy) ?? SchedulePolicy.CatchUp,
    maxLagMs: Number(raw.max_lag_ms ?? 24 * 60 * 60 * 1000),
    enabled: true,
  };
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}
