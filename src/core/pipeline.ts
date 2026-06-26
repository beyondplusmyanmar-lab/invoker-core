import { randomUUID } from "node:crypto";
import type { InvokeResult } from "../abi/index.ts";
import type { Store } from "../storage/db.ts";
import { invoke } from "./invoke.ts";

export interface PipelineStep {
  capability: string;
  contractVersion: number;
  /** Capability config (e.g. a tabular.map Mapping). */
  params?: Record<string, unknown>;
}

/**
 * Run capabilities in sequence (e.g. tabular.map@v1 → excel.render@v1). A step that
 * produces data feeds it forward as the next step's input; a step that produces an
 * artifact is terminal. Returns the final step's result.
 *
 * Each step funnels through invoke() (ADR-002), so caching, determinism, and the
 * capability registry apply uniformly — the pipeline adds no execution logic of its own.
 */
export async function runPipeline(
  steps: PipelineStep[],
  initialData: Record<string, unknown>,
  store: Store,
): Promise<InvokeResult> {
  if (steps.length === 0) throw new Error("runPipeline: empty pipeline");

  let data = initialData;
  let last: InvokeResult | undefined;
  for (const step of steps) {
    last = await invoke(
      {
        id: randomUUID(),
        capability: step.capability,
        contractVersion: step.contractVersion,
        params: step.params ?? {},
        data,
      },
      store,
    );
    if (last.data) data = last.data; // transform → feed forward
  }
  return last!;
}
