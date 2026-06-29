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

## 2026-06-29 — Day 0 (baseline)

### Machine observations

- Snapshot: `pilot/20260629-054333`
- Host: `doeh-frontliner`
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
