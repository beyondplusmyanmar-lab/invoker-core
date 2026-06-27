# invoker

> A deterministic capability runtime for artifact-producing workloads.

`invoker` fetches facts (JSON) and renders artifacts (xlsx / docx / svg / pdf) **locally**,
on a schedule or on demand. The intelligence — planning, deciding, summarizing — lives
elsewhere (your Business AI). `invoker` is the hands, not the brain.

## Install & run

From source ([Bun](https://bun.sh) required):

```sh
git clone git@github.com:beyondplusmyanmar-lab/invoker-core.git
cd invoker-core && bun install
bun link                       # exposes the `invoker` command
                               # (or run directly: bun run src/transports/cli/index.ts …)
invoker init
invoker doctor                 # operability sweep
invoker daemon start           # run scheduled jobs unattended
```

### Standalone binary

Compile one self-contained file. It embeds the runtime **and** the schema, so
**Bun is not required on the target machine** — copy the single binary and run it:

```sh
bun build ./src/transports/cli/index.ts --compile --outfile invoker
./invoker init && ./invoker doctor
```

Cross-build for another machine, then copy the file over:

```sh
bun build ./src/transports/cli/index.ts --compile \
  --target=bun-darwin-arm64 --outfile invoker      # the pilot laptop
```

Targets: `bun-darwin-arm64` · `bun-darwin-x64` · `bun-linux-x64` ·
`bun-windows-x64`. (A hosted one-line installer is planned, not yet available.)

## What it is

- **Runtime first.** The CLI is merely transport #1. Scheduler, MCP, and a future Tauri UI
  are additional transports over the same `invoke()` core.
- **Deterministic.** The same data + template + engine produces a byte-identical artifact
  (verified, not assumed — see the ×10 conformance gate).
- **Domain-agnostic.** Core never knows what a "report" is. It knows how to fetch, schedule,
  invoke, cache, and render. Everything domain-specific arrives as a plugin.

## What it is not

- Not an AI. It contains no planner and no LLM. (ADR-009.)
- Not a server. Desktop connections are **outbound-only** — it never opens an inbound port.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the nine invariants this codebase is built to protect.

## Layout

```
src/
  abi/         stable types: Artifact, InvokeRequest/Result, CapabilityDescriptor
  core/        invoke() convergence point, registry, scheduler, secrets
  providers/   Auth / Fetch / Template / Capability interfaces (implementations live in plugins)
  engines/     render engines (excel, …) + per-engine determinism conformance
  plugins/     explicit, versioned, trust-tiered plugin loader
  storage/     SQLite: jobs, runs, artifacts, cache, plugins, templates, scheduler_state
  transports/  cli/ (and later: ws/, mcp/, tauri/)
tests/         determinism gate, etc.
```
