#!/usr/bin/env bun
// Transport #1 (ADR-002/003). Translates CLI args into an InvokeRequest and back.
// Holds NO render or business logic — it only drives invoke().

import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { registry } from "../../core/registry.ts";
import { invoke } from "../../core/invoke.ts";
import { Store } from "../../storage/db.ts";
import { excelRender } from "../../engines/excel/index.ts";
import { docxRender } from "../../engines/docx/index.ts";
import { tabularMap } from "../../engines/tabular/index.ts";
import { HttpFetchProvider, RoutingFetchProvider } from "../../core/fetch.ts";
import { runJob, dueJobs, nextTick } from "../../core/runner.ts";
import { ExecutionCoordinator, DEFAULT_MAX_PENDING } from "../../core/execution.ts";
import { DEFAULT_LIMITS, type Limits } from "../../core/limits.ts";
import { runCleanup, DEFAULT_RETENTION, type RetentionPolicy } from "../../core/retention.ts";
import { SchedulePolicy, type ScheduledJob } from "../../core/scheduler.ts";
import { importJobSpec } from "../../core/jobspec.ts";
import { runListener } from "../../core/notification-listener.ts";
import type { ListenerConfig } from "../../core/notifications.ts";
import { BusinessAIClient, FetchChatTransport } from "../../core/businessai.ts";
import { verifyArtifact } from "../../core/verify.ts";
import { gatherHealth, type HealthReport } from "../../core/health.ts";
import { VERSION } from "../../version.ts";
import { resolveSecret } from "../../core/secrets.ts";
import { assertDeterministic } from "../../engines/conformance.ts";
import {
  acquireLock,
  releaseLock,
  readLock,
  isAlive,
  runDaemonLoop,
  abortableSleep,
  DEFAULT_INTERVAL_MS,
} from "../../core/daemon.ts";
import { runDoctor } from "../../core/doctor.ts";

const SELF = fileURLToPath(import.meta.url);

const WORKSPACE = process.env.INVOKER_HOME ?? join(homedir(), ".invoker");

// Built-in engines register here. Domain capabilities arrive via plugins (ADR-001/008).
function bootstrap(): void {
  for (const cap of [tabularMap, excelRender, docxRender]) {
    if (!registry.has(cap.id, cap.contractVersion)) registry.register(cap);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  bootstrap();

  switch (cmd) {
    case "init":
      return cmdInit();
    case "invoke":
      return cmdInvoke(rest);
    case "capabilities":
      return cmdCapabilities();
    case "capability":
      return cmdCapability(rest);
    case "jobs":
      return cmdJobs(rest);
    case "schedule":
      return cmdSchedule(rest);
    case "run":
      return cmdRun(rest);
    case "runs":
      return cmdRuns(rest);
    case "artifact":
      return cmdArtifact(rest);
    case "notifications":
      return cmdNotifications(rest);
    case "chat":
      return cmdChat(rest);
    case "tick":
      return cmdTick(rest);
    case "daemon":
      return cmdDaemon(rest);
    case "health":
      return cmdHealth(rest);
    case "cleanup":
      return cmdCleanup(rest);
    case "doctor":
      return cmdDoctor(rest);
    case undefined:
    case "help":
    case "--help":
      return usage();
    default:
      console.error(`unknown command: ${cmd}`);
      return usage(1);
  }
}

function cmdInit(): number {
  new Store(WORKSPACE).close();
  console.log(`workspace ready at ${WORKSPACE}`);
  return 0;
}

function cmdCapabilities(): number {
  for (const c of registry.list()) {
    console.log(
      `${c.id}@v${c.contractVersion}  engine=${c.engineVersion}  ` +
        `deterministic=${c.deterministic}  cacheable=${c.cacheable}`,
    );
  }
  return 0;
}

/** invoker invoke <capability> --data <file.json> [--dry-run] [--contract N] */
async function cmdInvoke(args: string[]): Promise<number> {
  const capability = args[0];
  if (!capability) {
    console.error("usage: invoker invoke <capability> --data <file.json> [--dry-run]");
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const dataPath = optValue(args, "--data");
  const contractVersion = Number(optValue(args, "--contract") ?? "1");

  const data = dataPath
    ? ((await Bun.file(dataPath).json()) as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  const store = new Store(WORKSPACE);
  try {
    const result = await invoke(
      { id: randomUUID(), capability, contractVersion, params: {}, data, dryRun },
      store,
    );
    if (result.dryRun) {
      console.log(`cacheKey  ${result.cacheKey}`);
      console.log(`status    ${result.cacheHit ? "HIT" : "MISS"}`);
      console.log(`artifact  unknown (skipped)`);
    } else {
      reportResult(result);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** invoker capability <list | verify <id[@vN]>> — descriptor checklist + live determinism self-test. */
async function cmdCapability(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list" || sub === undefined) return cmdCapabilities();
  if (sub !== "verify") {
    console.error("usage: invoker capability <list|verify <id[@vN]>>");
    return 1;
  }

  const idArg = args[1];
  if (!idArg) {
    console.error("usage: invoker capability verify <id[@vN]>");
    return 1;
  }
  const [id, vtag] = idArg.split("@v");
  const cap = registry.resolve(id!, vtag ? Number(vtag) : 1);

  const mark = (b: boolean) => (b ? "✓" : "✗");
  console.log(`capability   ${cap.id}@v${cap.contractVersion}`);
  console.log(`engine       ${cap.engineVersion}`);
  console.log(`dry-run      ${mark(cap.supportsDryRun)}`);
  console.log(`cacheable    ${mark(cap.cacheable)}`);

  let ok = true;
  if (!cap.deterministic) {
    console.log(`determinism  n/a (not claimed)`);
  } else if (!cap.sample) {
    console.log(`determinism  ⚠ claimed but no sample() to verify`);
  } else {
    const data = cap.sample();
    const r = await assertDeterministic(async () => {
      const out = await cap.execute({
        request: { id: "verify", capability: cap.id, contractVersion: cap.contractVersion, params: {}, data },
        data,
      });
      if (out.kind !== "artifact") {
        throw new Error("determinism self-test requires an artifact-producing capability");
      }
      return out.bytes;
    }, 10);
    ok = r.ok;
    console.log(
      r.ok
        ? `determinism  ✓ verified ×10 (${r.hash!.slice(0, 12)}…)`
        : `determinism  ✗ FAILED — ${new Set(r.hashes).size} distinct hashes across 10 renders`,
    );
  }
  return ok ? 0 : 1;
}

/**
 * invoker jobs <list | add ... | import <file.toml>>
 *   add    --id <id> --cap <c> --cron "<expr>" [--source ref] [--template t] [--policy ...] [--max-lag ms]
 *   import <file.toml>  — ingest a (possibly pipeline) job; relative file: paths resolve to absolute
 */
async function cmdJobs(args: string[]): Promise<number> {
  const sub = args[0];
  const store = new Store(WORKSPACE);
  try {
    if (sub === "list") {
      for (const j of store.listJobs()) {
        const what = j.steps?.length
          ? `pipeline[${j.steps.map((s) => s.capability).join("→")}]`
          : `${j.capability}@v${j.contractVersion}`;
        console.log(
          `${j.id}  ${j.name}  ${what}  cron="${j.cron}"  ` +
            `policy=${j.policy}  ${j.enabled ? "enabled" : "disabled"}`,
        );
      }
      return 0;
    }
    if (sub === "add") {
      const rest = args.slice(1);
      const job: ScheduledJob = {
        id: required(rest, "--id"),
        name: optValue(rest, "--name") ?? required(rest, "--id"),
        capability: required(rest, "--cap"),
        contractVersion: Number(optValue(rest, "--contract") ?? "1"),
        source: optValue(rest, "--source"),
        template: optValue(rest, "--template"),
        cron: required(rest, "--cron"),
        policy: (optValue(rest, "--policy") as SchedulePolicy) ?? SchedulePolicy.CatchUp,
        maxLagMs: Number(optValue(rest, "--max-lag") ?? String(24 * 60 * 60 * 1000)),
        enabled: true,
      };
      store.upsertJob(job);
      console.log(`job '${job.id}' saved (${job.capability}, cron="${job.cron}", policy=${job.policy})`);
      return 0;
    }
    if (sub === "import") {
      const file = args[1];
      if (!file) {
        console.error("usage: invoker jobs import <file.toml>");
        return 1;
      }
      const job = await importJobSpec(file);
      store.upsertJob(job);
      const shape = job.steps?.length
        ? `pipeline ${job.steps.map((s) => s.capability).join("→")}`
        : job.capability;
      console.log(
        `imported job '${job.id}' (${shape}, source=${job.source ?? "none"}, ` +
          `cron=${job.cron || "manual"})`,
      );
      return 0;
    }
    console.error("usage: invoker jobs <list|add ...|import <file.toml>>");
    return 1;
  } finally {
    store.close();
  }
}

/**
 * invoker schedule <list | enable <id> | disable <id> | run <id> | edit <id> ...>
 *
 * Manager-facing verbs over the same alpha jobs: a "schedule" is just a job with a cron and a
 * current status (last run/result/duration), framed the way a branch manager reaches for it —
 * "enable the daily sales report", not "upsert a job". Holds no new state of its own.
 *   edit <id> [--cron "<expr>"] [--policy catchup|skip|resume] [--max-lag ms] [--name <name>]
 */
async function cmdSchedule(args: string[]): Promise<number> {
  const sub = args[0];
  const store = new Store(WORKSPACE);
  try {
    switch (sub) {
      case "list":
      case undefined:
        return scheduleList(store, args.includes("--json"));
      case "enable":
      case "disable": {
        const id = args[1];
        if (!id) {
          console.error(`usage: invoker schedule ${sub} <id>`);
          return 1;
        }
        if (!store.setJobEnabled(id, sub === "enable")) {
          console.error(`no such schedule: ${id}`);
          return 1;
        }
        console.log(`schedule '${id}' ${sub}d`);
        return 0;
      }
      case "run": {
        const id = args[1];
        if (!id) {
          console.error("usage: invoker schedule run <id>");
          return 1;
        }
        const job = store.getJob(id);
        if (!job) {
          console.error(`no such schedule: ${id}`);
          return 1;
        }
        const limits = makeLimits();
        reportResult(await runJob(job, store, makeFetcher(), { coordinator: makeCoordinator(limits), limits }));
        return 0;
      }
      case "edit":
        return scheduleEdit(store, args.slice(1));
      default:
        console.error("usage: invoker schedule <list|enable <id>|disable <id>|run <id>|edit <id> ...>");
        return 1;
    }
  } finally {
    store.close();
  }
}

/** Render the schedule status table (or JSON): each job + its latest run, with the next tick. */
function scheduleList(store: Store, asJson: boolean): number {
  const now = Date.now();
  const rows = store.listSchedules();
  if (asJson) {
    // A disabled schedule won't fire, so it has no next run — keep JSON and table agreed.
    const enriched = rows.map((r) => ({ ...r, nextRunAt: r.enabled ? nextTick(r.cron, now) : null }));
    console.log(JSON.stringify(enriched, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no schedules yet — add one with `invoker jobs add` or `invoker jobs import`");
    return 0;
  }
  const fmt = (t?: number | null) =>
    t == null ? "—" : new Date(t).toISOString().replace("T", " ").slice(0, 16);
  for (const r of rows) {
    const state = !r.enabled ? "disabled" : r.cron ? "enabled " : "manual  ";
    const cron = r.cron || "(manual)";
    const status = r.lastStatus
      ? r.lastStatus === "completed"
        ? `✓${r.lastCacheHit ? " cache" : ""}`
        : r.lastStatus === "failed"
          ? "✗ failed"
          : `· ${r.lastStatus}`
      : "never run";
    const dur = r.lastDurationMs != null ? `${r.lastDurationMs}ms` : "—";
    const next = r.enabled && r.cron ? fmt(nextTick(r.cron, now)) : "—";
    console.log(
      `${r.id.padEnd(16)} ${state}  ${cron.padEnd(14)} ` +
        `last ${fmt(r.lastRunAt)}  ${status.padEnd(8)} ${dur.padStart(7)}  ` +
        `${(r.renderer ?? "—").padEnd(4)}  next ${next}`,
    );
  }
  return 0;
}

/** Mutate a schedule's cron/policy/max-lag/name in place (read-modify-write via upsertJob). */
function scheduleEdit(store: Store, args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error("usage: invoker schedule edit <id> [--cron \"<expr>\"] [--policy ...] [--max-lag ms] [--name <name>]");
    return 1;
  }
  const job = store.getJob(id);
  if (!job) {
    console.error(`no such schedule: ${id}`);
    return 1;
  }
  const cron = optValue(args, "--cron");
  const policy = optValue(args, "--policy");
  const maxLag = optValue(args, "--max-lag");
  const name = optValue(args, "--name");
  if (cron === undefined && policy === undefined && maxLag === undefined && name === undefined) {
    console.error("nothing to change: pass at least one of --cron --policy --max-lag --name");
    return 1;
  }
  if (cron !== undefined) job.cron = cron; // "" clears it back to manual
  if (policy !== undefined) job.policy = policy as SchedulePolicy;
  if (maxLag !== undefined) job.maxLagMs = Number(maxLag);
  if (name !== undefined) job.name = name;
  store.upsertJob(job);
  console.log(
    `schedule '${id}' updated (cron="${job.cron}", policy=${job.policy}, ` +
      `max-lag=${job.maxLagMs}ms)`,
  );
  return 0;
}

/** invoker run <jobId> — force-run a job now, regardless of schedule. */
async function cmdRun(args: string[]): Promise<number> {
  const jobId = args[0];
  if (!jobId) {
    console.error("usage: invoker run <jobId>");
    return 1;
  }
  const store = new Store(WORKSPACE);
  try {
    const job = store.getJob(jobId);
    if (!job) {
      console.error(`no such job: ${jobId}`);
      return 1;
    }
    const limits = makeLimits();
    const result = await runJob(job, store, makeFetcher(), { coordinator: makeCoordinator(limits), limits });
    reportResult(result);
    return 0;
  } finally {
    store.close();
  }
}

/** invoker runs [--limit N] [--json] — report history: recent runs and the artifacts they produced. */
function cmdRuns(args: string[]): number {
  const limit = Number(optValue(args, "--limit") ?? "20");
  const store = new Store(WORKSPACE);
  try {
    const runs = store.listRuns(limit);
    if (args.includes("--json")) {
      console.log(JSON.stringify(runs, null, 2));
      return 0;
    }
    if (runs.length === 0) {
      console.log("no runs yet");
      return 0;
    }
    for (const r of runs) {
      const when = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 19);
      const mark = r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "·";
      const dur = r.durationMs != null ? `${r.durationMs}ms` : "—";
      const what = r.jobName ?? r.capability;
      const file = r.artifact ? `${r.artifact.type} ${r.artifact.sha256.slice(0, 12)}…` : "—";
      const hit = r.cacheHit ? " (cache)" : "";
      console.log(`${mark} ${when}  ${what.padEnd(20)} ${dur.padStart(7)}  ${file}${hit}`);
      if (r.status === "failed" && r.error) console.log(`    ${r.error}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/**
 * invoker notifications <list | read <id|--all> | listen [--channel <c> ...]>
 *
 * A pure listener over an outbound Reverb/Pusher WebSocket (ADR-004): connected / disconnected /
 * message, dedup on event_id, mark-read. No queue, no replay, no delivery guarantee. Connection
 * config comes from the environment so core stays DOEH-agnostic:
 *   INVOKER_NOTIFY_HOST  INVOKER_NOTIFY_KEY  [INVOKER_NOTIFY_PORT] [INVOKER_NOTIFY_SCHEME=wss]
 *   INVOKER_NOTIFY_CHANNELS=a,b   (or --channel a --channel b)   [INVOKER_NOTIFY_URL overrides host/port]
 *   [INVOKER_NOTIFY_TOKEN_REF=env:…|file:…]  resolved as a bearer; never inline (ADR-005)
 */
async function cmdNotifications(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list":
    case undefined:
      return notifyList(args);
    case "read":
      return notifyRead(args);
    case "listen":
      return notifyListen(args);
    default:
      console.error("usage: invoker notifications <list|read <id|--all>|listen [--channel <c> ...]>");
      return 1;
  }
}

/** notifications list [--unread] [--json] — the NotificationCenter view: unread count + items. */
function notifyList(args: string[]): number {
  const store = new Store(WORKSPACE);
  try {
    const unreadOnly = args.includes("--unread");
    const items = store.listNotifications({ unreadOnly });
    const unread = store.unreadNotificationCount();
    if (args.includes("--json")) {
      console.log(JSON.stringify({ unread, items }, null, 2));
      return 0;
    }
    console.log(`unread ${unread}`);
    if (items.length === 0) {
      console.log(unreadOnly ? "no unread notifications" : "no notifications yet");
      return 0;
    }
    for (const n of items) {
      const when = new Date(n.receivedAt).toISOString().replace("T", " ").slice(0, 16);
      const mark = n.readAt ? " " : "●";
      const body = n.body ? ` — ${n.body}` : "";
      console.log(`${mark} ${when}  ${n.type.padEnd(8)} ${n.title}${body}`);
      console.log(`    id ${n.id}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** notifications read <id> | --all — mark one or every unread notification read. */
function notifyRead(args: string[]): number {
  const store = new Store(WORKSPACE);
  try {
    if (args.includes("--all")) {
      const n = store.markAllNotificationsRead();
      console.log(`marked ${n} notification${n === 1 ? "" : "s"} read`);
      return 0;
    }
    const id = args[1];
    if (!id) {
      console.error("usage: invoker notifications read <id|--all>");
      return 1;
    }
    if (!store.markNotificationRead(id)) {
      console.error(`no such unread notification: ${id}`);
      return 1;
    }
    console.log(`marked '${id}' read`);
    return 0;
  } finally {
    store.close();
  }
}

/** notifications listen — foreground listener (what launchd/systemd supervises). Ctrl-C to stop. */
async function notifyListen(args: string[]): Promise<number> {
  const cfg = notifyConfigFromEnv(collectAll(args, "--channel"));
  if (typeof cfg === "string") {
    console.error(`cannot listen: ${cfg}`);
    return 1;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const store = new Store(WORKSPACE);
  console.log(`listening on ${cfg.channels.join(", ")} — Ctrl-C to stop`);
  try {
    await runListener(cfg, store, {
      signal: controller.signal,
      onConnected: (sid) => console.log(`[notify] connected${sid ? ` (${sid})` : ""}`),
      onDisconnected: (why) => console.log(`[notify] disconnected: ${why}`),
      onMessage: (e, stored) =>
        console.log(`[notify] ${stored ? "•" : "dup"} ${e.type}: ${e.title}`),
      onError: (msg) => console.error(`[notify] error: ${msg}`),
    });
    console.log("listener stopped");
    return 0;
  } finally {
    store.close();
  }
}

/** Assemble a ListenerConfig from env (+ --channel overrides), or return a guidance string. */
function notifyConfigFromEnv(channelOverride: string[]): ListenerConfig | string {
  const url = process.env.INVOKER_NOTIFY_URL;
  const host = process.env.INVOKER_NOTIFY_HOST;
  const appKey = process.env.INVOKER_NOTIFY_KEY;
  if (!url && (!host || !appKey)) {
    return "set INVOKER_NOTIFY_HOST + INVOKER_NOTIFY_KEY (or INVOKER_NOTIFY_URL)";
  }
  const channels = channelOverride.length
    ? channelOverride
    : (process.env.INVOKER_NOTIFY_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (channels.length === 0) return "no channels: set INVOKER_NOTIFY_CHANNELS or pass --channel";

  const tokenRef = process.env.INVOKER_NOTIFY_TOKEN_REF;
  const portStr = process.env.INVOKER_NOTIFY_PORT;
  return {
    url,
    host: host ?? "",
    port: portStr ? Number(portStr) : undefined,
    scheme: (process.env.INVOKER_NOTIFY_SCHEME as "ws" | "wss") ?? "wss",
    appKey: appKey ?? "",
    channels,
    authToken: tokenRef ? resolveSecret(tokenRef) : undefined,
  };
}

/**
 * invoker chat <message> [--meta] — one BusinessAI turn, streamed to stdout. A pure consumer:
 * tokens print as they arrive, done ends the turn. `--meta` surfaces opaque backend control events
 * (delegate/route/handoff/…) for inspection only — the runtime never acts on them.
 *   INVOKER_AI_URL = chat endpoint (text/event-stream)   [INVOKER_AI_TOKEN_REF = secret ref]
 */
async function cmdChat(args: string[]): Promise<number> {
  const showMeta = args.includes("--meta");
  const message = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!message) {
    console.error("usage: invoker chat <message> [--meta]");
    return 1;
  }
  const url = process.env.INVOKER_AI_URL;
  if (!url) {
    console.error("cannot chat: set INVOKER_AI_URL (BusinessAI chat endpoint)");
    return 1;
  }
  const tokenRef = process.env.INVOKER_AI_TOKEN_REF;
  const transport = new FetchChatTransport({
    url,
    authToken: tokenRef ? resolveSecret(tokenRef) : undefined,
  });

  let failed = false;
  const client = new BusinessAIClient(transport, {
    onConnected: () => process.stderr.write("[ai] connected\n"),
    onToken: (t) => process.stdout.write(t),
    onDone: () => process.stdout.write("\n"),
    onError: (m) => {
      failed = true;
      process.stderr.write(`\n[ai] error: ${m}\n`);
    },
    onMeta: (ev, data) => {
      if (showMeta) process.stderr.write(`[ai:meta] ${ev} ${data}\n`);
    },
  });

  const stop = () => client.disconnect();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  client.connect();
  await client.send(message);
  return failed ? 1 : 0;
}

/**
 * invoker artifact verify <sha> [--json] — prove a report is intact from the filesystem alone.
 * The integrity chain (bytes → DB row → manifest sidecar) must agree end to end; exit 1 on any fail.
 */
function cmdArtifact(args: string[]): number {
  if (args[0] !== "verify" || !args[1]) {
    console.error("usage: invoker artifact verify <sha> [--json]");
    return 1;
  }
  const sha = args[1];
  const store = new Store(WORKSPACE);
  try {
    const report = verifyArtifact(store, sha);
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    if (!report.found) {
      console.error(`no artifact matching sha ${sha}`);
      return 1;
    }
    console.log(`artifact   ${report.artifact}`);
    console.log(`sha256     ${report.meta.sha256}`);
    console.log("");
    for (const c of report.checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(14)} ${c.detail}`);
    }
    console.log("");
    for (const [k, v] of Object.entries(report.meta)) {
      if (k !== "sha256") console.log(`${k.padEnd(10)} ${v}`);
    }
    if (!report.ok) console.log(`\nverification FAILED: ${report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

/** invoker tick — run every job that is due now under its missed-run policy. */
async function cmdTick(_args: string[]): Promise<number> {
  const store = new Store(WORKSPACE);
  try {
    const due = dueJobs(store.listJobs(), store);
    if (due.length === 0) {
      console.log("no jobs due");
      return 0;
    }
    const limits = makeLimits();
    const coordinator = makeCoordinator(limits);
    for (const job of due) {
      console.log(`running due job '${job.id}'…`);
      const result = await runJob(job, store, makeFetcher(), { coordinator, limits });
      reportResult(result);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** invoker daemon <run|start|stop|status> — the persistent scheduler (P2). */
async function cmdDaemon(args: string[]): Promise<number> {
  switch (args[0]) {
    case "run":
      return daemonRun();
    case "start":
      return daemonStart();
    case "stop":
      return daemonStop();
    case "status":
      return daemonStatus();
    default:
      console.error("usage: invoker daemon <run|start|stop|status>");
      return 1;
  }
}

/** Foreground worker (what launchd/systemd should supervise). Holds the lock, loops until signalled. */
async function daemonRun(): Promise<number> {
  const lock = acquireLock(WORKSPACE);
  if (!lock.ok) {
    console.error(`daemon already running (pid ${lock.holder.pid})`);
    return 1;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const store = new Store(WORKSPACE);
  const limits = makeLimits();
  console.log(
    `daemon running (pid ${process.pid}), interval ${DEFAULT_INTERVAL_MS}ms — Ctrl-C to stop`,
  );
  try {
    await runDaemonLoop(store, {
      signal: controller.signal,
      fetcher: makeFetcher(),
      coordinator: makeCoordinator(limits),
      limits,
      retention: makeRetention(),
      onTick: (r) => {
        if (r.ran || r.failed) {
          console.log(`[${new Date(r.at).toISOString()}] tick: ran ${r.ran}, failed ${r.failed}`);
        }
      },
    });
    console.log("daemon stopped");
    return 0;
  } finally {
    store.close();
    releaseLock(WORKSPACE);
  }
}

/** Spawn `daemon run` detached so the shell returns. Production deploys supervise `run` directly. */
async function daemonStart(): Promise<number> {
  const held = readLock(WORKSPACE);
  if (held && isAlive(held.pid)) {
    console.error(`daemon already running (pid ${held.pid})`);
    return 1;
  }
  const proc = Bun.spawn([process.execPath, SELF, "daemon", "run"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  proc.unref();
  for (let i = 0; i < 20; i++) {
    const l = readLock(WORKSPACE);
    if (l && isAlive(l.pid)) {
      console.log(`daemon started (pid ${l.pid})`);
      return 0;
    }
    await abortableSleep(100);
  }
  console.error("daemon did not confirm within 2s; run `invoker daemon status`");
  return 1;
}

/** SIGTERM the lock holder and wait for it to exit. */
async function daemonStop(): Promise<number> {
  const held = readLock(WORKSPACE);
  if (!held || !isAlive(held.pid)) {
    if (held) releaseLock(WORKSPACE, held.pid); // clear a stale lock
    console.log("daemon not running");
    return 0;
  }
  try {
    process.kill(held.pid, "SIGTERM");
  } catch {
    /* raced to exit */
  }
  for (let i = 0; i < 50; i++) {
    if (!isAlive(held.pid)) {
      console.log(`daemon stopped (pid ${held.pid})`);
      return 0;
    }
    await abortableSleep(100);
  }
  console.error(`daemon (pid ${held.pid}) did not exit within 5s`);
  return 1;
}

function daemonStatus(): number {
  const held = readLock(WORKSPACE);
  const store = new Store(WORKSPACE);
  try {
    const hb = store.getDaemonHeartbeat();
    const alive = held ? isAlive(held.pid) : false;
    if (!held) {
      console.log("daemon      not running (no lock)");
    } else {
      console.log(`daemon      ${alive ? "running" : "stale lock (process gone)"}`);
      console.log(`pid         ${held.pid}`);
      console.log(`started     ${new Date(held.startedAt).toISOString()}`);
    }
    if (hb) {
      console.log(`ticks       ${hb.ticks}`);
      console.log(`last tick   ${hb.lastTickAt ? new Date(hb.lastTickAt).toISOString() : "—"}`);
      // `hb.status` is the last value persisted to disk. When the lock is held
      // but the process is gone, that value is stale — reconcile against the
      // live probe so a dead daemon never reports a live heartbeat.
      console.log(`heartbeat   ${held && !alive ? "stale (process gone)" : hb.status}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/** invoker health [--json] — one read-only operability snapshot from durable state. Exit 1 if DB unhealthy. */
function cmdHealth(args: string[]): number {
  const store = new Store(WORKSPACE);
  try {
    const held = readLock(WORKSPACE);
    const report = gatherHealth(store, {
      version: VERSION,
      limits: makeLimits(),
      queueLimit: Number(process.env.INVOKER_MAX_PENDING ?? DEFAULT_MAX_PENDING),
      retention: makeRetention(),
      workspaceDir: WORKSPACE,
      daemonAlive: held ? isAlive(held.pid) : undefined,
    });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    printHealth(report);
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

function printHealth(r: HealthReport): void {
  const at = (t?: number) => (t == null ? "—" : new Date(t).toISOString().replace("T", " ").slice(0, 16));
  const gb = (b?: number) =>
    b == null
      ? "—"
      : b >= 1 << 30
        ? `${(b / (1 << 30)).toFixed(1)} GB`
        : b >= 1 << 20
          ? `${(b / (1 << 20)).toFixed(1)} MB`
          : `${(b / (1 << 10)).toFixed(1)} KB`;
  const mins = (ms: number) => (ms % 60000 === 0 ? `${ms / 60000}m` : `${Math.round(ms / 1000)}s`);
  const glyph = (s: string) => (s === "connected" || s === "running" || s === "ok" ? "✓" : s === "absent" ? "·" : "⚠");

  console.log(`invoker ${r.version}\n`);
  const sched =
    r.scheduler.status === "absent"
      ? "absent (no daemon)"
      : `${r.scheduler.status} (last tick ${at(r.scheduler.lastTickAt)}, ${r.scheduler.ticks ?? 0} ticks)`;
  console.log(`${glyph(r.scheduler.status)} Scheduler      ${sched}`);
  console.log(
    `${glyph(r.notifications.status)} Notifications  ${r.notifications.status}` +
      (r.notifications.detail ? ` (${r.notifications.detail})` : ""),
  );
  console.log(`${glyph(r.businessai.status)} BusinessAI     ${r.businessai.status}`);
  const c = r.coordinator;
  console.log(
    `  Coordinator    ${c.pending}/${c.queueLimit} pending · timeout ${mins(c.timeoutMs)} · ` +
      `ceiling ${c.maxRows.toLocaleString()} rows / ${gb(c.maxBytes)} · ${c.collapses24h} collapses/24h`,
  );
  console.log(`  Artifacts      ${r.artifacts.count} (${gb(r.artifacts.diskBytes)})`);
  const rt = r.retention;
  const ago = (t?: number) => (t == null ? "never" : `${Math.round((Date.now() - t) / 86_400_000)}d ago`);
  console.log(
    `  Cleanup        ${gb(r.artifacts.diskBytes)} / ${gb(rt.maxDiskBytes)} · ${r.artifacts.count}/${rt.maxArtifacts} artifacts · ` +
      `${rt.notifications}/${rt.maxNotifications} notif · vacuum ${ago(rt.lastVacuumAt)}`,
  );
  console.log(
    `  Last report    ${r.lastReport ? `${r.lastReport.job} · ${at(r.lastReport.at)} · ${r.lastReport.renderer ?? "—"} · ${r.lastReport.sha?.slice(0, 12) ?? "—"}…` : "none yet"}`,
  );
  console.log(`  Cache hit      ${Math.round(r.cacheHitRatio * 100)}%`);
  console.log(`${glyph(r.db)} DB             ${r.db}`);
  console.log(`  Disk free      ${gb(r.diskFreeBytes)}`);
}

/** invoker cleanup [--dry-run] [--json] — enforce retention budgets now (oldest artifacts first). */
function cmdCleanup(args: string[]): number {
  const store = new Store(WORKSPACE);
  try {
    const report = runCleanup(store, makeRetention(), { dryRun: args.includes("--dry-run") });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    const verb = report.dryRun ? "would remove" : "removed";
    const b = report.bytesFreed;
    const freed = b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / (1 << 10)).toFixed(1)} KB`;
    console.log(`${verb} ${report.artifactsDeleted} artifacts (${freed}), ${report.notificationsDeleted} notifications`);
    return 0;
  } finally {
    store.close();
  }
}

/** invoker doctor [--strict] — read-only health sweep (P4). Exit 1 on FAIL; --strict also fails warnings. */
async function cmdDoctor(args: string[]): Promise<number> {
  const strict = args.includes("--strict");
  const store = new Store(WORKSPACE);
  try {
    const report = await runDoctor({
      workspace: WORKSPACE,
      store,
      registry,
      tokenRef: process.env.INVOKER_TOKEN_REF,
      bunVersion: typeof Bun !== "undefined" ? Bun.version : undefined,
      strict,
    });
    const mark = (s: string) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗");
    for (const c of report.checks) {
      console.log(`${mark(c.status)} ${c.name.padEnd(13)} ${c.detail}`);
    }
    if (!report.ok) {
      const bad = report.checks.filter((c) =>
        strict ? c.status !== "ok" : c.status === "fail",
      );
      console.log(`\n${strict ? "strict " : ""}check failed: ${bad.map((c) => c.name).join(", ")}`);
    }
    return report.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

/** Input ceilings from env, falling back to the v0.2 defaults (50k rows / 100MB / 5min). */
function makeLimits(): Limits {
  return {
    maxRows: Number(process.env.INVOKER_MAX_ROWS ?? DEFAULT_LIMITS.maxRows),
    maxBytes: Number(process.env.INVOKER_MAX_BYTES ?? DEFAULT_LIMITS.maxBytes),
    maxDurationMs: Number(process.env.INVOKER_MAX_DURATION_MS ?? DEFAULT_LIMITS.maxDurationMs),
  };
}

/** Retention budgets from env, falling back to defaults (5000 artifacts / 20GB / 10k notifications). */
function makeRetention(): RetentionPolicy {
  return {
    maxArtifacts: Number(process.env.INVOKER_MAX_ARTIFACTS ?? DEFAULT_RETENTION.maxArtifacts),
    maxDiskBytes: Number(process.env.INVOKER_MAX_DISK_BYTES ?? DEFAULT_RETENTION.maxDiskBytes),
    maxNotifications: Number(process.env.INVOKER_MAX_NOTIFICATIONS ?? DEFAULT_RETENTION.maxNotifications),
  };
}

/** A coordinator wired to the configured concurrency cap + per-execution timeout. */
function makeCoordinator(limits: Limits): ExecutionCoordinator {
  return new ExecutionCoordinator({
    maxPending: Number(process.env.INVOKER_MAX_PENDING ?? DEFAULT_MAX_PENDING),
    maxDurationMs: limits.maxDurationMs,
  });
}

function makeFetcher(): RoutingFetchProvider {
  // Token reference (env:/file:/keychain:/exec:) supplied out-of-band; never inline (ADR-005).
  // Routing handles file: sources locally (offline) and everything else over HTTP.
  return new RoutingFetchProvider(new HttpFetchProvider({ tokenRef: process.env.INVOKER_TOKEN_REF }));
}

function reportResult(result: {
  cacheHit: boolean;
  durationMs: number;
  artifact?: { path: string; artifactSha256: string };
  data?: Record<string, unknown>;
}): void {
  if (result.artifact) {
    console.log(`${result.cacheHit ? "cache hit" : "rendered"} in ${result.durationMs}ms`);
    console.log(`path      ${result.artifact.path}`);
    console.log(`sha256    ${result.artifact.artifactSha256}`);
  } else {
    console.log(`transformed in ${result.durationMs}ms (data output, no artifact)`);
  }
}

function required(args: string[], flag: string): string {
  const v = optValue(args, flag);
  if (v === undefined) throw new Error(`missing required flag: ${flag}`);
  return v;
}

function optValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every value of a repeatable flag, e.g. `--channel a --channel b` → ["a", "b"]. */
function collectAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  }
  return out;
}

function usage(code = 0): number {
  console.log(
    [
      "invoker — a deterministic capability runtime for artifact-producing workloads",
      "",
      "  invoker init                                  create the local workspace",
      "  invoker capability list                       list registered capabilities",
      "  invoker capability verify <id[@vN]>           descriptor checklist + ×10 determinism self-test",
      "  invoker invoke <cap> --data f.json [--dry-run]  run one capability",
      "",
      "  invoker jobs add --id <id> --cap <c> --cron \"<expr>\" [--source url] [--template t] [--policy catchup|skip|resume]",
      "  invoker jobs import <file.toml>               import a (pipeline) job; file: sources resolve to absolute",
      "  invoker jobs list                             list scheduled jobs",
      "  invoker run <jobId>                           force-run a job now",
      "  invoker tick                                  run every job due under its policy (one-shot)",
      "",
      "  invoker schedule list                         schedules + current status (last run / next run)",
      "  invoker schedule enable|disable <id>          turn a schedule on/off",
      "  invoker schedule run <id>                     run a schedule now",
      "  invoker schedule edit <id> --cron \"<expr>\" [--policy ...] [--max-lag ms] [--name <n>]",
      "",
      "  invoker daemon <run|start|stop|status>        persistent scheduler (tick loop)",
      "",
      "  invoker notifications list [--unread] [--json]  NotificationCenter: unread count + items",
      "  invoker notifications read <id|--all>          mark read",
      "  invoker notifications listen [--channel <c>]   outbound Reverb/Pusher listener (env-configured)",
      "",
      "  invoker chat <message> [--meta]               one BusinessAI turn, streamed (env-configured)",
      "",
      "  invoker artifact verify <sha> [--json]        prove an artifact is intact (bytes↔db↔manifest)",
      "",
      "  invoker health [--json]                       operability snapshot (scheduler/coordinator/cache/disk)",
      "  invoker cleanup [--dry-run] [--json]          enforce retention budgets (oldest artifacts first)",
      "  invoker doctor [--strict]                     read-only health sweep (--strict: warnings fail)",
      "",
      "  (mcp, ws, tauri transports: see ARCHITECTURE.md roadmap)",
    ].join("\n"),
  );
  return code;
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  // A job/render threw (e.g. INPUT_TOO_LARGE, EXECUTION_BUSY, TIMED_OUT). The failure is already
  // persisted in the run record; print a clean line for the operator instead of a stack trace.
  const code = (err as { code?: unknown }).code;
  console.error(typeof code === "string" ? `error: ${code} — ${(err as Error).message}` : `error: ${(err as Error).message}`);
  process.exit(1);
}
