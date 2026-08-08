import { prisma } from "../lib/prisma";
import { Prisma, type RatingReason } from "@prisma/client";

export class RatingError extends Error {}

/**
 * Only a completed order, belonging to the submitting student, that hasn't
 * already been rated can be rated — enforced both here (a clear error
 * before touching the DB) and at the schema level (Rating.orderId is
 * unique, so a race between two submission attempts still can't produce
 * two ratings for the same order).
 */
export async function submitRating(params: {
  orderId: string;
  studentId: string;
  stars: number;
  reason?: RatingReason;
  comment?: string;
}) {
  const { orderId, studentId, stars, reason, comment } = params;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new RatingError("Rating must be a whole number between 1 and 5 stars.");
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.studentId !== studentId) {
    throw new RatingError("Order not found.");
  }
  if (order.status !== "completed") {
    throw new RatingError("Only completed orders can be rated.");
  }

  try {
    return await prisma.rating.create({
      data: { orderId, studentId, stallId: order.stallId, stars, reason, comment: comment || undefined },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new RatingError("This order has already been rated.");
    }
    throw err;
  }
}

export async function hasRating(orderId: string): Promise<boolean> {
  const existing = await prisma.rating.findUnique({ where: { orderId } });
  return existing !== null;
}

/** Aggregated rating for student-facing display — average + count only, never comments/reasons/reviewer identity. */
export async function getStallRatingSummary(stallId: string): Promise<{ average: number | null; count: number }> {
  const agg = await prisma.rating.aggregate({ where: { stallId }, _avg: { stars: true }, _count: true });
  return { average: agg._avg.stars != null ? Math.round(agg._avg.stars * 10) / 10 : null, count: agg._count };
}

/** Batch version of getStallRatingSummary for list displays (Browse Stalls, list_stalls) — one query instead of N. */
export async function getStallRatingSummaries(
  stallIds: string[],
): Promise<Map<string, { average: number; count: number }>> {
  const map = new Map<string, { average: number; count: number }>();
  if (stallIds.length === 0) return map;
  const groups = await prisma.rating.groupBy({
    by: ["stallId"],
    where: { stallId: { in: stallIds } },
    _avg: { stars: true },
    _count: true,
  });
  for (const g of groups) {
    map.set(g.stallId, { average: Math.round((g._avg.stars ?? 0) * 10) / 10, count: g._count });
  }
  return map;
}

/**
 * Full detail for the Owner Dashboard — average/count, a breakdown of
 * complaint reasons (only ever recorded for <=3-star ratings), and recent
 * comments. Deliberately never includes which student left a given rating
 * — anonymous even to the stall owner, not just to other students.
 */
export async function getStallRatingDetail(stallId: string) {
  const [summary, reasonGroups, recentComments] = await Promise.all([
    getStallRatingSummary(stallId),
    prisma.rating.groupBy({ by: ["reason"], where: { stallId, reason: { not: null } }, _count: true }),
    prisma.rating.findMany({
      where: { stallId, comment: { not: null } },
      select: { stars: true, reason: true, comment: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return {
    average: summary.average,
    count: summary.count,
    breakdown: reasonGroups.map((g) => ({ reason: g.reason as RatingReason, count: g._count })),
    recentComments,
  };
}

/** Campus-wide stall rankings for the Admin Dashboard — average + total only, no comments or reasons. */
export async function getStallRankings(limit = 50) {
  const groups = await prisma.rating.groupBy({ by: ["stallId"], _avg: { stars: true }, _count: true });
  if (groups.length === 0) return [];
  const stalls = await prisma.stall.findMany({
    where: { id: { in: groups.map((g) => g.stallId) } },
    select: { id: true, name: true, block: true },
  });
  const stallById = new Map(stalls.map((s) => [s.id, s]));
  return groups
    .map((g) => ({
      stallId: g.stallId,
      name: stallById.get(g.stallId)?.name ?? "Unknown stall",
      block: stallById.get(g.stallId)?.block ?? "",
      average: Math.round((g._avg.stars ?? 0) * 10) / 10,
      count: g._count,
    }))
    .sort((a, b) => b.average - a.average || b.count - a.count)
    .slice(0, limit);
}
