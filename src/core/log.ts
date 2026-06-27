// A deliberately tiny operational log: timestamped lines appended to <workspace>/invoker.log so the
// support bundle can answer "did the scheduler fire Monday?" without remote access. Not telemetry,
// not structured tracing — just a human-readable timeline of lifecycle events. Size-capped so it
// never grows unbounded on a laptop that runs for months.

import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1_000_000; // ~1 MB; trimmed to the last ~2000 lines when exceeded
const KEEP_LINES = 2000;

function logPath(workspace: string): string {
  return join(workspace, "invoker.log");
}

/** Append one timestamped line. Best-effort: logging must never break the runtime. */
export function appendLog(workspace: string, line: string): void {
  const p = logPath(workspace);
  try {
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
    if (statSync(p).size > MAX_BYTES) {
      const lines = readFileSync(p, "utf8").split("\n");
      writeFileSync(p, lines.slice(-KEEP_LINES).join("\n"));
    }
  } catch {
    /* a full or read-only disk shouldn't crash the caller */
  }
}

/** The last `n` lines of the log (for the support bundle). Empty string if there is no log yet. */
export function tailLog(workspace: string, n: number): string {
  try {
    return readFileSync(logPath(workspace), "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}
