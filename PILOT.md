# Invoker v0.2.0-rc1 Pilot Protocol

**Status:** Experimental

## Purpose

Validate one claim:

> If the server disappears, yesterday's report is still present on the laptop,
> and the application can prove that it is authentic.

## Duration

7 consecutive days.

## Scope

- 1 shop
- 1 laptop
- 1 operator

## Posture

Experiment, not product rollout. Operational evidence outranks feature work.

## Freeze Policy

**Allowed**
- bug fixes
- observability improvements
- pilot documentation
- support tooling
- incident analysis

**Forbidden**
- multi-device · placement · leases · epochs · replay · guaranteed notifications
- relay · P3 · Tauri · mobile · plugin system · workflow designer · marketplace
- rc2 features (Chat page, Settings page)

## Pilot Gates

| Gate | Target | Instrument |
|------|--------|------------|
| Uptime | >= 7 days | `doctor --pilot` |
| Duplicate renders | 0 | `doctor --pilot` |
| Corrupt artifacts | 0 | `artifact verify` + `doctor` |
| Missed cron reports | 0 | `doctor --pilot` |
| SQLite recovery failures | 0 | `doctor --pilot` |
| Disk exhaustion | 0 | `health --json` |
| Operator confusion incidents | 0 | ledger |
| Memory growth | bounded | RSS sample |

## Success Conditions

**PASS** — all gates green.

**PARTIAL** — no data loss; one or more usability issues; no architectural
assumptions invalidated.

**FAIL** — any of: corrupt artifact · duplicate render escaping the coordinator ·
missed report · SQLite unrecoverable · disk exhaustion · unbounded daemon growth ·
operator unable to complete the morning workflow.

## Morning Checklist

Run once every morning:

```bash
scripts/pilot-collect
```

Verify the snapshot was created, then review: `doctor.json`, `health.json`,
`rss.txt`, and the support bundle.

### RSS Sampling

The daemon PID is obtained from the runtime lockfile. The collector records:
PID, RSS, VSZ, elapsed time, and command line.

## Ledger

One row per day.

```
Date:
Operator:
Morning snapshot completed: [ ]

Doctor:               PASS / FAIL
Health:               OK / WARN
Version:
Git head:
RSS (KB):
Duplicate renders:
Corrupt artifacts:
Missed schedules:
SQLite recoveries:
Disk used:
Cleanup usage:

Notes:
```

### Operator Comments

Free-form observations. Examples:

- "I couldn't find yesterday's report"
- "I clicked Run twice"
- "I didn't understand Verify"
- "I expected notifications to stay"
- "I wasn't sure if the schedule was enabled"

## Incident Procedure

If any gate fails:

1. **Do not add features.**
2. Run `scripts/pilot-collect`.
3. Archive the produced snapshot directory.
4. Attach the snapshot to the issue.
5. Root-cause the failure.
6. Apply the smallest fix possible.
7. Decide whether the pilot clock resets.

## Support Bundle

Expected contents of `support-YYYYMMDD.zip`:

```
artifacts/latest.manifest.json
config.redacted.json
doctor.json
health.json
logs/last100.log
notifications.json
runs.json
schedules.json
sqlite.db
```

## Build Identity

Pilot snapshots record `version`, `git_head`, and the collection timestamp.

The collector tolerates doctor failures: a failing gate must never prevent
snapshot collection.

## Exit Criteria

At the end of Day 7, review the ledger, the pilot snapshots, the support
bundles, and the operator comments, then decide:

- unfreeze rc2
- extend the pilot
- fix a failing gate

**No rc2 work begins before this review.**
