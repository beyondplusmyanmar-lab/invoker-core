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
  execute(ctx: InvokeContext): Promise<RenderOutput>;
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

/** What an engine returns: raw bytes + type metadata. The core hashes/persists it. */
export interface RenderOutput {
  bytes: Uint8Array;
  /** Short type tag, e.g. "xlsx". */
  type: string;
  mime: string;
}

export interface InvokeContext {
  request: InvokeRequest;
  data: Record<string, unknown>;
}
