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

// A night-open stall (Stall.nightOpen) needs slots covering late hours too,
// not just the standard 9am-8pm window — otherwise nothing ever gets
// generated for "later tonight", which is exactly what nightOpen is
// supposed to mean. Deliberately 6am-11:45pm rather than a literal
// midnight-to-midnight full day: `slotDate` (a plain @db.Date, no
// timezone) is written and read back using its UTC calendar date, but IST
// is UTC+5:30 — so IST midnight through ~5:30am actually falls on the
// *previous* UTC calendar date, while the rest of the IST day (5:30am
// onward) falls on the correct one. A slot generated for "today" whose
// intended IST time is, say, 2am would silently get attributed to
// yesterday's UTC-dated bucket, which getAvailablePickupSlots's own
// (correctly UTC-based) "today onward" filter would then never find —
// available, but invisible. 6am-11:45pm IST maps entirely inside a single
// UTC calendar date (6am IST = 00:30 UTC *same* day, 11:45pm IST = 6:15pm
// UTC *same* day), so it needs no cross-date handling at all. This covers
// the realistic "ordering late at night" window; true dead-of-night
// (midnight-6am) is a known gap — see HANDOFF.md.
const NIGHT_OPEN_CONFIG: SlotConfig = {
  intervalMinutes: 15,
  maxCapacityPerSlot: 8,
  openTime: "06:00",
  closeTime: "23:45",
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

    // startTime/endTime are @db.Time columns — Postgres TIME has no date
    // component, so Prisma round-trips them via each instant's UTC
    // time-of-day alone, reconstructed later against a shared synthetic
    // epoch day (see menuService.combineSlotInstant/orderService.slotEndInstant,
    // which both combine a slot's `slotDate` with just the hour/minute of
    // these fields). A slot whose start and end fall on different UTC
    // calendar dates — which happens exactly once per 24h window, since
    // IST is UTC+5:30 and every IST day crosses one UTC midnight — loses
    // that day boundary on the round-trip: the end's time-of-day (00:00)
    // reads back as numerically *before* the start's (23:45), producing a
    // corrupt slot whose end precedes its own start. Only a full-day
    // (night-open) window can ever reach this; skip that one slot rather
    // than store it — a single missed 15-minute slot at the IST-05:15am
    // boundary is a far better trade than a corrupted one.
    if (Math.floor(start.getTime() / 86_400_000) !== Math.floor(end.getTime() / 86_400_000)) continue;

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
  const stalls = await prisma.stall.findMany({ where: { status: "active" }, select: { id: true, nightOpen: true } });
  for (const stall of stalls) {
    await generateSlotsForDay(stall.id, date, stall.nightOpen ? NIGHT_OPEN_CONFIG : {});
  }
  return stalls.length;
}
