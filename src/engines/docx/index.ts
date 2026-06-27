import { strToU8 } from "fflate";
import { zipDeterministic } from "../ooxml.ts";
import type { ArtifactOutput, Capability, Column, InvokeContext, TableModel } from "../../abi/index.ts";

export const ENGINE_VERSION = "1.0.0";
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Render a .docx deterministically (ADR-007) from a presentation-neutral TableModel: an optional
 * heading (the `sheet` field) followed by a bordered table whose first row is the bold header.
 *
 * The OOXML parts are hand-built rather than produced by a library, so the only nondeterminism
 * sources are (1) the runtime timezone — pinned to UTC for Date cells — and (2) the ZIP layout,
 * neutralized by the shared `zipDeterministic` canonicalizer (the same one xlsx uses). No part
 * carries a timestamp, GUID, or counter, so the bytes are a pure function of the TableModel.
 */
export function renderDocument(input: unknown): Uint8Array {
  if (process.env.TZ !== "UTC") process.env.TZ = "UTC";
  const table = asTableModel(input);

  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "word/document.xml": strToU8(documentXml(table)),
  };
  return zipDeterministic(parts);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function documentXml(table: TableModel): string {
  const heading = table.sheet ? paragraph(table.sheet, true) : "";
  const header = tableRow(table.columns.map((c) => c.header), true);
  const body = table.rows.map((r) => tableRow(r.map(cellText), false)).join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W}"><w:body>` +
    heading +
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${BORDERS}</w:tblBorders></w:tblPr>` +
    header +
    body +
    "</w:tbl>" +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' +
    "</w:body></w:document>"
  );
}

const SIDE = '<w:%s w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
const BORDERS = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map((s) => SIDE.replace("%s", s))
  .join("");

function tableRow(cells: string[], bold: boolean): string {
  const tcs = cells
    .map((text) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(text, bold)}</w:tc>`)
    .join("");
  return `<w:tr>${tcs}</w:tr>`;
}

function paragraph(text: string, bold: boolean): string {
  const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** Stringify a cell deterministically. Dates render as UTC ISO (TZ is pinned), nullish as "". */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function asTableModel(input: unknown): TableModel {
  const o = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.columns) || !Array.isArray(o.rows)) {
    throw new Error("docx.render expects a TableModel { columns: Column[], rows: any[][], sheet?: string }");
  }
  return o as unknown as TableModel;
}

const SAMPLE_COLUMNS: Column[] = [
  { id: "a", header: "A" },
  { id: "b", header: "B", type: "number" },
];

export const docxRender: Capability = {
  id: "docx.render",
  contractVersion: 1,
  engineVersion: ENGINE_VERSION,
  deterministic: true,
  supportsDryRun: true,
  cacheable: true,
  async execute(ctx: InvokeContext): Promise<ArtifactOutput> {
    const bytes = renderDocument(ctx.data);
    return { kind: "artifact", bytes, type: "docx", mime: MIME_DOCX };
  },
  sample: () => ({ sheet: "Sample", columns: SAMPLE_COLUMNS, rows: [["x", 1], ["y", 2]] }),
};
