// The capability ABI. These shapes are what every transport (CLI, scheduler, MCP, UI)
// and every plugin binds to. Changing them is a contractVersion event — see ARCHITECTURE.md.

export type CapabilityId = string; // e.g. "excel.render"

/** Identity + traits of a capability. The three version dimensions are kept independent. */
export interface CapabilityDescriptor {
  id: CapabilityId;
  /** Public schema contract. Bumps rarely; breaking it forces callers to migrate. */
  contractVersion: number;
  /** Implementation/semver. Bumping invalidates the cache, not the contract. */
  engineVersion: string;
  deterministic: boolean;
  supportsDryRun: boolean;
  cacheable: boolean;
}

/** A registered, executable capability. */
export interface Capability extends CapabilityDescriptor {
  execute(ctx: InvokeContext): Promise<CapabilityOutput>;
  /**
   * Optional representative input used by `invoker capability verify` to self-check the
   * determinism claim. Domain-agnostic — the engine's own minimal sample, not real data.
   */
  sample?: () => Record<string, unknown>;
}

/** Presentation-neutral tabular model. The shared currency between map and render. */
export type ColumnType = "string" | "number" | "date" | "currency";
export interface Column {
  id: string;
  header: string;
  type?: ColumnType;
}
export interface TableModel {
  columns: Column[];
  rows: unknown[][];
  sheet?: string;
}

/** A single unit of work. Built by a transport, never holds business logic. */
export interface InvokeRequest {
  /** Caller-supplied idempotency/run id. */
  id: string;
  capability: CapabilityId;
  contractVersion: number;
  /** Capability-specific knobs (sheet name, page size, …). */
  params: Record<string, unknown>;
  /** Optional template + its version (feeds the cache key). */
  template?: string;
  templateVersion?: string;
  /** Resolved JSON facts to render. Fetched by a FetchProvider before invoke(). */
  data?: Record<string, unknown>;
  /** If true: compute cacheKey + report HIT/MISS, but render nothing. */
  dryRun?: boolean;
}

/**
 * A capability either produces an artifact (bytes the core hashes/persists) or transforms
 * data (a structured value fed forward to the next pipeline step). The discriminant lets
 * one invoke() path serve render engines and data-shaping capabilities alike.
 */
export type CapabilityOutput = ArtifactOutput | DataOutput;

/** Terminal output: raw bytes + type metadata. The core hashes and persists it. */
export interface ArtifactOutput {
  kind: "artifact";
  bytes: Uint8Array;
  /** Short type tag, e.g. "xlsx". */
  type: string;
  mime: string;
}

/** Intermediate output: a structured value (e.g. a TableModel) fed to the next step. */
export interface DataOutput {
  kind: "data";
  value: Record<string, unknown>;
}

export interface InvokeContext {
  request: InvokeRequest;
  data: Record<string, unknown>;
}
