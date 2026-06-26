#!/usr/bin/env bun
// Transport #1 (ADR-002/003). Translates CLI args into an InvokeRequest and back.
// Holds NO render or business logic — it only drives invoke().

import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { registry } from "../../core/registry.ts";
import { invoke } from "../../core/invoke.ts";
import { Store } from "../../storage/db.ts";
import { excelRender } from "../../engines/excel/index.ts";
import { HttpFetchProvider } from "../../core/fetch.ts";
import { runJob, dueJobs } from "../../core/runner.ts";
import { SchedulePolicy, type ScheduledJob } from "../../core/scheduler.ts";

const WORKSPACE = process.env.INVOKER_HOME ?? join(homedir(), ".invoker");

// Built-in engines register here. Domain capabilities arrive via plugins (ADR-001/008).
function bootstrap(): void {
  if (!registry.has(excelRender.id, excelRender.contractVersion)) registry.register(excelRender);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  bootstrap();

  switch (cmd) {
    case "init":
      return cmdInit();
    case "invoke":
      return cmdInvoke(rest);
    case "capabilities":
      return cmdCapabilities();
    case "jobs":
      return cmdJobs(rest);
    case "run":
      return cmdRun(rest);
    case "tick":
      return cmdTick(rest);
    case undefined:
    case "help":
    case "--help":
      return usage();
    default:
      console.error(`unknown command: ${cmd}`);
      return usage(1);
  }
}

function cmdInit(): number {
  new Store(WORKSPACE).close();
  console.log(`workspace ready at ${WORKSPACE}`);
  return 0;
}

function cmdCapabilities(): number {
  for (const c of registry.list()) {
    console.log(
      `${c.id}@v${c.contractVersion}  engine=${c.engineVersion}  ` +
        `deterministic=${c.deterministic}  cacheable=${c.cacheable}`,
    );
  }
  return 0;
}

/** invoker invoke <capability> --data <file.json> [--dry-run] [--contract N] */
async function cmdInvoke(args: string[]): Promise<number> {
  const capability = args[0];
  if (!capability) {
    console.error("usage: invoker invoke <capability> --data <file.json> [--dry-run]");
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const dataPath = optValue(args, "--data");
  const contractVersion = Number(optValue(args, "--contract") ?? "1");

  const data = dataPath
    ? ((await Bun.file(dataPath).json()) as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  const store = new Store(WORKSPACE);
  try {
    const result = await invoke(
      { id: randomUUID(), capability, contractVersion, params: {}, data, dryRun },
      store,
    );
    if (result.dryRun) {
      console.log(`cacheKey  ${result.cacheKey}`);
      console.log(`status    ${result.cacheHit ? "HIT" : "MISS"}`);
      console.log(`artifact  unknown (skipped)`);
    } else {
      const a = result.artifact!;
      console.log(`${result.cacheHit ? "cache hit" : "rendered"} in ${result.durationMs}ms`);
      console.log(`path      ${a.path}`);
      console.log(`sha256    ${a.artifactSha256}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** invoker jobs add --id <id> --name <n> --cap <c> --cron "<expr>" [--source url] [--template t] [--policy catchup|skip|resume] [--max-lag ms] */
function cmdJobs(args: string[]): number {
  const sub = args[0];
  const store = new Store(WORKSPACE);
  try {
    if (sub === "list") {
      for (const j of store.listJobs()) {
        console.log(
          `${j.id}  ${j.name}  ${j.capability}@v${j.contractVersion}  cron="${j.cron}"  ` +
            `policy=${j.policy}  ${j.enabled ? "enabled" : "disabled"}`,
        );
      }
      return 0;
    }
    if (sub === "add") {
      const rest = args.slice(1);
      const job: ScheduledJob = {
        id: required(rest, "--id"),
        name: optValue(rest, "--name") ?? required(rest, "--id"),
        capability: required(rest, "--cap"),
        contractVersion: Number(optValue(rest, "--contract") ?? "1"),
        source: optValue(rest, "--source"),
        template: optValue(rest, "--template"),
        cron: required(rest, "--cron"),
        policy: (optValue(rest, "--policy") as SchedulePolicy) ?? SchedulePolicy.CatchUp,
        maxLagMs: Number(optValue(rest, "--max-lag") ?? String(24 * 60 * 60 * 1000)),
        enabled: true,
      };
      store.upsertJob(job);
      console.log(`job '${job.id}' saved (${job.capability}, cron="${job.cron}", policy=${job.policy})`);
      return 0;
    }
    console.error("usage: invoker jobs <list|add ...>");
    return 1;
  } finally {
    store.close();
  }
}

/** invoker run <jobId> — force-run a job now, regardless of schedule. */
async function cmdRun(args: string[]): Promise<number> {
  const jobId = args[0];
  if (!jobId) {
    console.error("usage: invoker run <jobId>");
    return 1;
  }
  const store = new Store(WORKSPACE);
  try {
    const job = store.getJob(jobId);
    if (!job) {
      console.error(`no such job: ${jobId}`);
      return 1;
    }
    const result = await runJob(job, store, makeFetcher());
    reportResult(result);
    return 0;
  } finally {
    store.close();
  }
}

/** invoker tick — run every job that is due now under its missed-run policy. */
async function cmdTick(_args: string[]): Promise<number> {
  const store = new Store(WORKSPACE);
  try {
    const due = dueJobs(store.listJobs(), store);
    if (due.length === 0) {
      console.log("no jobs due");
      return 0;
    }
    for (const job of due) {
      console.log(`running due job '${job.id}'…`);
      const result = await runJob(job, store, makeFetcher());
      reportResult(result);
    }
    return 0;
  } finally {
    store.close();
  }
}

function makeFetcher(): HttpFetchProvider {
  // Token reference (env:/file:/keychain:/exec:) supplied out-of-band; never inline (ADR-005).
  return new HttpFetchProvider({ tokenRef: process.env.INVOKER_TOKEN_REF });
}

function reportResult(result: { dryRun: boolean; cacheHit: boolean; durationMs: number; artifact?: { path: string; artifactSha256: string } }): void {
  const a = result.artifact!;
  console.log(`${result.cacheHit ? "cache hit" : "rendered"} in ${result.durationMs}ms`);
  console.log(`path      ${a.path}`);
  console.log(`sha256    ${a.artifactSha256}`);
}

function required(args: string[], flag: string): string {
  const v = optValue(args, flag);
  if (v === undefined) throw new Error(`missing required flag: ${flag}`);
  return v;
}

function optValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(code = 0): number {
  console.log(
    [
      "invoker — a deterministic capability runtime for artifact-producing workloads",
      "",
      "  invoker init                                  create the local workspace",
      "  invoker capabilities                          list registered capabilities",
      "  invoker invoke <cap> --data f.json [--dry-run]  run one capability",
      "",
      "  invoker jobs add --id <id> --cap <c> --cron \"<expr>\" [--source url] [--template t] [--policy catchup|skip|resume]",
      "  invoker jobs list                             list scheduled jobs",
      "  invoker run <jobId>                           force-run a job now",
      "  invoker tick                                  run every job due under its policy",
      "",
      "  (mcp, ws, tauri transports: see ARCHITECTURE.md roadmap)",
    ].join("\n"),
  );
  return code;
}

process.exit(await main(process.argv.slice(2)));
