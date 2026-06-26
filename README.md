# invoker

> A deterministic capability runtime for artifact-producing workloads.

`invoker` fetches facts (JSON) and renders artifacts (xlsx / docx / svg / pdf) **locally**,
on a schedule or on demand. The intelligence — planning, deciding, summarizing — lives
elsewhere (your Business AI). `invoker` is the hands, not the brain.

```sh
curl -fsSL https://invoker.sh/install | bash
invoker init
invoker plugin install doeh          # domain knowledge arrives as a plugin
invoker schedule                     # run jobs unattended
```

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
