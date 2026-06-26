// The artifact ABI. Business AI and every transport speak in artifacts, never in files.

export interface Artifact {
  id: string;
  type: string; // "xlsx"
  mime: string;
  path: string;
  size: number;

  /** Pre-render lookup key: hash(capability, contractVersion, engineVersion, template, templateVersion, jsonHash). */
  cacheKey: string;
  /** Post-render integrity identity: sha256 of the produced bytes. Distinct from cacheKey (ADR-006). */
  artifactSha256: string;

  engineVersion: string;
  templateVersion?: string;
  deterministic: boolean;
  createdAt: number;
}

export interface InvokeResult {
  /** Present when the capability produced an artifact (render) or on a cache hit. */
  artifact?: Artifact;
  /** Present when the capability produced data (a transform step, e.g. tabular.map). */
  data?: Record<string, unknown>;
  cacheKey: string;
  cacheHit: boolean;
  durationMs: number;
  dryRun: boolean;
}
