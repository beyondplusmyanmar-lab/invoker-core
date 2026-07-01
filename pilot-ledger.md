# Pilot Ledger — Invoker v0.2.0-rc1

Running record of the 7-day pilot. One row per day in the summary table; full
machine observations, notes, and assessment per day below it. Per-run snapshots
(and their support bundles) live under the git-ignored `pilot/`; this ledger is
the durable cross-day instrument reviewed on Day 7. See [PILOT.md](PILOT.md) for
the protocol and gates, and [PILOT-START.md](PILOT-START.md) for the start record.

## Summary

| Date | Build | Days | Uptime | Reports (Expected/Produced) | Duplicate Renders | Corrupt Artifacts | Missed Schedules | SQLite Recovery | Disk | RSS | Result | Operator Comments |
|------|-------|------|--------|------------------------------|-------------------|-------------------|------------------|-----------------|------|-----|--------|-------------------|
| 2026-06-29 | v0.2.0-rc1 @ 9a44d76 | 0 / 7 | 15h | 0 / 0 | 0 | 0 | 0 | 0 | 57.6 GB free, 1 artifact (6.8 KB) | 74.5 MB | PASS (Day 0 baseline) | Pending operator observations. |
| 2026-07-01 | pilot-shop-01 @ cc07e94 | 2 / 7 | 65h | — | 0 | 0 | 0 | 0 | 54 GB free | 74.9 MB | PASS | (auto; observations in pilot/20260701-074916/notes.txt) |
<!-- PILOT-COLLECT:APPEND-ABOVE — scripts/pilot-collect inserts each day's row immediately above this line. Keep it directly after the last table row (no blank line between) so the table stays contiguous. -->

## 2026-06-29 — Day 0 (baseline)

### Machine observations

- Snapshot: `pilot/20260629-054333`
- Host: `<redacted — real value in git-ignored pilot/identity.json>`
- `doctor --pilot`: `ok=true`, `passed=false` (expected: `daysRunning=0`, target = 7)
- Scheduler: running
- Coordinator: 0 pending, 0 collapses
- Database: OK
- Notifications: not configured (expected for this deployment)
- BusinessAI: not configured (expected for this deployment)

### Notes

This snapshot establishes the baseline for the pilot. All measurable correctness
gates are green. The only unmet condition is the required seven-day runtime
window, which is expected at this stage and is not a gate failure.

RSS baseline for trend analysis: 74.5 MB. Compare subsequent daily snapshots
against this value to detect sustained memory growth rather than isolated
fluctuations.

Operator comments should be recorded verbatim after the day's usage and should
focus on observable triggers (for example, where the operator hesitated, asked
for assistance, or misunderstood a workflow) rather than interpretations.

### Assessment

This is a strong Day 0 / Day 1 baseline:

- **P0:** No evidence of a correctness issue.
- **P1:** Not yet assessable until you have operator observations.
- **P2:** No new capability requests should be considered during the freeze.

The next day's comparison is more informative than today's absolute values.
Specifically compare:

- RSS (74.5 MB → trend)
- Daemon uptime (continuous, no unexpected restart)
- Duplicate renders (must remain 0)
- Missed schedules (must remain 0)
- Artifact count (should increase only by expected scheduled reports)
- SQLite recoveries (must remain 0)

If tomorrow's snapshot remains similarly clean, this is the first meaningful
evidence that the scheduler, persistence, and daemon are stable under continuous
operation rather than just a successful startup.

## 2026-06-30 — Day 1 (no entry) — evidence-integrity note

**No Day 1 ledger entry exists. This is a documentation gap only, not a pilot
failure.** No evidence indicates a runtime failure or interruption between the
Day 0 baseline (2026-06-29) and the Day 2 collection (2026-07-01); the daemon's
continuous uptime across that window (15h → 65h) is consistent with an
uninterrupted run. The omission occurred simply because no collection was
recorded on Day 1.

This row is deliberately **not** reconstructed. A pilot ledger is an audit log of
what was actually observed, not what was probably true, so no synthetic
"Day 1 — PASS" row is inserted. Fabricating an unobserved-but-likely row would
weaken the integrity of the entire evidence trail.

Tooling context (both changes are freeze-safe; the runtime artifact under test is
unchanged): from commit `cc07e94`, `scripts/pilot-collect` was made more
deterministic to reduce the chance of a future missed collection; from commit
`a07c43d`, the runtime drift check distinguishes runtime changes from
documentation/tooling changes, so later entries carry a more trustworthy build
signal. These reduce the likelihood of future evidence gaps without altering what
is being measured.

**For the Day 7 review:** treat the missing Day 1 entry as a governance /
documentation limitation, not as evidence of a pilot failure or a correctness
gate breach.
