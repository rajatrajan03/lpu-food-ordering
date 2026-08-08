import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TestContext } from "../helpers/fixtures";
import { generateSlotsForDay } from "../../src/services/slotGenerator";
import { prisma } from "../../src/lib/prisma";

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("slotGenerator — night-open stalls get extended hours", () => {
  it("generates more slots, spanning later hours, for a night-open stall than a regular one", async () => {
    const regular = await ctx.createStall();
    const night = await prisma.stall.create({ data: { name: `TEST_FX_NightStall_${Date.now()}`, block: "TestBlock", nightOpen: true } });
    ctx.stallIds.push(night.id);

    const day = new Date();
    day.setDate(day.getDate() + 20); // far-future day, guaranteed no pre-existing slots
    day.setHours(0, 0, 0, 0);

    const regularCount = await generateSlotsForDay(regular.id, day);
    const nightCount = await generateSlotsForDay(night.id, day, { openTime: "06:00", closeTime: "23:45" });

    expect(nightCount).toBeGreaterThan(regularCount);

    const regularSlots = await prisma.pickupSlot.findMany({ where: { stallId: regular.id, slotDate: day } });
    const nightSlots = await prisma.pickupSlot.findMany({ where: { stallId: night.id, slotDate: day } });

    const latestRegularHourIst = Math.max(...regularSlots.map((s) => istHour(s.startTime)));
    const latestNightHourIst = Math.max(...nightSlots.map((s) => istHour(s.startTime)));
    expect(latestNightHourIst).toBeGreaterThan(latestRegularHourIst);
  });

  it("never produces a slot whose end is before or equal to its start (the UTC-midnight-crossing bug)", async () => {
    const night = await prisma.stall.create({ data: { name: `TEST_FX_NightStall2_${Date.now()}`, block: "TestBlock", nightOpen: true } });
    ctx.stallIds.push(night.id);

    const day = new Date();
    day.setDate(day.getDate() + 21);
    day.setHours(0, 0, 0, 0);

    await generateSlotsForDay(night.id, day, { openTime: "06:00", closeTime: "23:45" });
    const slots = await prisma.pickupSlot.findMany({ where: { stallId: night.id, slotDate: day } });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.endTime.getTime()).toBeGreaterThan(s.startTime.getTime());
    }
  });

  it("is a no-op the second time it's called for the same stall/day (idempotent)", async () => {
    const stall = await ctx.createStall();
    const day = new Date();
    day.setDate(day.getDate() + 22);
    day.setHours(0, 0, 0, 0);

    const first = await generateSlotsForDay(stall.id, day);
    const second = await generateSlotsForDay(stall.id, day);
    expect(second).toBe(first); // returns existing count, doesn't duplicate

    const rows = await prisma.pickupSlot.count({ where: { stallId: stall.id, slotDate: day } });
    expect(rows).toBe(first);
  });
});

function istHour(t: Date): number {
  return Number(new Date(t).toLocaleString("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
}
