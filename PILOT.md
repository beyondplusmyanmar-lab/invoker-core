# Invoker v0.2.0-rc1 Pilot

**Status:** Experimental
**Duration:** 7 consecutive days
**Scope:** 1 shop · 1 laptop · 1 operator

This is an experiment, not normal usage. The question is no longer "what
capabilities do we need?" but "which assumptions survive contact with a real
branch manager for seven days?" The most valuable output is a completed ledger,
not another commit.

The single claim under test:

> Even if the server is unavailable, yesterday's report is still on this laptop,
> and the application can prove it.

## Freeze Policy

**Allowed**
- bug fixes (only if a gate fails)
- observability improvements
- pilot documentation

**Forbidden**
- multi-device · placement · leases · epochs · replay · guaranteed notifications
- relay · P3 · Tauri · mobile · plugin system · workflow designer
- rc2 features (Chat page, Settings page)

rc2 stays frozen until the pilot reports. A pass turns rc2 into a *product*
exercise; it is not unfrozen by impatience.

## Success Criteria

| Gate | Target | Instrument | Result |
|------|--------|------------|--------|
| Uptime | >= 7 days | `doctor --pilot` | |
| Duplicate renders | 0 | `doctor --pilot` | |
| Corrupt artifacts | 0 | `doctor --pilot` (verify sweep) | |
| Missed cron reports | 0 | `doctor --pilot` | |
| SQLite recovery failures | 0 | `doctor --pilot` | |
| Disk exhaustion | 0 | `health --json` + retention | |
| Operator confusion incidents | <= 2 | **ledger (human only)** | |
| Memory growth | bounded | **RSS sample (external)** | |

**Instrument honesty.** The first six gates are read from durable state by the
tooling. The last two have **no sensor in the runtime** — operator confusion is
visible only in the ledger's comments, and memory growth only in the daily RSS
sample. An empty ledger is not a green gate; it is a missing measurement.

## Morning Checklist

Run once each morning. The `pilot-collect` script does all of this in one step
(preferred); the manual equivalent is below.

```bash
scripts/pilot-collect          # writes pilot/<timestamp>/ with everything below
```

Manual equivalent:

```bash
invoker doctor --pilot --json  > doctor.json
invoker health --json          > health.json   # carries the running version
invoker support bundle --out support/

# RSS sample — read the daemon's PID from its own lockfile (authoritative),
# not from a process-name grep.
WS="${INVOKER_HOME:-$HOME/.invoker}"
PID=$(grep -o '"pid":[0-9]*' "$WS/daemon.lock" 2>/dev/null | grep -o '[0-9]*' || true)
[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ps -o pid,rss,vsz,etime,command -p "$PID" > rss.txt

# Build identity — version from the health snapshot, exact build from git.
grep -m1 '"version"' health.json            # e.g. "version": "0.2.0-rc1"
git rev-parse HEAD 2>/dev/null || true       # distinguishes rc1 from a hotfix build
```

Then record the headline numbers in the ledger.

## Operator Ledger

One row per day. Keep it in this file or a spreadsheet — it is the primary
artifact of the pilot.

```
Date:
Operator:
Morning snapshot completed: [ ]

Version:                 (from health.json)
Build (git HEAD):        (rc1 = dddfc71's commit, or a hotfix sha)
Doctor:                  PASS / FAIL
Health:                  OK / WARN
RSS (KB):
Duplicate renders:
Missed schedules:
Disk used:

Notes:
```

### Operator Comments (free-form — watch this most closely)

Technically robust systems usually fail at operator confusion first. Capture
verbatim what the manager says and does. Examples worth noticing:

- "I couldn't find yesterday's report" — did they know *where* artifacts land?
- Clicked **Run** twice — repeated manual reruns (the coordinator collapses
  them, but the *expectation* is the signal).
- "Didn't understand the Verify shield" — is `✓ Verified` legible as a promise?
- "Notification wording confusing" — and did they expect notifications to
  **replay**? They don't: the listener re-establishes live, by design.
- Did they know the **support bundle** exists when something looked wrong?

## Incident Procedure

If any gate fails:

1. `invoker support bundle` immediately; archive the bundle.
2. Attach it to an issue with the failing gate named.
3. **Do not add features.** Root-cause, then a minimal fix.
4. Restart the 7-day clock only if the failure invalidates the results so far.

## Exit Outcomes

- **PASS** — all gates green for 7 days → v0.2.x is operationally validated for
  the single-shop / single-device regime; rc2 becomes product work.
- **PARTIAL** — only UI friction, doctor-message tuning, or support-bundle
  additions requested → small v0.2.x improvements, still not systems design.
- **FAIL** — reports disappear, artifacts corrupt, schedules drift, coordinator
  collapse misbehaves, retention removes the wrong artifacts, or SQLite damage
  is observed → the failing gate is the next engineering task, now backed by
  evidence instead of speculation.
