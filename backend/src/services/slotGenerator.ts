import { prisma } from "../lib/prisma";

interface SlotConfig {
  intervalMinutes: number;
  maxCapacityPerSlot: number;
  openTime: string; // "HH:mm"
  closeTime: string; // "HH:mm"
}

const DEFAULT_CONFIG: SlotConfig = {
  intervalMinutes: 15,
  maxCapacityPerSlot: 8,
  openTime: "09:00",
  closeTime: "20:00",
};

function timeOnDate(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Generates a day's worth of pickup slots for a stall, if they don't already
 * exist. Meant to run once per stall per day (e.g. a scheduled job just after
 * midnight, or lazily the first time a slot for that date is requested).
 */
export async function generateSlotsForDay(stallId: string, date: Date, config: Partial<SlotConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  const existing = await prisma.pickupSlot.count({ where: { stallId, slotDate: dayStart } });
  if (existing > 0) return existing;

  const open = timeOnDate(date, cfg.openTime);
  const close = timeOnDate(date, cfg.closeTime);
  const slots: { stallId: string; slotDate: Date; startTime: Date; endTime: Date; maxCapacity: number }[] = [];

  for (let t = new Date(open); t < close; t.setMinutes(t.getMinutes() + cfg.intervalMinutes)) {
    const start = new Date(t);
    const end = new Date(t);
    end.setMinutes(end.getMinutes() + cfg.intervalMinutes);
    slots.push({
      stallId,
      slotDate: dayStart,
      startTime: start,
      endTime: end,
      maxCapacity: cfg.maxCapacityPerSlot,
    });
  }

  await prisma.pickupSlot.createMany({ data: slots, skipDuplicates: true });
  return slots.length;
}

/** Run for every active stall — intended to be invoked by a daily scheduled job. */
export async function generateSlotsForAllStalls(date: Date) {
  const stalls = await prisma.stall.findMany({ where: { status: "active" }, select: { id: true } });
  for (const stall of stalls) {
    await generateSlotsForDay(stall.id, date);
  }
  return stalls.length;
}
