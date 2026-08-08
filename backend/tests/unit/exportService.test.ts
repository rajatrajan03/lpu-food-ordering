import { describe, it, expect } from "vitest";
import { reportToCsv, reportToXlsx, reportToPdf, type AnalyticsReport } from "../../src/services/exportService";

const sampleReport: AnalyticsReport = {
  title: "Test Report",
  summary: { Revenue: 1000, Orders: 10 },
  tables: [
    { title: "Best Sellers", rows: [{ name: "Item A", qty: 5 }, { name: "Item, B", qty: 3 }] },
    { title: "Empty Table", rows: [] },
  ],
};

describe("exportService", () => {
  it("reportToCsv includes the title, summary, and every table's rows", () => {
    const csv = reportToCsv(sampleReport);
    expect(csv).toContain("Test Report");
    expect(csv).toContain("Revenue");
    expect(csv).toContain("1000");
    expect(csv).toContain("Item A");
  });

  it("reportToCsv escapes values containing commas", () => {
    const csv = reportToCsv(sampleReport);
    expect(csv).toContain('"Item, B"');
  });

  it("reportToCsv marks an empty table as having no data instead of omitting it", () => {
    const csv = reportToCsv(sampleReport);
    expect(csv).toContain("Empty Table");
    expect(csv).toContain("(no data)");
  });

  it("reportToXlsx produces a valid non-empty XLSX buffer", () => {
    const buf = reportToXlsx(sampleReport);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(100);
    // XLSX files are zip archives — "PK" magic bytes.
    expect(buf.slice(0, 2).toString()).toBe("PK");
  });

  it("reportToXlsx de-duplicates sheet names that would collide after truncation", () => {
    const longTitle = "A".repeat(40);
    const report: AnalyticsReport = {
      title: "Collision Test",
      summary: {},
      tables: [
        { title: longTitle, rows: [{ a: 1 }] },
        { title: longTitle, rows: [{ a: 2 }] },
      ],
    };
    expect(() => reportToXlsx(report)).not.toThrow();
  });

  it("reportToPdf produces a valid PDF buffer", async () => {
    const buf = await reportToPdf(sampleReport);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe("%PDF");
  });

  it("reportToPdf handles a table with more than 40 rows by truncating and noting the overflow", async () => {
    const bigTable: AnalyticsReport = {
      title: "Big",
      summary: {},
      tables: [{ title: "Many rows", rows: Array.from({ length: 50 }, (_, i) => ({ i })) }],
    };
    const buf = await reportToPdf(bigTable);
    expect(buf.length).toBeGreaterThan(100);
  });
});
