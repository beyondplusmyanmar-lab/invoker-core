import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Artifact } from "../abi/index.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/**
 * Local persistence. Holds jobs, runs, artifacts, cache lookups, plugins, templates,
 * and scheduler state. SQLite from day one: cheap, portable, and the natural home for
 * cache-hit logic and missed-run state.
 */
export class Store {
  private readonly db: Database;

  constructor(private readonly workspaceDir: string) {
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
    this.db = new Database(join(workspaceDir, "invoker.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  private get artifactsDir(): string {
    return join(this.workspaceDir, "artifacts");
  }

  artifactPath(id: string, type: string): string {
    return join(this.artifactsDir, `${id}.${type}`);
  }

  findArtifactByCacheKey(cacheKey: string): Artifact | undefined {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE cache_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(cacheKey) as Record<string, unknown> | null;
    return row ? rowToArtifact(row) : undefined;
  }

  saveArtifact(a: Artifact): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO artifacts
         (id, cache_key, artifact_sha256, type, mime, path, size,
          engine_version, template_version, deterministic, created_at)
         VALUES ($id, $cacheKey, $sha, $type, $mime, $path, $size,
          $ev, $tv, $det, $createdAt)`,
      )
      .run({
        $id: a.id,
        $cacheKey: a.cacheKey,
        $sha: a.artifactSha256,
        $type: a.type,
        $mime: a.mime,
        $path: a.path,
        $size: a.size,
        $ev: a.engineVersion,
        $tv: a.templateVersion ?? null,
        $det: a.deterministic ? 1 : 0,
        $createdAt: a.createdAt,
      });
  }

  close(): void {
    this.db.close();
  }
}

function rowToArtifact(r: Record<string, unknown>): Artifact {
  return {
    id: String(r.id),
    type: String(r.type),
    mime: String(r.mime),
    path: String(r.path),
    size: Number(r.size),
    cacheKey: String(r.cache_key),
    artifactSha256: String(r.artifact_sha256),
    engineVersion: String(r.engine_version),
    templateVersion: r.template_version == null ? undefined : String(r.template_version),
    deterministic: Number(r.deterministic) === 1,
    createdAt: Number(r.created_at),
  };
}
