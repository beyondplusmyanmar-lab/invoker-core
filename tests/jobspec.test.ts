import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJobSpec } from "../src/core/jobspec.ts";

test("importJobSpec: resolves relative file: source + loads step params from a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invoker-jobspec-"));
  try {
    writeFileSync(join(dir, "orders.json"), JSON.stringify({ orders: [{ id: "A1" }] }));
    writeFileSync(
      join(dir, "mapping.toml"),
      'source = "orders"\nsheet = "Daily Sales"\n\n[[columns]]\nheader = "Order"\npath = "id"\n',
    );
    // Put the job a directory down to exercise relative (../) resolution.
    const jobsDir = join(dir, "jobs");
    mkdirSync(jobsDir);
    writeFileSync(
      join(jobsDir, "daily-sales.toml"),
      [
        'id = "daily-sales"',
        'name = "Daily Sales"',
        'source = "file:../orders.json"',
        "",
        "[[steps]]",
        'capability = "tabular.map@v1"',
        'mapping = "../mapping.toml"',
        "",
        "[[steps]]",
        'capability = "excel.render@v1"',
      ].join("\n"),
    );

    const job = await importJobSpec(join(jobsDir, "daily-sales.toml"));

    expect(job.id).toBe("daily-sales");
    expect(job.steps?.length).toBe(2);
    expect(job.steps?.[0]?.capability).toBe("tabular.map");
    expect(job.steps?.[1]?.capability).toBe("excel.render");
    // mapping.toml was loaded into the step's params:
    expect((job.steps?.[0]?.params as { source?: string }).source).toBe("orders");
    // relative file: source resolved to absolute:
    expect(job.source).toBe(`file:${join(dir, "orders.json")}`);
    // terminal capability surfaces for run records; no cron → manual:
    expect(job.capability).toBe("excel.render");
    expect(job.cron).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importJobSpec: a cron makes the job schedulable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invoker-jobspec-"));
  try {
    writeFileSync(
      join(dir, "j.toml"),
      ['name = "X"', 'capability = "excel.render@v1"', 'cron = "0 8 * * *"'].join("\n"),
    );
    const job = await importJobSpec(join(dir, "j.toml"));
    expect(job.id).toBe("x"); // slugified from name
    expect(job.cron).toBe("0 8 * * *");
    expect(job.capability).toBe("excel.render");
    expect(job.contractVersion).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
