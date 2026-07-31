import { prisma } from "../lib/prisma";

// How long a "placed" order can sit without a response before it counts as
// stuck — surfaced in the attention queue so nothing silently goes stale.
const STUCK_ORDER_MINUTES = 15;
const POPULAR_FOODS_LIMIT = 6;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatHourRange(hour: number) {
  const label = (h: number) => {
    const period = h < 12 ? "AM" : "PM";
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}${period}`;
  };
  return `${label(hour)}–${label((hour + 1) % 24)}`;
}

/**
 * The Super Admin "operations center" home screen. Every query here is a
 * single aggregation/groupBy pass (or one bounded findMany), run in parallel —
 * no per-row follow-up queries, so this stays O(1) roundtrips regardless of
 * campus size.
 */
export async function getOverview() {
  const todayStart = startOfToday();
  const stuckCutoff = new Date(Date.now() - STUCK_ORDER_MINUTES * 60_000);

  const [
    ordersTodayAgg,
    stallStatusCounts,
    unassignedStalls,
    pendingCategoryReviews,
    stuckOrders,
    completedToday,
    todaysOrders,
    orderItemsToday,
  ] = await Promise.all([
    prisma.order.aggregate({
      where: { placedAt: { gte: todayStart }, status: { not: "cancelled" } },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.stall.groupBy({ by: ["status"], _count: true }),
    prisma.stall.count({ where: { owners: { none: {} } } }),
    prisma.menuCategory.count({ where: { canonicalCategoryId: null } }),
    prisma.order.count({ where: { status: "placed", placedAt: { lt: stuckCutoff } } }),
    prisma.order.findMany({
      where: { status: "completed", updatedAt: { gte: todayStart } },
      select: { placedAt: true, updatedAt: true },
    }),
    prisma.order.findMany({
      where: { placedAt: { gte: todayStart }, status: { not: "cancelled" } },
      select: { placedAt: true },
    }),
    prisma.orderItem.findMany({
      where: { order: { placedAt: { gte: todayStart }, status: { not: "cancelled" } } },
      select: {
        quantity: true,
        itemNameSnapshot: true,
        menuItem: { select: { category: { select: { canonicalCategory: { select: { name: true } } } } } },
      },
    }),
  ]);

  const activeStalls = stallStatusCounts.find((s) => s.status === "active")?._count ?? 0;
  const pausedStalls = stallStatusCounts.find((s) => s.status === "paused")?._count ?? 0;

  const avgFulfillmentMinutes =
    completedToday.length === 0
      ? null
      : Math.round(
          completedToday.reduce((sum, o) => sum + (o.updatedAt.getTime() - o.placedAt.getTime()), 0) /
            completedToday.length /
            60_000,
        );

  const hourCounts = new Map<number, number>();
  for (const o of todaysOrders) {
    const hour = o.placedAt.getHours();
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }
  let peakHour: { label: string; orders: number } | null = null;
  for (const [hour, count] of hourCounts) {
    if (!peakHour || count > peakHour.orders) peakHour = { label: formatHourRange(hour), orders: count };
  }

  const foodCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const item of orderItemsToday) {
    foodCounts.set(item.itemNameSnapshot, (foodCounts.get(item.itemNameSnapshot) ?? 0) + item.quantity);
    const categoryName = item.menuItem.category?.canonicalCategory?.name ?? "Uncategorized";
    categoryCounts.set(categoryName, (categoryCounts.get(categoryName) ?? 0) + item.quantity);
  }
  const popularFoodsToday = [...foodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, POPULAR_FOODS_LIMIT)
    .map(([name, quantity]) => ({ name, quantity }));
  const categoryDistribution = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, quantity]) => ({ category, quantity }));

  return {
    ordersToday: ordersTodayAgg._count,
    revenueToday: Number(ordersTodayAgg._sum.totalAmount ?? 0),
    activeStalls,
    pausedStalls,
    unassignedStalls,
    pendingCategoryReviews,
    stuckOrders,
    avgFulfillmentMinutes,
    peakHour,
    popularFoodsToday,
    categoryDistribution,
  };
}

/** Recent order activity across every stall, newest state change first — the campus "live feed." */
export async function getRecentActivity(limit = 20) {
  const orders = await prisma.order.findMany({
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      totalAmount: true,
      placedAt: true,
      updatedAt: true,
      stall: { select: { name: true, block: true } },
      student: { select: { name: true, whatsappNumber: true } },
    },
  });
  return orders.map((o) => ({
    id: o.id,
    status: o.status,
    totalAmount: Number(o.totalAmount),
    placedAt: o.placedAt,
    updatedAt: o.updatedAt,
    stallName: o.stall.name,
    stallBlock: o.stall.block,
    studentLabel: o.student.name ?? o.student.whatsappNumber,
  }));
}

export interface StallInsight {
  ordersToday: number;
  revenueToday: number;
  menuItemCount: number;
  primaryCategory: string | null;
  lastActivityAt: string | null;
}

/**
 * Per-stall operational snapshot for the stall card grid — today's orders/revenue,
 * menu size, dominant category, and last activity. Five bounded/grouped queries
 * total, independent of stall count, then merged in-memory via Maps (no per-stall
 * follow-up queries).
 */
export async function getStallInsights(): Promise<Record<string, StallInsight>> {
  const todayStart = startOfToday();
  const [orderStats, menuCounts, lastActivity, categoryCounts, categoryLookup] = await Promise.all([
    prisma.order.groupBy({
      by: ["stallId"],
      where: { placedAt: { gte: todayStart }, status: { not: "cancelled" } },
      _count: true,
      _sum: { totalAmount: true },
    }),
    prisma.menuItem.groupBy({ by: ["stallId"], _count: true }),
    prisma.order.groupBy({ by: ["stallId"], _max: { updatedAt: true } }),
    prisma.menuItem.groupBy({ by: ["stallId", "categoryId"], _count: true }),
    prisma.menuCategory.findMany({ select: { id: true, canonicalCategory: { select: { name: true } } } }),
  ]);

  const categoryNameById = new Map(categoryLookup.map((c) => [c.id, c.canonicalCategory?.name ?? null]));
  const orderStatsById = new Map(orderStats.map((r) => [r.stallId, r]));
  const menuCountById = new Map(menuCounts.map((r) => [r.stallId, r._count]));
  const lastActivityById = new Map(lastActivity.map((r) => [r.stallId, r._max.updatedAt]));

  const topCategoryByStall = new Map<string, { name: string; count: number }>();
  for (const row of categoryCounts) {
    if (!row.categoryId) continue;
    const name = categoryNameById.get(row.categoryId);
    if (!name) continue;
    const current = topCategoryByStall.get(row.stallId);
    if (!current || row._count > current.count) topCategoryByStall.set(row.stallId, { name, count: row._count });
  }

  const stallIds = new Set<string>([
    ...orderStatsById.keys(),
    ...menuCountById.keys(),
    ...lastActivityById.keys(),
    ...categoryCounts.map((r) => r.stallId),
  ]);

  const insights: Record<string, StallInsight> = {};
  for (const id of stallIds) {
    const order = orderStatsById.get(id);
    const lastActivityAt = lastActivityById.get(id);
    insights[id] = {
      ordersToday: order?._count ?? 0,
      revenueToday: Number(order?._sum.totalAmount ?? 0),
      menuItemCount: menuCountById.get(id) ?? 0,
      primaryCategory: topCategoryByStall.get(id)?.name ?? null,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    };
  }
  return insights;
}
