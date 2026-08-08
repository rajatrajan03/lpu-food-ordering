import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestContext } from "../helpers/fixtures";
import { getOwnerForecast, ForecastError } from "../../src/services/forecastService";

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("Forecast flow: insufficient data -> refuses to fabricate", () => {
  it("reports insufficient data for a freshly created stall with no order history", async () => {
    const stall = await ctx.createStall();
    const forecast = await getOwnerForecast(stall.id);
    expect(forecast.sufficient).toBe(false);
    if (!forecast.sufficient) {
      expect(forecast.reason).toMatch(/not enough/i);
    }
  });

  it("throws ForecastError for an unknown stall id", async () => {
    await expect(getOwnerForecast("00000000-0000-0000-0000-000000000000")).rejects.toThrow(ForecastError);
  });
});

describe("Forecast flow: sufficient historical data -> a real structured forecast is generated", () => {
  it("returns a schema-valid forecast once enough historical orders exist", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 50 });
    const slot = await ctx.createPickupSlot(stall.id);

    // 6 distinct past days, 2 orders/day — comfortably over the sufficiency threshold.
    for (let dayOffset = 1; dayOffset <= 6; dayOffset++) {
      for (let j = 0; j < 2; j++) {
        const placedAt = new Date(Date.now() - dayOffset * 24 * 60 * 60_000 - j * 3_600_000);
        const order = await ctx.createOrder({
          studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id,
          status: "completed", totalAmount: 100 + dayOffset, placedAt, updatedAt: placedAt,
        });
        ctx.trackOrder(order.id);
      }
    }

    const forecast = await getOwnerForecast(stall.id);
    expect(forecast.sufficient).toBe(true);
    if (forecast.sufficient) {
      expect(typeof forecast.expectedOrdersTomorrow).toBe("number");
      expect(Array.isArray(forecast.predictedBestSellers)).toBe(true);
      expect(["low", "medium", "high"]).toContain(forecast.confidence);
    }
  }, 30_000);
});
