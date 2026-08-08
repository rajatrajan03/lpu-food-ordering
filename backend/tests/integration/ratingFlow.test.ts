import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestContext } from "../helpers/fixtures";
import * as ratingService from "../../src/services/ratingService";

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("Ratings flow: completed order -> rating -> feedback -> aggregate/dashboard data updates", () => {
  it("rejects a rating attempt on a non-completed order", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "placed" });

    await expect(ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 5 })).rejects.toThrow(ratingService.RatingError);
  });

  it("saves a high-star rating with no reason required", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed" });

    const rating = await ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 4 });
    expect(rating.stars).toBe(4);
    expect(rating.reason).toBeNull();
  });

  it("saves a low-star rating with a reason and comment, surfaced in the owner's rating detail", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed" });

    await ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 2, reason: "pickup_delay", comment: "Waited 20 extra minutes" });

    const detail = await ratingService.getStallRatingDetail(stall.id);
    expect(detail.count).toBe(1);
    expect(detail.average).toBe(2);
    expect(detail.breakdown).toEqual([{ reason: "pickup_delay", count: 1 }]);
    expect(detail.recentComments[0].comment).toBe("Waited 20 extra minutes");
  });

  it("enforces exactly one rating per order — a second attempt is rejected even with a different score", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed" });

    await ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 5 });
    await expect(ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 1 })).rejects.toThrow(ratingService.RatingError);

    const summary = await ratingService.getStallRatingSummary(stall.id);
    expect(summary.count).toBe(1);
    expect(summary.average).toBe(5); // the rejected second attempt must not have changed anything
  });

  it("rejects an out-of-range star value", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed" });

    await expect(ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 6 })).rejects.toThrow(ratingService.RatingError);
  });

  it("stall rankings correctly rank stalls by average rating", async () => {
    const stallHigh = await ctx.createStall();
    const stallLow = await ctx.createStall();
    const student = await ctx.createStudent();
    const item1 = await ctx.createMenuItem(stallHigh.id);
    const item2 = await ctx.createMenuItem(stallLow.id);
    const slot1 = await ctx.createPickupSlot(stallHigh.id);
    const slot2 = await ctx.createPickupSlot(stallLow.id);

    const orderHigh = await ctx.createOrder({ studentId: student.id, stallId: stallHigh.id, pickupSlotId: slot1.id, menuItemId: item1.id, status: "completed" });
    const orderLow = await ctx.createOrder({ studentId: student.id, stallId: stallLow.id, pickupSlotId: slot2.id, menuItemId: item2.id, status: "completed" });
    await ratingService.submitRating({ orderId: orderHigh.id, studentId: student.id, stars: 5 });
    await ratingService.submitRating({ orderId: orderLow.id, studentId: student.id, stars: 1 });

    const rankings = await ratingService.getStallRankings();
    const highIdx = rankings.findIndex((r) => r.stallId === stallHigh.id);
    const lowIdx = rankings.findIndex((r) => r.stallId === stallLow.id);
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });
});
