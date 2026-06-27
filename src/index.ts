// Public entry point for invoker-core consumers (plugins, embedders).
// Re-exports the stable surface; deep imports into src/ are not part of the contract.

export { CapabilityRegistry, registry } from "./core/registry.ts";
export { invoke, computeCacheKey } from "./core/invoke.ts";
export { runPipeline } from "./core/pipeline.ts";
export type { PipelineStep } from "./core/pipeline.ts";
export { resolveSecret } from "./core/secrets.ts";
export { HttpFetchProvider, FileFetchProvider, RoutingFetchProvider, fileRefToPath } from "./core/fetch.ts";
export type { HttpFetchOptions } from "./core/fetch.ts";
export { importJobSpec } from "./core/jobspec.ts";
export { runJob, dueJobs, previousTick, nextTick, logicalRequestHash } from "./core/runner.ts";
export type { RunJobOptions } from "./core/runner.ts";
export {
  ExecutionCoordinator,
  ExecutionBusyError,
  ExecutionTimeoutError,
  DEFAULT_MAX_PENDING,
  DEFAULT_MAX_DURATION_MS,
} from "./core/execution.ts";
export type { CoordinatorOptions, ExecutionOutcome, PendingExecution } from "./core/execution.ts";
export { enforceInputLimits, largestArrayLength, InputTooLargeError, DEFAULT_LIMITS } from "./core/limits.ts";
export type { Limits } from "./core/limits.ts";
export {
  normalizePusherFrame,
  toNotificationEvent,
  pusherUrl,
  PUSHER_PROTOCOL,
} from "./core/notifications.ts";
export type { NotificationEvent, ListenerConfig, PusherFrame } from "./core/notifications.ts";
export { runListener } from "./core/notification-listener.ts";
export type { ListenerEvents } from "./core/notification-listener.ts";
export { parseSseBuffer, consumeSse } from "./core/sse.ts";
export type { SseEvent } from "./core/sse.ts";
export { toChatEvent, BusinessAIClient, FetchChatTransport } from "./core/businessai.ts";
export type { ChatEvent, ChatHandlers, ChatTransport, BusinessAIConfig } from "./core/businessai.ts";
export { verifyArtifact, buildVerifyReport, checkOoxml } from "./core/verify.ts";
export type { VerifyReport, VerifyCheck, ManifestSidecar } from "./core/verify.ts";
export { gatherHealth, buildHealthReport } from "./core/health.ts";
export type { HealthReport, HealthInputs, ConnStatus, SchedulerStatus, GatherHealthOptions } from "./core/health.ts";
export { runCleanup, planArtifactCleanup, maybeMaintain, DEFAULT_RETENTION } from "./core/retention.ts";
export type { RetentionPolicy, CleanupReport, ArtifactBrief } from "./core/retention.ts";
export { VERSION } from "./version.ts";
export { handleRequest, startUiServer } from "./transports/ui/server.ts";
export type { UiContext } from "./transports/ui/server.ts";
export { SchedulePolicy, decideRun } from "./core/scheduler.ts";
export type { ScheduledJob, SchedulerState } from "./core/scheduler.ts";
export {
  runDaemonLoop,
  tickOnce,
  acquireLock,
  releaseLock,
  readLock,
  isAlive,
  abortableSleep,
  lockPath,
  DEFAULT_INTERVAL_MS,
} from "./core/daemon.ts";
export type { LockInfo, TickResult, DaemonLoopOptions } from "./core/daemon.ts";
export { runDoctor, runPilotCheck, gteVersion } from "./core/doctor.ts";
export type { DoctorCheck, DoctorReport, CheckStatus, DoctorDeps, PilotGate, PilotReport } from "./core/doctor.ts";
export { Store } from "./storage/db.ts";
export type {
  RunRecord,
  RunListItem,
  ScheduleRow,
  NotificationRecord,
  DaemonHeartbeat,
  PluginSummary,
} from "./storage/db.ts";
export type {
  AuthProvider,
  FetchProvider,
  TemplateProvider,
  CapabilityProvider,
  InvokerPlugin,
  LoadedTemplate,
} from "./providers/index.ts";
export { excelRender, renderWorkbook } from "./engines/excel/index.ts";
export { docxRender, renderDocument } from "./engines/docx/index.ts";
export { tabularMap, mapToTable, resolvePath, coerce } from "./engines/tabular/index.ts";
export type { Mapping, MappingColumn } from "./engines/tabular/index.ts";
export { assertDeterministic } from "./engines/conformance.ts";
export type {
  Capability,
  CapabilityId,
  CapabilityDescriptor,
  InvokeRequest,
  InvokeContext,
  CapabilityOutput,
  ArtifactOutput,
  DataOutput,
  Column,
  ColumnType,
  TableModel,
} from "./abi/capability.ts";
export type { Artifact, InvokeResult } from "./abi/artifact.ts";
