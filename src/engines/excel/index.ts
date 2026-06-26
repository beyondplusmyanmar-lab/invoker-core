import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import type { Capability, InvokeContext, RenderOutput } from "../../abi/index.ts";

export const ENGINE_VERSION = "1.0.0";
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Generic tabular input. The engine knows NOTHING about DOEH or "reports" (ADR-001) —
 * it renders whatever columns/rows it is handed.
 */
export interface SheetData {
  sheet?: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
}

/**
 * Render an .xlsx deterministically (ADR-007). Two sources of nondeterminism are
 * neutralized: (1) workbook created/modified dates are pinned; (2) the resulting ZIP
 * is re-emitted with sorted entries and zeroed mtimes via fflate.
 */
export async function renderWorkbook(input: unknown): Promise<Uint8Array> {
  const data = asSheetData(input);

  const wb = new ExcelJS.Workbook();
  // Pin all metadata timestamps so docProps/core.xml is byte-stable.
  const epoch = new Date(0);
  wb.created = epoch;
  wb.modified = epoch;
  wb.lastModifiedBy = "invoker";
  wb.creator = "invoker";

  const ws = wb.addWorksheet(data.sheet ?? "Sheet1");
  ws.addRow(data.columns);
  for (const row of data.rows) ws.addRow(row);

  const raw = new Uint8Array(await wb.xlsx.writeBuffer());
  return normalizeZip(raw);
}

// The ZIP format's epoch is 1980-01-01; fflate rejects earlier mtimes. Pin every entry here.
const FIXED_MTIME = new Date("1980-01-01T00:00:00Z");

/** Re-emit a zip with deterministic entry order and a fixed mtime. */
function normalizeZip(bytes: Uint8Array): Uint8Array {
  const entries = unzipSync(bytes);
  const sorted: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  for (const name of Object.keys(entries).sort()) {
    // fflate writes entries in insertion order → sorted insertion gives a stable layout.
    sorted[name] = [entries[name]!, { mtime: FIXED_MTIME, level: 6 }];
  }
  return zipSync(sorted, { mtime: FIXED_MTIME });
}

function asSheetData(input: unknown): SheetData {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) {
    throw new Error("excel.render expects { columns: string[], rows: any[][], sheet?: string }");
  }
  return o as unknown as SheetData;
}

export const excelRender: Capability = {
  id: "excel.render",
  contractVersion: 1,
  engineVersion: ENGINE_VERSION,
  deterministic: true,
  supportsDryRun: true,
  cacheable: true,
  async execute(ctx: InvokeContext): Promise<RenderOutput> {
    const bytes = await renderWorkbook(ctx.data);
    return { bytes, type: "xlsx", mime: MIME_XLSX };
  },
};
