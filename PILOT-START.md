# Pilot Start Record — Invoker v0.2.0-rc1

Fill this in on Day 1, on the shop laptop. The fields left as `<…>` /
`YYYY-MM-DD` can only be known there; everything else is pinned to the build.

**Status:** ACTIVE (once started)

| Field | Value |
|-------|-------|
| Started at | `YYYY-MM-DD HH:MM TZ` |
| Shop | `<shop-id>` |
| Laptop | `<hostname>` |
| Operator | `<operator>` |
| Build | v0.2.0-rc1 (tag `9e8972d`) |
| Git head | `<record from pilot/<stamp>/meta.txt — the actual checkout sha>` |
| Protocol | [PILOT.md](PILOT.md) |
| Expected review date | `YYYY-MM-DD` (= start date + 6 days, end of Day 7) |
| Freeze | ENFORCED |
| Day | 1 / 7 |

**Allowed changes:** bug fixes · observability improvements · pilot
documentation · incident analysis

**Forbidden changes:** rc2 · Chat page · Settings page · multi-device ·
placement · replay · leases · epochs · relay · P3

**Morning snapshot directory:** `pilot/`

**Notes:**
- Pilot initiated.
- No known gate failures.
- Awaiting first morning ledger row.

## Start Sequence (Day 1, on the laptop)

```bash
# Start the scheduler. Use `start` (detached) not `run` (foreground): `run`
# dies when its terminal closes, which would silently break the Uptime gate.
# A closed laptop is fine — CatchUp catches missed ticks on wake (cache hit).
invoker daemon start

# Optional: outbound notification listener (env-configured)
invoker notifications listen   # foreground; supervise or run in its own window

# Record the start instant for this file
date

# First morning snapshot — establishes the pilot window (doctor --pilot writes
# pilot_started_at) and the Day-1 baseline.
scripts/pilot-collect
```

After this there is intentionally nothing to engineer. For seven days:

1. Run `scripts/pilot-collect` each morning.
2. Fill in the [PILOT.md](PILOT.md) ledger row.
3. Archive any gate-failing snapshot.
4. Apply the smallest bug fix **only** if a gate fails.

## What the Pilot Measures

The pilot validates the **runtime workspace**, not the repository. The repo
carries only the protocol and tooling; the workspace (default `~/.invoker/`,
or `$INVOKER_HOME`) holds everything under test:

```
~/.invoker/
├── invoker.sqlite          # jobs · runs · artifact index · notifications · heartbeats
│   (+ invoker.sqlite-wal / -shm during active use)
├── daemon.lock             # present only while the daemon is running (RSS sample reads its pid)
├── invoker.log             # lifecycle timeline (rolling, size-capped)
└── artifacts/
    ├── *.xlsx · *.docx      # the reports
    └── *.manifest.json      # tamper-evident sidecars
```

Notifications are **rows in `invoker.sqlite`**, not a `notifications/` folder;
the support bundle surfaces them as `notifications.json`.

Each `scripts/pilot-collect` run produces:

```
pilot/<YYYYMMDD-HHMMSS>/
├── doctor.json · health.json · rss.txt · meta.txt · notes.txt
└── support/
    └── support-<YYYYMMDD>.zip
```

`pilot/` is git-ignored and never committed.

## Day 7 Review

Evidence-driven, from the ledger + snapshots + bundles + operator comments:

| Gate | Result |
|------|--------|
| Uptime ≥ 7d | ? |
| Duplicate renders | ? |
| Corrupt artifacts | ? |
| Missed cron reports | ? |
| SQLite recovery failures | ? |
| Disk exhaustion | ? |
| Operator confusion incidents | ? |
| Memory growth bounded | ? |

Three outcomes:

- **All gates pass** → unfreeze rc2.
- **A gate fails but is understood** → smallest fix, rerun the pilot.
- **Inconclusive** → extend the pilot window.

The pilot itself is the next deliverable — not another branch.
