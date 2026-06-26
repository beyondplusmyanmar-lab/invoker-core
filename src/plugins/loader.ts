import type { CapabilityRegistry } from "../core/registry.ts";
import type { InvokerPlugin } from "../providers/index.ts";

// ADR-008: plugins are explicit, versioned, and trust-tiered. Signing is a tier, not a gate.
export enum TrustTier {
  Unverified = 0,
  Verified = 1,
  Trusted = 2,
  Required = 3,
}

export interface PluginManifest {
  name: string;
  version: string;
  publisher?: string;
  signature?: string;
  /** Bare module specifier or path that default-exports an InvokerPlugin. */
  entry: string;
}

export interface PluginRecord {
  name: string;
  version: string;
  manifestHash: string;
  tier: TrustTier;
}

export interface LoadOptions {
  /** Hard-block anything below Verified. Default: warn, don't block. */
  requireSigned?: boolean;
  warn?: (msg: string) => void;
}

/**
 * Load registered plugins into the registry. Unverified plugins are WARNED about, not
 * blocked — so a third-party plugin (plugin-sap, plugin-odoo) can exist — unless
 * `requireSigned` is set (locked-down mode).
 */
export async function loadPlugins(
  records: PluginRecord[],
  manifests: Map<string, PluginManifest>,
  registry: CapabilityRegistry,
  opts: LoadOptions = {},
): Promise<void> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  for (const rec of records) {
    if (rec.tier < TrustTier.Verified) {
      if (opts.requireSigned) {
        warn(`✗ refusing unverified plugin '${rec.name}' (--require-signed)`);
        continue;
      }
      warn(`⚠ loading unverified plugin '${rec.name}@${rec.version}'`);
    }

    const manifest = manifests.get(rec.name);
    if (!manifest) {
      warn(`✗ no manifest for installed plugin '${rec.name}'; skipping`);
      continue;
    }

    const mod = (await import(manifest.entry)) as { default?: InvokerPlugin };
    const plugin = mod.default;
    if (plugin?.capabilities) {
      await plugin.capabilities.register(registry);
    }
  }
}
