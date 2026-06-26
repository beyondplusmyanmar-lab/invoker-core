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
      "  (scheduler, plugin, mcp, ws transports: see ARCHITECTURE.md roadmap)",
    ].join("\n"),
  );
  return code;
}

process.exit(await main(process.argv.slice(2)));
