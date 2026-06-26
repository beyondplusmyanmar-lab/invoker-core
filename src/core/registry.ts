import type { Capability, CapabilityId } from "../abi/index.ts";

/**
 * The convergence point's address book (ADR-002). Capabilities are keyed by
 * `<id>@v<contractVersion>` so multiple contract versions can coexist during a migration.
 */
export class CapabilityRegistry {
  private readonly caps = new Map<string, Capability>();

  private key(id: CapabilityId, contractVersion: number): string {
    return `${id}@v${contractVersion}`;
  }

  register(cap: Capability): void {
    const k = this.key(cap.id, cap.contractVersion);
    if (this.caps.has(k)) throw new Error(`capability already registered: ${k}`);
    this.caps.set(k, cap);
  }

  resolve(id: CapabilityId, contractVersion: number): Capability {
    const cap = this.caps.get(this.key(id, contractVersion));
    if (!cap) throw new Error(`no capability registered for ${id}@v${contractVersion}`);
    return cap;
  }

  has(id: CapabilityId, contractVersion: number): boolean {
    return this.caps.has(this.key(id, contractVersion));
  }

  list(): Capability[] {
    return [...this.caps.values()];
  }
}

/** Process-wide registry. Plugins register into this during load. */
export const registry = new CapabilityRegistry();
