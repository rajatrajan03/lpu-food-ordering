import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestContext } from "../helpers/fixtures";
import * as ratingService from "../../src/services/ratingService";
import { getOwnerAnalytics, resolveDateRange } from "../../src/services/advancedAnalyticsService";
import { prisma } from "../../src/lib/prisma";

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("Analytics flow: orders + ratings + offers -> analytics calculations verified", () => {
  it("computes revenue, order count, and avg order value correctly for a known set of orders", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot1 = await ctx.createPickupSlot(stall.id);
    const slot2 = await ctx.createPickupSlot(stall.id, { hour: 13 });

    const now = new Date();
    await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot1.id, menuItemId: item.id, status: "completed", totalAmount: 100, placedAt: now, updatedAt: now });
    await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot2.id, menuItemId: item.id, status: "completed", totalAmount: 300, placedAt: now, updatedAt: now });

    const range = resolveDateRange("month");
    const analytics = await getOwnerAnalytics(stall.id, range);

    expect(analytics.totalOrders).toBe(2);
    expect(analytics.revenue).toBe(400);
    expect(analytics.avgOrderValue).toBe(200);
  });

  it("excludes cancelled/rejected orders from revenue but still counts them in totalOrders", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const now = new Date();

    await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed", totalAmount: 100, placedAt: now, updatedAt: now });
    await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "cancelled", totalAmount: 500, placedAt: now, updatedAt: now });

    const analytics = await getOwnerAnalytics(stall.id, resolveDateRange("month"));
    expect(analytics.totalOrders).toBe(2);
    expect(analytics.revenue).toBe(100);
  });

  it("identifies new vs returning customers correctly across the range boundary", async () => {
    const stall = await ctx.createStall();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const returningStudent = await ctx.createStudent();
    const newStudent = await ctx.createStudent();

    const range = resolveDateRange("month");
    const beforeRange = new Date(range.since.getTime() - 24 * 60 * 60 * 1000);
    const insideRange = new Date(range.since.getTime() + 60 * 60 * 1000);

    // returning student has a completed order BEFORE the range started...
    await ctx.createOrder({ studentId: returningStudent.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed", totalAmount: 50, placedAt: beforeRange, updatedAt: beforeRange });
    // ...and orders from both students land inside the range
    await ctx.createOrder({ studentId: returningStudent.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed", totalAmount: 50, placedAt: insideRange, updatedAt: insideRange });
    await ctx.createOrder({ studentId: newStudent.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed", totalAmount: 50, placedAt: insideRange, updatedAt: insideRange });

    const analytics = await getOwnerAnalytics(stall.id, range);
    expect(analytics.returningCustomers).toBe(1);
    expect(analytics.newCustomers).toBe(1);
    expect(analytics.repeatCustomerRatePct).toBe(50);
  });

  it("rating aggregate feeds correctly into the owner analytics response", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "completed" });
    await ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 4 });

    const analytics = await getOwnerAnalytics(stall.id, resolveDateRange("month"));
    expect(analytics.rating.average).toBe(4);
    expect(analytics.rating.count).toBe(1);
  });

  it("best/worst selling items reflect actual item quantities sold", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const popular = await ctx.createMenuItem(stall.id, { name: `${Date.now()}_Popular` });
    const unpopular = await ctx.createMenuItem(stall.id, { name: `${Date.now()}_Unpopular` });
    const slot = await ctx.createPickupSlot(stall.id);
    const now = new Date();

    const order = await prisma.order.create({
      data: {
        displayId: `TEST_FX_ITEMS_${Date.now()}`,
        studentId: student.id,
        stallId: stall.id,
        pickupSlotId: slot.id,
        status: "completed",
        totalAmount: 1000,
        placedAt: now,
        updatedAt: now,
        items: {
          create: [
            { menuItemId: popular.id, quantity: 9, unitPrice: 50, itemNameSnapshot: popular.name },
            { menuItemId: unpopular.id, quantity: 1, unitPrice: 50, itemNameSnapshot: unpopular.name },
          ],
        },
      },
    });
    ctx.trackOrder(order.id);

    const analytics = await getOwnerAnalytics(stall.id, resolveDateRange("month"));
    expect(analytics.bestSellingItems[0].name).toBe(popular.name);
    expect(analytics.worstSellingItems[0].name).toBe(unpopular.name);
  });
});
