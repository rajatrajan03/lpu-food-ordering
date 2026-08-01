import { prisma } from "../lib/prisma";

export async function searchMenu(params: {
  query?: string;
  stallId?: string;
  categoryName?: string;
  vegOnly?: boolean;
  limit?: number;
}) {
  // A WhatsApp reply listing every match gets long fast — 8 keeps the AI's
  // formatted response (and its footprint in conversation history) small
  // enough to not blow Groq's free-tier tokens-per-minute budget on the next turn.
  const { query, stallId, categoryName, vegOnly, limit = 8 } = params;

  return prisma.menuItem.findMany({
    where: {
      available: true,
      ...(stallId ? { stallId } : {}),
      ...(vegOnly ? { isVeg: true } : {}),
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
    take: limit,
  });
}

export async function getStallInfo(stallId: string) {
  return prisma.stall.findUnique({
    where: { id: stallId },
    include: { categories: { include: { canonicalCategory: true } } },
  });
}

export async function listStalls(params: { area?: string; block?: string } = {}) {
  return prisma.stall.findMany({
    where: { status: "active", ...params },
    orderBy: { name: "asc" },
  });
}

/** Upcoming bookable slots for a stall, soonest first, excluding full ones. */
export async function getAvailablePickupSlots(stallId: string, fromDate = new Date()) {
  const slots = await prisma.pickupSlot.findMany({
    where: { stallId, slotDate: { gte: fromDate } },
    orderBy: [{ slotDate: "asc" }, { startTime: "asc" }],
    take: 50,
  });
  // Prisma can't compare two columns in `where`, so the capacity filter runs here.
  return slots.filter((s) => s.bookedCount < s.maxCapacity).slice(0, 20);
}
