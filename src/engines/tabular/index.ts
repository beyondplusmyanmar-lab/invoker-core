import type {
  Capability,
  Column,
  ColumnType,
  DataOutput,
  InvokeContext,
  TableModel,
} from "../../abi/index.ts";

export const ENGINE_VERSION = "1.0.0";

/**
 * Declarative mapping config (supplied via params, never inline code). Deliberately
 * conservative: dotted/indexed paths, type coercion, and defaults only. No expressions,
 * callbacks, or eval — that boundary keeps business logic out of templates (ADR-001).
 */
export interface MappingColumn {
  id?: string;
  header: string;
  path: string;
  type?: ColumnType;
  default?: unknown;
}
export interface Mapping {
  /** Path to the array of records within the input. Omit to treat the input itself as the array. */
  source?: string;
  sheet?: string;
  columns: MappingColumn[];
}

/** Resolve "a.b", "items[0].price" against an object. Returns undefined on any miss. */
export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Conservative, deterministic coercion. Dates normalize to ISO so artifacts stay stable. */
export function coerce(value: unknown, type: ColumnType | undefined): unknown {
  if (value == null) return null;
  switch (type) {
    case "number":
    case "currency":
      return typeof value === "number" ? value : Number(value);
    case "date":
      return new Date(value as string | number | Date).toISOString();
    case "string":
      return String(value);
    default:
      return value;
  }
}

export function mapToTable(input: Record<string, unknown>, mapping: Mapping): TableModel {
  const raw = mapping.source ? resolvePath(input, mapping.source) : input;
  if (!Array.isArray(raw)) {
    throw new Error(
      `tabular.map: source ${mapping.source ? `"${mapping.source}"` : "(root)"} did not resolve to an array`,
    );
  }
  const columns: Column[] = mapping.columns.map((c) => ({
    id: c.id ?? c.header,
    header: c.header,
    type: c.type,
  }));
  const rows = raw.map((record) =>
    mapping.columns.map((c) => {
      const v = resolvePath(record, c.path);
      return coerce(v ?? c.default ?? null, c.type);
    }),
  );
  return { columns, rows, sheet: mapping.sheet };
}

export const tabularMap: Capability = {
  id: "tabular.map",
  contractVersion: 1,
  engineVersion: ENGINE_VERSION,
  deterministic: true,
  supportsDryRun: true,
  cacheable: false, // pure + cheap; recomputed per pipeline run rather than persisted
  async execute(ctx: InvokeContext): Promise<DataOutput> {
    const mapping = ctx.request.params as unknown as Mapping;
    const table = mapToTable(ctx.data, mapping);
    return { kind: "data", value: table as unknown as Record<string, unknown> };
  },
};
