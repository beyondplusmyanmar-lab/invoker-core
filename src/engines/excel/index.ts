import ExcelJS from "exceljs";
import { normalizeZip } from "../ooxml.ts";
import type { ArtifactOutput, Capability, Column, InvokeContext, TableModel } from "../../abi/index.ts";

export const ENGINE_VERSION = "1.2.0";
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Render an .xlsx deterministically (ADR-007) from a presentation-neutral TableModel.
 * Three sources of nondeterminism are neutralized: (1) the runtime timezone is pinned to UTC;
 * (2) workbook created/modified dates are pinned; (3) the resulting ZIP is re-emitted with
 * sorted entries and a fixed mtime.
 *
 * Timezone pin (ADR-007): fflate encodes the zip mtime and exceljs serializes date cells using
 * the process's LOCAL time. Without this, a UTC host, a +8 host, and a -8 host each produce a
 * DIFFERENT artifact for identical input — and a -8 host CRASHES, because the 1980 zip epoch
 * underflows to 1979 (outside fflate's 1980–2099 range). Determinism is defined relative to a
 * pinned timezone; the runtime is UTC.
 */
export async function renderWorkbook(input: unknown): Promise<Uint8Array> {
  if (process.env.TZ !== "UTC") process.env.TZ = "UTC";
  const table = asTableModel(input);

  const wb = new ExcelJS.Workbook();
  // Pin all metadata timestamps so docProps/core.xml is byte-stable.
  const epoch = new Date(0);
  wb.created = epoch;
  wb.modified = epoch;
  wb.lastModifiedBy = "invoker";
  wb.creator = "invoker";

  const ws = wb.addWorksheet(table.sheet ?? "Sheet1");
  ws.addRow(table.columns.map((c) => c.header));
  for (const row of table.rows) ws.addRow(row as ExcelJS.CellValue[]);

  const raw = new Uint8Array(await wb.xlsx.writeBuffer());
  return normalizeZip(raw);
}

function asTableModel(input: unknown): TableModel {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) {
    throw new Error("excel.render expects a TableModel { columns: Column[], rows: any[][], sheet?: string }");
  }
  return o as unknown as TableModel;
}

const SAMPLE_COLUMNS: Column[] = [
  { id: "a", header: "A" },
  { id: "b", header: "B", type: "number" },
];

export const excelRender: Capability = {
  id: "excel.render",
  contractVersion: 1,
  engineVersion: ENGINE_VERSION,
  deterministic: true,
  supportsDryRun: true,
  cacheable: true,
  async execute(ctx: InvokeContext): Promise<ArtifactOutput> {
    const bytes = await renderWorkbook(ctx.data);
    return { kind: "artifact", bytes, type: "xlsx", mime: MIME_XLSX };
  },
  sample: () => ({ sheet: "Sample", columns: SAMPLE_COLUMNS, rows: [["x", 1], ["y", 2]] }),
};
