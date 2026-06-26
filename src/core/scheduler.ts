// Missed-run handling for a scheduler that runs on a machine which is often asleep/off.
// The interesting logic is the policy decision; cron parsing is delegated to `croner`.

export enum SchedulePolicy {
  /** Run missed ticks on wake, bounded by maxLag. Recommended for reports. */
  CatchUp = "catchup",
  /** Only fire if the machine is up at the tick. Missed ticks are lost. */
  Skip = "skip",
  /** Run once on next launch, regardless of how many ticks were missed. */
  Resume = "resume",
}

export interface ScheduledJob {
  id: string;
  name: string;
  capability: string;
  contractVersion: number;
  template?: string;
  cron: string;
  policy: SchedulePolicy;
  maxLagMs: number;
  enabled: boolean;
}

export interface SchedulerState {
  lastRunAt?: number;
  lastStatus?: string;
}

/**
 * Decide whether a job is due, given the most recent scheduled tick that should have
 * already fired (`prevTick`, computed by the cron lib) and our last-run record.
 *
 * Pure and deterministic so it is trivially testable.
 */
export function decideRun(
  job: ScheduledJob,
  prevTick: number | null,
  state: SchedulerState,
  now: number,
): { run: boolean; reason: string } {
  if (!job.enabled) return { run: false, reason: "disabled" };
  if (prevTick === null) return { run: false, reason: "no scheduled tick yet" };

  const alreadyRanThisTick = state.lastRunAt !== undefined && state.lastRunAt >= prevTick;
  if (alreadyRanThisTick) return { run: false, reason: "tick already satisfied" };

  switch (job.policy) {
    case SchedulePolicy.Skip:
      // Only run if we're effectively at the tick (woke up basically on time).
      return now - prevTick <= job.maxLagMs
        ? { run: true, reason: "on-time tick" }
        : { run: false, reason: "missed tick (skip policy)" };

    case SchedulePolicy.CatchUp: {
      const lag = now - prevTick;
      return lag <= job.maxLagMs
        ? { run: true, reason: `catch-up within maxLag (${lag}ms)` }
        : { run: false, reason: `missed tick exceeds maxLag (${lag}ms)` };
    }

    case SchedulePolicy.Resume:
      // Run once for the missed tick no matter how stale.
      return { run: true, reason: "resume on next launch" };
  }
}
