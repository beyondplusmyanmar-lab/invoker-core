# Post-Pilot Execution Plan — Invoker v0.2.0-rc1

Prepared **during** Pilot A (offline reliability soak) so that Day 7 is an
*execution* decision, not a *planning* one. Nothing here is built or merged
while the pilot runs — see the freeze framework below. The pilot protocol is
[PILOT.md](PILOT.md); the running evidence is [pilot-ledger.md](pilot-ledger.md).

## Freeze framework — what is allowed during the pilot

The rule that keeps thinking unfrozen while the release stays frozen: **prepare,
design, prioritize, and document during the pilot; build and merge only after
the pilot concludes** (unless a genuine P0 correctness bug emerges).

### ✅ Safe during the pilot — *preparation* (does not change rc1 behavior)
- Refine ADRs and design docs.
- Write specifications (e.g. `table.format@v1`).
- Organize the backlog (P0 / P1 / P2).
- Investigate architecture; identify technical debt.
- Prototype in **throwaway branches that never merge into main**.
- Prepare migration plans and rollout runbooks.
- Review security and deployment processes.

This is engineering *planning*, not product *expansion*.

### ⚠️ Maybe — only if **completely isolated** from the release under test
- A separate `rc2` branch.
- A prototype repository.
- Experimental benchmarking; internal research spikes.

**Hard rule:** nothing from this work is deployed to the pilot laptop or merged
into the rc1 release branch before the pilot review.

### ❌ Do NOT do during the pilot — anything that changes the artifact under test
Chat page · Settings page · Secret UI · Scheduler UI · `table.format` ·
multi-fetch · pagination · plugin marketplace · refactors · any new runtime
behavior. **Even "almost done" work invalidates the evidence being collected.**

## Highest-value preparation = DOEH, not invoker-core

DOEH work does not touch the invoker-core runtime being validated, so it is the
most productive thing to *plan and document* while Pilot A runs. The post-pilot
queue is already fairly clear; the table below is the execution sequence.

## Day 7 review checklist — run this BEFORE the execution sequence

This gate decides *whether* to proceed; the execution sequence below decides
*what* to proceed with. Do not read past it until every row is checked. Each row
names its instrument, because a gate whose only instrument is the ledger is not
green just because the ledger is empty (see the honesty map in
[PILOT.md](PILOT.md)).

| Gate | Instrument | Required |
|------|------------|----------|
| Seven-day evidence complete | `pilot-ledger.md` (Day 0 → Day 7; documented gaps are acceptable, silent gaps are not) | ✓ |
| Runtime unchanged | `pilot-collect` runtime fingerprint — `src/` + `package.json` + `bun.lock` + `tsconfig.json`, **not** HEAD | ✓ |
| RSS trend acceptable | daily RSS vs the 74.5 MB Day-0 baseline — no sustained growth | ✓ |
| No duplicate renders / corrupt artifacts / missed schedules / SQLite recoveries | `doctor --pilot` (machine) | ✓ (all 0) |
| No disk exhaustion | `health` + retention (machine-observable) | ✓ |
| Operator confusion ≤ target | per-day `notes.txt` (human observation only — no machine sensor) | ✓ |
| No P0 correctness issue | the finding-triage ladder over all evidence | ✓ |
| Governance review signed | this document + ledger reviewed and dated | ✓ |

**Decision:**

- **All PASS** → unlock the P0 DOEH implementation chain (below) **and** unfreeze rc2 as product work.
- **PARTIAL** (no data loss, usability issues only, no architectural assumption invalidated) → targeted v0.2.x fixes only; roadmap stays gated.
- **FAIL** (any correctness gate breached, or operator cannot complete the morning workflow) → suspend the roadmap; the failing gate becomes the next engineering task, now backed by real evidence.

## Execution sequence (post-pilot)

| Priority | Item | Prerequisite | Current state (verify before starting) |
|----------|------|--------------|----------------------------------------|
| P0 | Sandbox DB repoint (`config-sandbox.php` → `pos_site_sandbox`) | None | `INV-SANDBOX-1` is **GREEN** (pos_site_sandbox live, separate DB, deterministic reset) and Phase B demo-rider **CLOSED** (rider-sandbox live). Confirm the *narrow* remainder this item means — don't redo finished work. |
| P0 | Managed sandbox validation | Sandbox DB | — |
| P0 | Shared edge rollout governance | Validation passes | Edge is deployed+live on prod since 2026-06-13; "governance" = rollout discipline, not bring-up. |
| P0 | AUTH-4 / `orders:read` | Edge rollout | Unblocks invoker-core P1b live seam (the deferred DOEH GET /v1/orders). |
| P1 | `table.format@v1` (presentation operator) | Pilot review approves rc2 | Spec in [BACKLOG.md](BACKLOG.md). Evidence-gated: promote only if operator feedback shows the raw report is unreadable. |
| P1 | Secret-reference editor | Pilot review approves rc2 | Phased UI maturity model in BACKLOG.md; invariant = UI never sees a secret value. |
| P1 | Chat / Settings (rc2) | Pilot review approves rc2 | The originally-deferred rc2 surface. |
| P2 | Credentials dashboard | After rc2 | — |

## Sequencing logic

- **DOEH P0 chain first** — it is independent of the invoker-core runtime under
  test, so it can be *planned now* and *executed immediately* at Day 7
  regardless of the pilot outcome.
- **invoker-core P1 (rc2) is gated on the pilot review.** A PASS unfreezes rc2 as
  *product* work; a PARTIAL allows small v0.2.x improvements only; a FAIL makes
  the failing gate the next engineering task instead.
- **AUTH-4 / `orders:read` is the bridge:** it is the DOEH-side prerequisite that
  unblocks invoker-core's deferred live seam, and therefore Pilot B.

## Governance — this is a living queue, not a design document

Treat this plan as a queue under the same evidence-first discipline applied to
the codebase. While Pilot A runs:

- **Add** a new item only if it is backed by evidence from the pilot or an
  explicit governance decision.
- **Don't reorder** priorities unless the evidence changes.
- **Keep each entry traceable** to a pilot observation or a recorded decision —
  no speculative entries.

The next meaningful engineering decision should come from one of three sources —
a P0 gate failure, the Day-7 pilot review, or the DOEH integration phase — not
from speculative feature work.

## Relationship to Pilot B

Pilot B (live DOEH integration soak) cannot begin until both: (a) Pilot A passes,
and (b) the DOEH P0 chain — through AUTH-4 / `orders:read` — is in place. The
DOEH preparation done during Pilot A is what makes Pilot B startable promptly.
