import { readFile } from "node:fs/promises";
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

/** Map a `file:` reference to a filesystem path: `file:./rel`, `file:/abs`, `file:///abs`. */
export function fileRefToPath(ref: string): string {
  let p = ref.slice("file:".length);
  if (p.startsWith("///")) {
    p = p.slice(2); // file:///abs → /abs
  } else if (p.startsWith("//")) {
    const rest = p.slice(2); // file://host/abs → drop the authority
    const slash = rest.indexOf("/");
    p = slash >= 0 ? rest.slice(slash) : rest;
  }
  return p; // file:./rel → ./rel ; file:/abs → /abs
}

/** Reads JSON facts from a local `file:` reference. Offline by construction — no network. */
export class FileFetchProvider implements FetchProvider {
  async fetchJson(ref: string): Promise<Record<string, unknown>> {
    const text = await readFile(fileRefToPath(ref), "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  }
}

/**
 * Routes a fetch by scheme: `file:` references read locally, everything else goes over HTTP.
 * A single FetchProvider the runner can use without knowing where a source lives (ADR-004:
 * all of it is read-only / outbound; nothing here ever listens).
 */
export class RoutingFetchProvider implements FetchProvider {
  private readonly file = new FileFetchProvider();
  constructor(private readonly http: FetchProvider) {}

  fetchJson(ref: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return ref.startsWith("file:") ? this.file.fetchJson(ref) : this.http.fetchJson(ref, params);
  }
}
