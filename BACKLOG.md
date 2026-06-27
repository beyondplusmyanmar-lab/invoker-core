# Backlog

Post-pilot items. Nothing here is built; nothing here changes the frozen
v0.2.0-rc1 surface. Priorities are validated **by pilot evidence**, not
speculation — an item becomes a real driver when operator feedback demands it.

## P0 — `table.format@v1` (presentation operator)

**Why deferred:** the daily-sales report renders correct but raw — ISO date
strings (`2026-06-25T08:15:00.000Z`), bare numbers (`12000`), and voided orders
listed alongside completed ones. The fix does **not** belong in `excel.render`.

### The seam

```
DOEH mapping → tabular.map → table.format@v1 → excel.render
                (normalize)    (presentation)     (OOXML emit)
```

Today the pipeline is `tabular.map → excel.render`, and the division of labour
is deliberate:

- `tabular.map`'s `coerce()` **normalizes for determinism, not display**: dates
  become ISO strings, currency becomes a raw `Number`. ISO + raw numbers are
  what make the artifact byte-stable.
- `excel.render` is a **pure emitter**: value in → cell out. It ignores column
  `type`.

The moment `excel.render` starts branching on type (`if date → numFmt …`) it
stops being a deterministic emitter and becomes a presentation **policy engine** —
a capability expansion that would move canonical artifact shas, cache keys,
support bundles, and verification baselines. That is precisely what the pilot
freeze exists to prevent. So presentation gets its own operator instead.

### Properties (the reason this stays clean)

- Formatting remains **data, not code** — a declarative spec, like `tabular.map`.
- `excel.render` stays an emitter; `docx.render` (and future engines) can consume
  the **same** formatting metadata.
- **Deterministic:** a fixed format spec yields fixed bytes. Two hard rules:
  - the filter is a **structured predicate, never a parsed expression string** —
    an `expr`/`where` mini-language would reintroduce exactly what `tabular.map`
    forbids ("no expressions"), breaking auditability and determinism.
  - the formatter is **locale-pinned** — date patterns and digit grouping are
    locale-sensitive; a determinism operator can no more read ambient locale than
    ambient timezone (already pinned to UTC, ADR-007). Locale is fixed in-operator.
- A **presentation** operator, distinct from the canonicalization/determinism
  operators (`table.sort`/`group`/`aggregate`) — it shapes display, not order.

### Sketch (illustrative, not final)

```toml
[[format.columns]]
id = "sale_date"
display = "date"
pattern = "yyyy-mm-dd"          # locale-pinned

[[format.columns]]
id = "total"
display = "money"
currency = "MMK"
decimals = 0
grouping = true                 # 12,000

# Structured predicate — NOT an expression string.
[[format.filters]]
column = "status"
not_in = ["voided"]
```

### Sub-items (all included in `table.format@v1`, all pilot-impact: none)

| Item | Notes |
|------|-------|
| Date display patterns | locale-pinned; coexists with the ISO normalization |
| Currency formatting | currency + decimals/scale + grouping; minor-units aware (ADR-002) |
| Declarative row filtering | structured predicates only (e.g. `not_in`, `equals`, `in`) |
| Excel autofilter / freeze panes | nice-to-have; emitter-level, no policy |

## P1 — Secret-reference management in the UI

**Invariant (the reviewer rule):**

> The UI MAY transport, store, and display a **SecretRef**.
> The UI MAY NEVER transport, store, display, copy, reveal, or persist a **SecretValue**.

A `SecretRef` is `keychain:doeh/api` / `env:…` / `file:…` / `exec:…`. A `SecretValue`
is the resolved token behind it (`sk_…`, a bearer, the file bytes). This is a flat
rule, not a case-by-case judgement — a PR proposing "add a Show Token button" is
rejected on sight because it transports a `SecretValue`. The browser ever sees only
`{ "reference": "keychain:doeh/api", "status": "ok" }`, never `{ "secret": "sk_…" }`:
no reveal, no copy, no plaintext, no DB row, no support-bundle inclusion of a value.

| Phase | Capability | Notes |
|-------|-----------|-------|
| rc1 (now) | `doctor` + support bundle | **already shipped** |
| rc2 | reference editor + Test button | reuses `resolveSecret()` reject + `testFetch()` |
| rc2.1 | persist credential health | `last_success` / `last_failure` / `error` / `updated_at` |
| v0.3 | credentials dashboard | read-only view over the rc2.1 persisted state |

**rc1 — already met, no build.** `doctor`'s Secrets check resolves the configured
`INVOKER_TOKEN_REF` and reports `token ref resolves (keychain:…)` — only the scheme
prefix, never the value (inline secret → fail; unresolvable → warn + suggestion).
The support bundle's `doctor.json` carries it. A status *card* in the dashboard is
deferred not just by the freeze but because its `Last Resolve` / per-source status
is durable instrumentation invoker doesn't have (doctor resolves on-demand and
persists nothing) — so the card is new backend state + UI, i.e. rc2, not "purely
observational."

**rc2 — edit references, never secrets.** Settings page accepts a reference string
for each source and validates it server-side, reusing what already exists:
`resolveSecret`'s `RAW_SECRET` reject (`sk_`/`pk_`/`ghp_`/`xox…` → refused) +
scheme check + a `testFetch`. Accept `env:`/`file:`/`keychain:`/`exec:`; reject any
literal token or `Bearer …`. The POST body carries the reference, never a value.

**rc2.1 — persist credential health.** The durable instrumentation a dashboard
needs, and the reason a "view-only card" is NOT rc1: a `credential_status` row per
source (`reference`, `last_success`, `last_failure`, `error`, `updated_at`), written
when a resolve/fetch actually happens. Without it a card would either re-resolve on
every page refresh or show synthetic data — neither acceptable in a freeze. Stores
status, never the value.

**v0.3 — credentials dashboard.** A read-only view over the rc2.1 state. Per source
(DOEH / BusinessAI / Notifications): reference, resolver, last_success, last_failure,
error. `credential_status` metadata only — the invariant holds: no reveal, no copy,
no plaintext, no persistence of the value.

## Gating principle

`table.format@v1` is the **first unfreeze item after the pilot** — but only if the
pilot produces evidence for it. If a branch manager consumes the raw report fine
for seven days, the pilot validated the right thing (does the operational model
survive reality?). If feedback is "I couldn't read the dates or the money," that
observation *is* the evidence that promotes this from speculative enhancement to
P0 driver. Either way, the decision is made with data, not taste.
