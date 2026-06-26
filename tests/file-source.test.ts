import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileFetchProvider, RoutingFetchProvider, fileRefToPath } from "../src/core/fetch.ts";
import type { FetchProvider } from "../src/providers/index.ts";

test("fileRefToPath maps file: forms to paths", () => {
  expect(fileRefToPath("file:/abs/x.json")).toBe("/abs/x.json");
  expect(fileRefToPath("file:///abs/x.json")).toBe("/abs/x.json");
  expect(fileRefToPath("file:./rel.json")).toBe("./rel.json");
  expect(fileRefToPath("file://localhost/abs/x.json")).toBe("/abs/x.json");
});

test("FileFetchProvider reads JSON from a file: reference (offline)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invoker-file-"));
  const f = join(dir, "data.json");
  writeFileSync(f, JSON.stringify({ hello: "world", n: 3 }));
  try {
    const fp = new FileFetchProvider();
    expect(await fp.fetchJson(`file:${f}`)).toEqual({ hello: "world", n: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RoutingFetchProvider sends file: local and everything else to HTTP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invoker-route-"));
  const f = join(dir, "d.json");
  writeFileSync(f, JSON.stringify({ via: "file" }));
  const httpStub: FetchProvider = { async fetchJson() { return { via: "http" }; } };
  try {
    const r = new RoutingFetchProvider(httpStub);
    expect(await r.fetchJson(`file:${f}`)).toEqual({ via: "file" });
    expect(await r.fetchJson("https://example.test/api")).toEqual({ via: "http" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
