import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TestContext } from "../helpers/fixtures";
import * as orderService from "../../src/services/orderService";
import * as ratingService from "../../src/services/ratingService";
import * as offerService from "../../src/services/offerService";
import { prisma } from "../../src/lib/prisma";

// Every status transition below fires a real WhatsApp notification
// (orderService.notifyStudentOfStatus) — stub the client so this suite
// never depends on graph.facebook.com being reachable/credentialed; what's
// under test here is order/rating/offer state, not the WhatsApp send itself
// (see tests/unit/whatsappClient.test.ts for that).
vi.mock("../../src/whatsapp/client", () => ({
  sendWhatsAppText: vi.fn(async () => {}),
  sendWhatsAppButtons: vi.fn(async () => {}),
  sendWhatsAppList: vi.fn(async () => {}),
}));

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("Student journey: browse -> cart -> checkout -> order lifecycle -> pickup -> rating", () => {
  it("places an order, moves it through the full owner lifecycle, and accepts a rating on completion", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 80 });
    const slot = await ctx.createPickupSlot(stall.id);

    const order = await orderService.placeOrder({
      studentId: student.id,
      stallId: stall.id,
      pickupSlotId: slot.id,
      lines: [{ menuItemId: item.id, quantity: 2 }],
    });
    ctx.trackOrder(order.id);

    expect(order.status).toBe("placed");
    expect(Number(order.totalAmount)).toBe(160);

    const bookedSlot = await prisma.pickupSlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(bookedSlot.bookedCount).toBe(1);

    const accepted = await orderService.transitionOrderStatus(order.id, stall.id, "accepted");
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedAt).not.toBeNull();

    const preparing = await orderService.transitionOrderStatus(order.id, stall.id, "preparing");
    expect(preparing.status).toBe("preparing");

    const ready = await orderService.transitionOrderStatus(order.id, stall.id, "ready");
    expect(ready.status).toBe("ready");
    expect(ready.readyAt).not.toBeNull();

    const completed = await orderService.transitionOrderStatus(order.id, stall.id, "completed");
    expect(completed.status).toBe("completed");

    const rating = await ratingService.submitRating({ orderId: order.id, studentId: student.id, stars: 5 });
    expect(rating.stars).toBe(5);

    const summary = await ratingService.getStallRatingSummary(stall.id);
    expect(summary.count).toBe(1);
    expect(summary.average).toBe(5);
  });

  it("rejects an out-of-order transition (placed -> ready)", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    ctx.trackOrder(order.id);

    await expect(orderService.transitionOrderStatus(order.id, stall.id, "ready")).rejects.toThrow(orderService.OrderError);
  });

  it("prevents overbooking a pickup slot at capacity", async () => {
    const stall = await ctx.createStall();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id, { maxCapacity: 1 });

    const studentA = await ctx.createStudent();
    const studentB = await ctx.createStudent();

    const orderA = await orderService.placeOrder({ studentId: studentA.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    ctx.trackOrder(orderA.id);

    await expect(
      orderService.placeOrder({ studentId: studentB.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] }),
    ).rejects.toThrow(orderService.OrderError);
  });

  it("rejects placing an order with an unavailable item", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { available: false });
    const slot = await ctx.createPickupSlot(stall.id);

    await expect(
      orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] }),
    ).rejects.toThrow(orderService.OrderError);
  });

  it("cancels a placed order and releases the pickup slot", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id, { maxCapacity: 1 });
    const order = await orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    ctx.trackOrder(order.id);

    const cancelled = await orderService.cancelOrder(order.id, student.id);
    expect(cancelled.status).toBe("cancelled");

    const freedSlot = await prisma.pickupSlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(freedSlot.bookedCount).toBe(0);

    // slot is free again — a second order for the same slot should now succeed
    const student2 = await ctx.createStudent();
    const secondOrder = await orderService.placeOrder({ studentId: student2.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    ctx.trackOrder(secondOrder.id);
    expect(secondOrder.status).toBe("placed");
  });

  it("rejects cancelling an order that's already being prepared", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    ctx.trackOrder(order.id);
    await orderService.transitionOrderStatus(order.id, stall.id, "accepted");
    await orderService.transitionOrderStatus(order.id, stall.id, "preparing");

    await expect(orderService.cancelOrder(order.id, student.id)).rejects.toThrow(orderService.OrderError);
  });
});

describe("Offer flow: multiple offers -> best offer selected -> correct discount -> order totals verified", () => {
  it("automatically applies the single best of several active offers at checkout", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 100 });
    const slot = await ctx.createPickupSlot(stall.id);

    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);

    const smallOffer = await offerService.createOffer(stall.id, {
      name: "Small 10% Off", type: "percentage_discount", validFrom: past, validUntil: future, discountPercent: 10,
    });
    const bigOffer = await offerService.createOffer(stall.id, {
      name: "Big 30% Off", type: "percentage_discount", validFrom: past, validUntil: future, discountPercent: 30,
    });
    const expiredOffer = await offerService.createOffer(stall.id, {
      name: "Expired 90% Off", type: "percentage_discount", validFrom: new Date(Date.now() - 2 * 86_400_000), validUntil: past, discountPercent: 90,
    });

    try {
      const order = await orderService.placeOrder({
        studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 2 }],
      });
      ctx.trackOrder(order.id);

      expect(order.appliedOffer?.offerId).toBe(bigOffer.id);
      expect(Number(order.discountAmount)).toBeCloseTo(60, 2); // 30% of 200
      expect(Number(order.totalAmount)).toBeCloseTo(140, 2);

      const redemption = await prisma.offerRedemption.findUnique({ where: { orderId: order.id } });
      expect(redemption).not.toBeNull();
      expect(redemption?.offerId).toBe(bigOffer.id);

      // the expired offer must never have been eligible for selection
      expect(order.appliedOffer?.offerId).not.toBe(expiredOffer.id);
      void smallOffer;
    } finally {
      await offerService.deleteOffer(smallOffer.id, stall.id).catch(() => {});
      await offerService.deleteOffer(bigOffer.id, stall.id).catch(() => {});
      await offerService.deleteOffer(expiredOffer.id, stall.id).catch(() => {});
    }
  });

  it("never applies an inactive offer even if it would otherwise be the best discount", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 100 });
    const slot = await ctx.createPickupSlot(stall.id);

    const inactiveOffer = await offerService.createOffer(stall.id, {
      name: "Inactive 99% Off", type: "percentage_discount", active: false,
      validFrom: new Date(Date.now() - 86_400_000), validUntil: new Date(Date.now() + 86_400_000), discountPercent: 99,
    });

    try {
      const order = await orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
      ctx.trackOrder(order.id);
      expect(order.appliedOffer).toBeNull();
      expect(Number(order.totalAmount)).toBe(100);
    } finally {
      await offerService.deleteOffer(inactiveOffer.id, stall.id).catch(() => {});
    }
  });

  it("respects minOrderValue — an offer is skipped when the cart doesn't meet the threshold", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 50 });
    const slot = await ctx.createPickupSlot(stall.id);

    const highMinOffer = await offerService.createOffer(stall.id, {
      name: "Spend 500 Get 20%", type: "percentage_discount", validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 86_400_000), discountPercent: 20, minOrderValue: 500,
    });

    try {
      const order = await orderService.placeOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
      ctx.trackOrder(order.id);
      expect(order.appliedOffer).toBeNull();
      expect(Number(order.totalAmount)).toBe(50);
    } finally {
      await offerService.deleteOffer(highMinOffer.id, stall.id).catch(() => {});
    }
  });
});
