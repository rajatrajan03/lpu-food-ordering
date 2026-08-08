import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";

/** Common shape every export format renders from — built once per analytics response, not per format. */
type CellValue = string | number | boolean | null;

export interface AnalyticsReport {
  title: string;
  summary: Record<string, string | number>;
  tables: { title: string; rows: Record<string, CellValue>[] }[];
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsvBlock(rows: Record<string, CellValue>[]): string {
  if (rows.length === 0) return "(no data)\n";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))];
  return lines.join("\n") + "\n";
}

export function reportToCsv(report: AnalyticsReport): string {
  const parts: string[] = [report.title, ""];
  parts.push("Summary");
  parts.push(rowsToCsvBlock(Object.entries(report.summary).map(([metric, value]) => ({ metric, value }))));
  for (const table of report.tables) {
    parts.push(table.title);
    parts.push(rowsToCsvBlock(table.rows));
  }
  return parts.join("\n");
}

export function reportToXlsx(report: AnalyticsReport): Buffer {
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.json_to_sheet(
    Object.entries(report.summary).map(([metric, value]) => ({ metric, value })),
  );
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
  for (const table of report.tables) {
    // Sheet names are capped at 31 chars and can't repeat — truncate + de-dupe defensively.
    const baseName = table.title.slice(0, 28).replace(/[\\/*?[\]:]/g, "");
    let name = baseName || "Table";
    let i = 2;
    while (workbook.SheetNames.includes(name)) name = `${baseName}(${i++})`;
    const sheet = XLSX.utils.json_to_sheet(table.rows.length > 0 ? table.rows : [{ info: "(no data)" }]);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function reportToPdf(report: AnalyticsReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(report.title, { underline: true });
    doc.moveDown();

    doc.fontSize(13).text("Summary");
    doc.moveDown(0.3);
    doc.fontSize(10);
    for (const [metric, value] of Object.entries(report.summary)) {
      doc.text(`${metric}: ${value}`);
    }

    for (const table of report.tables) {
      doc.moveDown();
      doc.fontSize(13).text(table.title);
      doc.moveDown(0.3);
      doc.fontSize(9);
      if (table.rows.length === 0) {
        doc.text("(no data)");
        continue;
      }
      const headers = Object.keys(table.rows[0]);
      doc.text(headers.join("  |  "));
      doc.moveDown(0.15);
      for (const row of table.rows.slice(0, 40)) {
        if (doc.y > 740) doc.addPage();
        doc.text(headers.map((h) => String(row[h] ?? "")).join("  |  "));
      }
      if (table.rows.length > 40) doc.text(`… and ${table.rows.length - 40} more rows (see CSV/Excel export for the full list)`);
    }

    doc.end();
  });
}
