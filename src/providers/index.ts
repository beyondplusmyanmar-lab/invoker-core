// Provider seams (ADR-001). Core defines the interfaces; implementations live in plugins.
// Core depends on these interfaces — never on a concrete (DOEH) implementation.

import type { CapabilityRegistry } from "../core/registry.ts";

/** Resolves an auth token for outbound data fetches. Implemented by e.g. DoehAuthProvider. */
export interface AuthProvider {
  resolveToken(): Promise<string>;
}

/** Fetches JSON facts from a data source. Outbound only (ADR-004). */
export interface FetchProvider {
  fetchJson(ref: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface LoadedTemplate {
  name: string;
  version: string;
  manifestHash: string;
  /** Engine-specific template payload (e.g. an xlsx skeleton + mapping). */
  payload: unknown;
}

/** Loads versioned templates. Templates are domain artifacts → live in plugins. */
export interface TemplateProvider {
  load(name: string, version?: string): Promise<LoadedTemplate>;
}

/** A plugin's entry point: registers its capabilities into the runtime registry. */
export interface CapabilityProvider {
  register(registry: CapabilityRegistry): void | Promise<void>;
}

/** The full surface a plugin may contribute. All optional except a name/version (see manifest). */
export interface InvokerPlugin {
  auth?: AuthProvider;
  fetch?: FetchProvider;
  templates?: TemplateProvider;
  capabilities?: CapabilityProvider;
}
