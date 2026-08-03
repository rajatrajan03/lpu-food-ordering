import { prisma } from "../lib/prisma";

/** Night window is 10 PM–6 AM IST — outside that, every active stall is eligible regardless of nightOpen. */
function isNightTimeIST(): boolean {
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440; // UTC+5:30
  const istHour = Math.floor(istMinutes / 60);
  return istHour >= 22 || istHour < 6;
}

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

  const isNight = isNightTimeIST();
  return prisma.menuItem.findMany({
    where: {
      available: true,
      ...(stallId ? { stallId } : {}),
      ...(vegOnly ? { isVeg: true } : {}),
      // A stall's own status/night-hours gate whether its items show up at
      // all, on top of any area/block the caller asked for. contains/
      // insensitive (not exact-match) for area/block — the model's phrasing
      // ("cc", "CC Block", "near cc") varies, and an exact match against the
      // stored value silently returns zero results on any mismatch.
      stall: {
        status: "active",
        ...(isNight ? { nightOpen: true } : {}),
        ...(area ? { area: { contains: area, mode: "insensitive" } } : {}),
        ...(block ? { block: { contains: block, mode: "insensitive" } } : {}),
      },
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

/** Category buttons/list for a stall — grouped by canonical name (raw import label when unmapped). */
export async function listStallCategories(stallId: string) {
  const categories = await prisma.menuCategory.findMany({
    where: { stallId, items: { some: { available: true } } },
    include: { canonicalCategory: true },
  });
  const names = new Set<string>();
  for (const c of categories) names.add(c.canonicalCategory?.name ?? c.rawLabel);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Available items in a stall's category, matched by the same display-name grouping as listStallCategories. */
export async function listItemsInCategoryName(stallId: string, categoryName: string) {
  return prisma.menuItem.findMany({
    where: {
      stallId,
      available: true,
      category: {
        OR: [
          { canonicalCategory: { name: categoryName } },
          { canonicalCategoryId: null, rawLabel: categoryName },
        ],
      },
    },
    include: { variants: { where: { available: true } } },
    orderBy: { name: "asc" },
  });
}

/** Distinct campus areas with at least one active, currently-eligible stall — powers the "Other Location" list. */
export async function listDistinctAreas(): Promise<string[]> {
  const stalls = await prisma.stall.findMany({
    where: { status: "active", area: { not: null }, ...(isNightTimeIST() ? { nightOpen: true } : {}) },
    select: { area: true },
    distinct: ["area"],
    orderBy: { area: "asc" },
  });
  return stalls.map((s) => s.area!).filter(Boolean);
}

/**
 * Stalls in (or near) `area` that currently have every one of `itemNames`
 * available — the "usual order, but which stall still has all of it" check.
 * Matching is by item name since a "usual order" is remembered by name, not
 * by a stall-specific menu item id.
 */
export async function findStallsWithAllItems(area: string, itemNames: string[]) {
  if (itemNames.length === 0) return [];
  const isNight = isNightTimeIST();
  const candidates = await prisma.stall.findMany({
    where: {
      status: "active",
      ...(isNight ? { nightOpen: true } : {}),
      area: { contains: area, mode: "insensitive" },
    },
    include: {
      items: { where: { available: true, name: { in: itemNames } }, select: { name: true } },
    },
  });
  const wanted = new Set(itemNames.map((n) => n.toLowerCase()));
  return candidates.filter((stall) => {
    const has = new Set(stall.items.map((i) => i.name.toLowerCase()));
    return [...wanted].every((n) => has.has(n));
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
      ...(isNightTimeIST() ? { nightOpen: true } : {}),
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
