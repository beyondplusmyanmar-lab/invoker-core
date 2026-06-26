import type { FetchProvider } from "../providers/index.ts";
import { resolveSecret } from "./secrets.ts";

export interface HttpFetchOptions {
  /** Optional bearer token reference (env:/file:/keychain:/exec:). Resolved per fetch. */
  tokenRef?: string;
  headers?: Record<string, string>;
}

/**
 * Generic outbound JSON fetcher (ADR-001/004). Knows how to GET a URL with an optional
 * bearer token — and nothing about what the JSON means. Domain auth and endpoints belong
 * in a plugin's FetchProvider; this is the neutral default.
 */
export class HttpFetchProvider implements FetchProvider {
  constructor(private readonly opts: HttpFetchOptions = {}) {}

  async fetchJson(
    ref: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(ref);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = { accept: "application/json", ...this.opts.headers };
    if (this.opts.tokenRef) {
      headers.authorization = `Bearer ${resolveSecret(this.opts.tokenRef)}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`fetch ${url.pathname} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
