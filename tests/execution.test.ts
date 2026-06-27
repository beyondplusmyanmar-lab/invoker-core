import { test, expect } from "bun:test";
import {
  ExecutionCoordinator,
  ExecutionBusyError,
  ExecutionTimeoutError,
} from "../src/core/execution.ts";

/** A promise you resolve by hand, to hold an execution "in flight" deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent identical requests collapse onto ONE execution (1 render, N-1 attach)", async () => {
  const coord = new ExecutionCoordinator();
  let runs = 0;
  const gate = deferred<void>();
  const factory = async () => {
    runs++;
    await gate.promise;
    return "artifact";
  };

  const all = Promise.all([
    coord.run("k", factory),
    coord.run("k", factory),
    coord.run("k", factory),
  ]);
  await Bun.sleep(10); // let all three reach the coordinator
  expect(runs).toBe(1); // only the leader ran
  expect(coord.pendingCount()).toBe(1); // one in-flight execution, two attached
  expect(coord.pending()[0]!.waiters).toBe(2);

  gate.resolve();
  const outcomes = await all;
  expect(outcomes.map((o) => o.result)).toEqual(["artifact", "artifact", "artifact"]);
  expect(outcomes.filter((o) => o.leader)).toHaveLength(1); // exactly one leader
  expect(coord.pendingCount()).toBe(0); // released
});

test("a NEW distinct key beyond maxPending is rejected (no hidden queue)", async () => {
  const coord = new ExecutionCoordinator({ maxPending: 2 });
  const g1 = deferred<void>();
  const g2 = deferred<void>();
  const a = coord.run("a", async () => {
    await g1.promise;
    return 1;
  });
  const b = coord.run("b", async () => {
    await g2.promise;
    return 2;
  });
  await Bun.sleep(10);
  expect(coord.pendingCount()).toBe(2);

  await expect(coord.run("c", async () => 3)).rejects.toBeInstanceOf(ExecutionBusyError);
  // ...but attaching to an EXISTING key is always allowed (it adds no load).
  const attach = coord.run("a", async () => 99);

  g1.resolve();
  g2.resolve();
  expect((await a).result).toBe(1);
  expect((await b).result).toBe(2);
  expect((await attach).result).toBe(1); // got the leader's result, not 99
});

test("an execution that exceeds its budget rejects TIMED_OUT and releases the slot", async () => {
  const coord = new ExecutionCoordinator({ maxDurationMs: 20 });
  const never = new Promise<string>(() => {}); // resolves never
  await expect(coord.run("slow", () => never)).rejects.toMatchObject({ code: "TIMED_OUT" });
  expect(coord.pendingCount()).toBe(0); // slot freed even though the work is a zombie
});

test("the abort signal fires on timeout (best-effort cancellation)", async () => {
  const coord = new ExecutionCoordinator({ maxDurationMs: 20 });
  let aborted = false;
  const factory = (signal: AbortSignal) =>
    new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve("aborted");
      });
    });
  await expect(coord.run("x", factory)).rejects.toBeInstanceOf(ExecutionTimeoutError);
  await Bun.sleep(5);
  expect(aborted).toBe(true);
});
