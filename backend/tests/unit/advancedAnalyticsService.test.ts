import { describe, it, expect } from "vitest";
import { resolveDateRange, AnalyticsError } from "../../src/services/advancedAnalyticsService";

describe("advancedAnalyticsService.resolveDateRange", () => {
  it("'today' resolves to a ~1 day window ending at or before now", () => {
    const range = resolveDateRange("today");
    const spanMs = range.until.getTime() - range.since.getTime();
    expect(spanMs).toBeGreaterThan(0);
    expect(spanMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    expect(range.until.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("'week' resolves to a ~7 day rolling window", () => {
    const range = resolveDateRange("week");
    const spanDays = (range.until.getTime() - range.since.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(6);
    expect(spanDays).toBeLessThanOrEqual(7.1);
  });

  it("'month' resolves to a ~30 day rolling window", () => {
    const range = resolveDateRange("month");
    const spanDays = (range.until.getTime() - range.since.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeGreaterThan(29);
    expect(spanDays).toBeLessThanOrEqual(30.1);
  });

  it("'custom' resolves to exactly the given IST calendar day bounds", () => {
    const range = resolveDateRange("custom", "2026-01-01", "2026-01-03");
    expect(range.since.toISOString()).toContain("2025-12-31"); // IST midnight Jan 1 is Dec 31 18:30 UTC
    expect(range.until.getTime()).toBeGreaterThan(range.since.getTime());
  });

  it("'custom' without from/to throws AnalyticsError instead of silently defaulting", () => {
    expect(() => resolveDateRange("custom")).toThrow(AnalyticsError);
  });

  it("'custom' with only one of from/to throws AnalyticsError", () => {
    expect(() => resolveDateRange("custom", "2026-01-01")).toThrow(AnalyticsError);
  });
});
