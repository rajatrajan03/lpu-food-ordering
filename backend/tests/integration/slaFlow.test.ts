import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TestContext } from "../helpers/fixtures";
import { runSlaSweep } from "../../src/services/slaMonitor";
import { prisma } from "../../src/lib/prisma";

// The sweep sends real WhatsApp notifications (rejection notice, alternative-
// stall suggestions) — stub the client so this suite tests DB state
// transitions deterministically instead of depending on a real network call
// to Meta succeeding within the test timeout (see tests/unit/whatsappClient.test.ts
// for direct coverage of the client itself).
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

describe("SLA flow: order -> no response -> auto reject -> alternative stall suggestion path", () => {
  it("auto-rejects an unanswered order past its accept deadline and releases the slot", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id, { maxCapacity: 1 });
    await prisma.pickupSlot.update({ where: { id: slot.id }, data: { bookedCount: 1 } });

    const order = await ctx.createOrder({
      studentId: student.id,
      stallId: stall.id,
      pickupSlotId: slot.id,
      menuItemId: item.id,
      status: "placed",
    });
    await prisma.order.update({ where: { id: order.id }, data: { acceptDeadline: new Date(Date.now() - 60_000) } });

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.status).toBe("rejected");
    expect(swept.autoRejected).toBe(true);

    const freedSlot = await prisma.pickupSlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(freedSlot.bookedCount).toBe(0);
  });

  it("auto-rejects a placed order with a null acceptDeadline instead of leaving it stuck forever", async () => {
    // Regression test for a real production bug: an order that somehow ended
    // up with acceptDeadline=null (placeOrder() always sets one, but this
    // happened anyway — likely data created outside the normal flow) sat in
    // "placed" for 5+ days because Postgres's `lte` comparison never matches
    // NULL. It only surfaced when an owner finally rejected it manually,
    // which sent a confusing "your order was rejected" WhatsApp message to
    // a student who'd ordered nearly a week earlier.
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "placed" });
    expect(order.acceptDeadline).toBeNull();

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.status).toBe("rejected");
    expect(swept.autoRejected).toBe(true);
  });

  it("auto-rejects a placed order older than 24h even if its acceptDeadline somehow reads as still in the future", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "placed" });
    await prisma.order.update({
      where: { id: order.id },
      data: { placedAt: new Date(Date.now() - 25 * 60 * 60_000), acceptDeadline: new Date(Date.now() + 60_000) },
    });

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.status).toBe("rejected");
  });

  it("does not touch an order that's still within its accept deadline", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id);
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "placed" });
    await prisma.order.update({ where: { id: order.id }, data: { acceptDeadline: new Date(Date.now() + 10 * 60_000) } });

    await runSlaSweep();

    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(untouched.status).toBe("placed");
    expect(untouched.autoRejected).toBe(false);
  });
});

describe("SLA flow: accepted order whose pickup slot has already ended gets flagged as a violation", () => {
  it("flags slaViolation with a positive delay once the slot end passes", async () => {
    const stall = await ctx.createStall();
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    // yesterday's slot — guaranteed already ended
    const slot = await ctx.createPickupSlot(stall.id, { dayOffset: -1 });
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "accepted" });

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.slaViolation).toBe(true);
    expect(swept.slaViolationMinutes).toBeGreaterThan(0);
  });
});

describe("No-show flow: ready -> grace period elapses -> auto-closed as no-show", () => {
  it("closes a ready order nobody collected within the pickup window + grace period", async () => {
    const stall = await ctx.createStall({ pickupGraceMinutes: 5 });
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    const slot = await ctx.createPickupSlot(stall.id, { dayOffset: -1 }); // well past slot end + any grace period
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "ready" });

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.status).toBe("completed");
    expect(swept.noShow).toBe(true);
    expect(swept.noShowAt).not.toBeNull();
  });

  it("leaves a ready order alone while still inside its grace period", async () => {
    const stall = await ctx.createStall({ pickupGraceMinutes: 60 });
    const student = await ctx.createStudent();
    const item = await ctx.createMenuItem(stall.id);
    // slot ending a couple minutes ago — well inside a 60-minute grace period
    // (createPickupSlot's `hour` is UTC — see fixtures.ts)
    const slot = await ctx.createPickupSlot(stall.id, { dayOffset: 0, hour: new Date().getUTCHours() });
    const order = await ctx.createOrder({ studentId: student.id, stallId: stall.id, pickupSlotId: slot.id, menuItemId: item.id, status: "ready" });

    await runSlaSweep();

    const swept = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(swept.status).toBe("ready");
    expect(swept.noShow).toBe(false);
  });
});
