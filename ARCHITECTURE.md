# Architecture & Invariants

`invoker-core` is **a deterministic capability runtime for artifact-producing workloads**:
a stable capability ABI, a transport-agnostic execution model, explicit plugin boundaries,
reproducible artifacts, outbound-only connectivity, and Business AI retained as the sole
orchestration authority.

The invariants below are load-bearing. They exist to stop the runtime from slowly turning
into "another orchestrator" or leaking business-specific assumptions into a public repo.
Treat them as the contract a change must not break.

---

## The three version dimensions

Never collapsed into one string. They change for different reasons and feed different machinery.

| Dimension          | Type     | Example       | Changes when…                          | Effect of a bump                          |
|--------------------|----------|---------------|----------------------------------------|-------------------------------------------|
| `capabilityId`     | string   | `excel.render`| a new capability is added              | new registry entry                        |
| `contractVersion`  | number   | `1`           | the input/output **schema** breaks     | callers (CLI/MCP/AI) must migrate; rare   |
| `engineVersion`    | semver   | `1.4.2`       | the rendering **code** changes         | cache invalidates; contract unchanged     |
| `templateVersion`  | semver   | `2.0`         | a template's layout/mapping changes    | cache invalidates; contract unchanged     |

Binding key (what a caller resolves): `excel.render@v1`.
Cache key (what determines "already rendered"): `hash(capabilityId, contractVersion, engineVersion, template, templateVersion, jsonHash(data))`.

Consequence: a rendering **bugfix** bumps `engineVersion` → the cache misses and re-renders →
the **public contract stays frozen**. You don't break every caller to fix a cell border.

---

## ADRs / Invariants

### ADR-001 — Core never imports DOEH (nor any domain)
The dependency arrow points *into* core only: `core ← plugin ← BusinessAI`. The public runtime
knows how to fetch, schedule, invoke, cache, and render. It must never know what a "report",
a "shop", a "payroll", or a "sandbox" is. Domain knowledge arrives exclusively through plugins.

### ADR-002 — The capability registry is the convergence point
Every transport (CLI, scheduler, MCP, UI) funnels through one call: `invoke(req) → InvokeResult`.
No transport contains execution logic. Add a transport = attach a new caller to the registry.

### ADR-003 — Transports only
CLI, WebSocket, MCP, Tauri are *transports*, not subsystems. They translate an external trigger
into an `InvokeRequest` and translate an `InvokeResult` back. They hold no business or render logic.

### ADR-004 — Outbound-only connectivity
A desktop node never opens an inbound port. All server↔desktop communication rides a single
outbound connection (HTTPS / SSE / WS). No TCP listen, no port exposure, no hole-punching by default.
Firewall- and NAT-friendly at 10,000 nodes; smaller public attack surface.

### ADR-005 — Secrets are references, never values
Config carries a *reference* (`env:` / `file:` / `keychain:` / `exec:`), never a raw secret.
A value matching a known secret prefix (e.g. `sk_`) in config is a hard error. The `AuthProvider`
resolves references at runtime; raw secrets never sit in a committed-shaped file.

### ADR-006 — cacheKey ≠ artifactSha256
Two distinct hashes with two distinct jobs:
- **cacheKey** — computable *before* rendering; drives the cheap skip and `--dry-run` prediction.
- **artifactSha256** — hash of produced bytes; only known *after*; the integrity identity.
Stored as separate columns. A dry-run reports a cacheKey HIT/MISS; the artifactSha256 is "unknown (skipped)".

### ADR-007 — Determinism is tested, not assumed
xlsx/docx/pdf are *not* byte-identical by default (embedded timestamps, zip mtimes/order, random IDs).
Determinism is a capability an engine must actively enforce (fixed dates, normalized zip, stripped IDs).
Every engine declaring `deterministic: true` must pass a **×10 conformance gate** in CI:
render the same input ten times → one unique sha256. Two passes is not enough to catch
intermittent UUID/temp-file/timestamp nondeterminism.

### ADR-008 — Plugins are explicit, versioned, and auditable
No magic auto-discovery. A plugin is installed (`invoker plugin install <name>`), recorded in
SQLite with its `manifest_hash`, and loaded only if registered. Trust tiers:
`UNVERIFIED → VERIFIED → TRUSTED → REQUIRED`. Signing is a *trust tier*, not a gate: core
**warns, does not block** on unverified plugins (so a third-party `plugin-sap` can exist),
unless launched with `--require-signed`.

### ADR-009 — Business AI owns orchestration; invoker owns execution
**Business AI:** plan, decide, summarize, reason.
**Invoker:** fetch, render, cache, schedule, persist.
The runtime contains **no embedded planner and no LLM**, now or later. If someone proposes
"let's put a small model inside invoker," that is a violation of this ADR — the runtime would
start becoming a second orchestrator. Intelligence stays centralized in Business AI.

### ADR-010 — The Brain↔Hands wire ABI is the artifact request *(Proposed, post-v0.1.0-alpha — implements ADR-009)*
The concrete contract operationalizing ADR-009. Business AI may speak any transport (CLI, HTTP,
SSE, WebSocket, NATS JetStream, MCP, cron, future). **All of them normalize to one message —
the runtime never observes transport semantics, and never observes tokens, chat, conversations,
deltas, or reasoning traces.** *Business AI streams thoughts; invoker executes intents.*

```ts
interface ArtifactRequest {                 // Brain → Hands. No data, no secrets.
  correlationId: string;                    // transport metadata; NOT cache identity
  capability: CapabilityId;
  contractVersion: number;
  template?: string;
  params: Record<string, unknown>;
}
type ArtifactResult =                        // Hands → Brain. Discriminated; no illegal states.
  | { correlationId: string; status: "success"; cacheKey: string;
      artifactSha256: string; artifactHandle: string; cacheHit: boolean }
  | { correlationId: string; status: "failed"; error: TransportError };
interface TransportError { code: string; retryable: boolean; message?: string }
//  BAD_REQUEST / CAPABILITY_NOT_FOUND / TEMPLATE_NOT_FOUND → retryable:false
//  UPSTREAM_FETCH_FAILED → retryable:true ;  RENDER_FAILED → retryable:false
//  Consumers switch on `code`; they MUST NOT parse `message`.
```

**Data provenance (normative).** The Brain sends *intent*, never *facts*. `ArtifactRequest`
deliberately omits the `data` field that `InvokeRequest` carries: the runtime resolves facts via
the template's declared source —
`ArtifactRequest → FetchProvider.resolve() → InvokeRequest (data filled) → invoke()`.
This buys replayability, small requests, credential isolation, runtime-owned fetch policy, and
prevents ad-hoc payload injection by the Brain.

**Terminal-only (normative).** `invoke()` may yield a `DataOutput` (intermediate `tabular.map`,
future `table.sort`). Those are pipeline-internal and **never cross to the Brain** — the boundary
speaks only terminal artifacts. Leaking a `TableModel`/`CapabilityOutput` back to the Brain would
make it re-orchestrate the runtime's working memory, violating ADR-009. ("Never in files"
extended to "never in intermediate data.")

**Identity & idempotency.** `correlationId` is transport metadata only; it does not participate
in cache identity (this supersedes the legacy "idempotency/run id" comment on `InvokeRequest.id`).
Content identity stays `cacheKey`; integrity identity stays `artifactSha256` (ADR-006). A resent
identical request therefore dedupes for free — but **request idempotency holds iff the underlying
collection is immutable** (a closed window). Same `{from,to}` over an *open* window re-fetches and
may legitimately differ; this is the collection-stability precondition (ADR-007 / future ADR-011)
resurfacing at the transport boundary.

**Security boundary.** An `ArtifactRequest` carries references, never credentials (ADR-005 rejects
inline `sk_`). It is therefore safe to log, persist, replay, schedule, and audit, and Business AI
stays entirely outside the credential blast radius.

---

## Scheduler policies

A desktop is often asleep/off at a cron tick. Each job declares a missed-run policy; last-run
state lives in `scheduler_state`.

- **CatchUp** — run missed ticks on wake, bounded by `maxLag` (recommended for reports).
- **Skip** — only fire if the machine is up at the tick.
- **Resume** — run once on next launch regardless of how many ticks were missed.
