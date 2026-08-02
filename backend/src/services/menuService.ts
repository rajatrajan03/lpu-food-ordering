import { prisma } from "../lib/prisma";

export async function searchMenu(params: {
  query?: string;
  stallId?: string;
  categoryName?: string;
  vegOnly?: boolean;
  area?: string;
  block?: string;
  limit?: number;
  offset?: number;
}) {
  // A WhatsApp reply listing every match gets long fast — 8 keeps the AI's
  // formatted response (and its footprint in conversation history) small
  // enough to not blow Groq's free-tier tokens-per-minute budget on the next turn.
  const { query, stallId, categoryName, vegOnly, area, block, limit = 8, offset = 0 } = params;

  return prisma.menuItem.findMany({
    where: {
      available: true,
      ...(stallId ? { stallId } : {}),
      ...(vegOnly ? { isVeg: true } : {}),
      // contains/insensitive, not exact-match — the model's phrasing of an
      // area ("cc", "CC Block", "near cc") varies, and an exact match against
      // the stored value silently returns zero results on any mismatch.
      ...(area || block
        ? {
            stall: {
              ...(area ? { area: { contains: area, mode: "insensitive" } } : {}),
              ...(block ? { block: { contains: block, mode: "insensitive" } } : {}),
            },
          }
        : {}),
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { description: { contains: query, mode: "insensitive" } },
              { category: { rawLabel: { contains: query, mode: "insensitive" } } },
              { category: { canonicalCategory: { name: { contains: query, mode: "insensitive" } } } },
            ],
          }
        : {}),
      ...(categoryName
        ? { category: { canonicalCategory: { name: { equals: categoryName, mode: "insensitive" } } } }
        : {}),
    },
    include: { variants: { where: { available: true } }, stall: true, category: true },
    // Deterministic order so `offset` reliably returns a fresh batch instead
    // of a database-default order that may repeat or shuffle between calls.
    orderBy: { id: "asc" },
    skip: offset,
    take: limit,
  });
}

export async function getStallInfo(stallId: string) {
  return prisma.stall.findUnique({
    where: { id: stallId },
    include: { categories: { include: { canonicalCategory: true } } },
  });
}

export async function listStalls(
  params: { area?: string; block?: string; query?: string; limit?: number; offset?: number } = {},
) {
  const { area, block, query, limit = 10, offset = 0 } = params;
  return prisma.stall.findMany({
    where: {
      status: "active",
      ...(area ? { area: { contains: area, mode: "insensitive" } } : {}),
      ...(block ? { block: { contains: block, mode: "insensitive" } } : {}),
      ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
    skip: offset,
    take: limit,
  });
}

/**
 * Upcoming bookable slots for a stall, excluding full ones. Without a
 * preference, soonest first. With `preferredMinutes` (minutes since
 * midnight, e.g. 18*60 for 6 PM), sorted by closeness to that time of day
 * instead — so "around 6pm" surfaces nearby slots rather than the whole
 * day's list starting from whenever the stall opens.
 */
export async function getAvailablePickupSlots(
  stallId: string,
  options: { fromDate?: Date; preferredMinutes?: number } = {},
) {
  const { fromDate = new Date(), preferredMinutes } = options;
  const slots = await prisma.pickupSlot.findMany({
    where: { stallId, slotDate: { gte: fromDate } },
    orderBy: [{ slotDate: "asc" }, { startTime: "asc" }],
    take: 50,
  });
  const available = slots.filter((s) => s.bookedCount < s.maxCapacity);

  if (preferredMinutes === undefined) return available.slice(0, 20);

  const minutesOf = (t: Date) => t.getUTCHours() * 60 + t.getUTCMinutes();
  return [...available]
    .sort((a, b) => Math.abs(minutesOf(a.startTime) - preferredMinutes) - Math.abs(minutesOf(b.startTime) - preferredMinutes))
    .slice(0, 6);
}
