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

## Gating principle

`table.format@v1` is the **first unfreeze item after the pilot** — but only if the
pilot produces evidence for it. If a branch manager consumes the raw report fine
for seven days, the pilot validated the right thing (does the operational model
survive reality?). If feedback is "I couldn't read the dates or the money," that
observation *is* the evidence that promotes this from speculative enhancement to
P0 driver. Either way, the decision is made with data, not taste.
