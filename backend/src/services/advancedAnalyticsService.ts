import { prisma } from "../lib/prisma";
import { getSlaMetricsForStall, istDayBounds } from "./orderService";
import { getStallRatingDetail, getStallRankings, getRatingTrend } from "./ratingService";
import { getOfferAnalytics, getCampusOfferAnalytics } from "./offerService";
import type { AnalyticsReport } from "./exportService";

export class AnalyticsError extends Error {}

export type AnalyticsPeriod = "today" | "week" | "month" | "custom";

export interface DateRange {
  period: AnalyticsPeriod;
  since: Date;
  until: Date;
}

/**
 * Resolves a KPI period into concrete UTC instant bounds. "week"/"month" are
 * rolling windows (last 7 / last 30 days including today), not calendar
 * week/month — simpler and avoids calendar-boundary edge cases, consistent
 * with this app's existing preference for straightforward date math
 * (see istDayBounds). "custom" reuses istDayBounds for each IST calendar
 * day endpoint, same convention as the Owner Dashboard's existing date picker.
 */
export function resolveDateRange(period: AnalyticsPeriod, from?: string, to?: string): DateRange {
  const now = new Date();
  if (period === "custom") {
    if (!from || !to) throw new AnalyticsError("from and to (YYYY-MM-DD) are required for a custom range.");
    return { period, since: istDayBounds(from).start, until: istDayBounds(to).end };
  }
  const days = period === "today" ? 1 : period === "week" ? 7 : 30;
  const todayEnd = istDayBounds(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })).end;
  const since = new Date(todayEnd.getTime() - days * 24 * 60 * 60_000);
  return { period, since, until: now < todayEnd ? new Date() : todayEnd };
}

function dayBucketsInRange(orders: { placedAt: Date; totalAmount: unknown }[]) {
  const byDay = new Map<string, { revenue: number; orders: number }>();
  for (const o of orders) {
    const day = o.placedAt.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { revenue: 0, orders: 0 };
    bucket.revenue += Number(o.totalAmount);
    bucket.orders += 1;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, ...b }));
}

/**
 * Owner Analytics — one stall's own data for a given date range. Reuses
 * getSlaMetricsForStall (acceptance/prep/SLA/no-show), getStallRatingDetail
 * (rating breakdown/comments), and getOfferAnalytics (offer usage/discount)
 * rather than recomputing any of that here — only genuinely new
 * aggregations (revenue trend, best/worst items, category performance,
 * peak hours, new-vs-returning customers) are computed in this function.
 */
export async function getOwnerAnalytics(stallId: string, range: DateRange) {
  const stall = await prisma.stall.findUnique({ where: { id: stallId }, select: { name: true, block: true } });
  if (!stall) throw new AnalyticsError("Stall not found.");

  const [orders, orderItems, sla, ratingDetail, ratingTrend, offerAnalytics] = await Promise.all([
    prisma.order.findMany({
      where: { stallId, placedAt: { gte: range.since, lt: range.until } },
      select: {
        id: true,
        status: true,
        totalAmount: true,
        discountAmount: true,
        studentId: true,
        placedAt: true,
        updatedAt: true,
        noShow: true,
        offerRedemption: { select: { discountAmount: true } },
      },
    }),
    prisma.orderItem.findMany({
      where: { order: { stallId, placedAt: { gte: range.since, lt: range.until }, status: { not: "cancelled" } } },
      select: {
        quantity: true,
        unitPrice: true,
        itemNameSnapshot: true,
        menuItem: { select: { category: { select: { canonicalCategory: { select: { name: true } } } } } },
      },
    }),
    getSlaMetricsForStall(stallId, { since: range.since, until: range.until }),
    getStallRatingDetail(stallId),
    getRatingTrend({ since: range.since, until: range.until, stallId }),
    getOfferAnalytics(stallId),
  ]);

  const billableOrders = orders.filter((o) => o.status !== "cancelled" && o.status !== "rejected");
  const totalOrders = orders.length;
  const revenue = billableOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
  const avgOrderValue = billableOrders.length ? Math.round((revenue / billableOrders.length) * 100) / 100 : 0;

  // New vs returning: among students who ordered in this range, a student is
  // "returning" if they had any completed order before the range started.
  const studentIdsInRange = [...new Set(orders.map((o) => o.studentId))];
  const priorOrders =
    studentIdsInRange.length === 0
      ? []
      : await prisma.order.findMany({
          where: { stallId, studentId: { in: studentIdsInRange }, placedAt: { lt: range.since }, status: "completed" },
          select: { studentId: true },
          distinct: ["studentId"],
        });
  const priorStudentIds = new Set(priorOrders.map((o) => o.studentId));
  const returningCustomers = studentIdsInRange.filter((id) => priorStudentIds.has(id)).length;
  const newCustomers = studentIdsInRange.length - returningCustomers;
  const repeatCustomerRatePct = studentIdsInRange.length
    ? Math.round((returningCustomers / studentIdsInRange.length) * 1000) / 10
    : 0;

  const itemStats = new Map<string, { qty: number; revenue: number }>();
  const categoryStats = new Map<string, { qty: number; revenue: number }>();
  const hourCounts = new Map<number, number>();
  for (const line of orderItems) {
    const lineRevenue = Number(line.unitPrice) * line.quantity;
    const item = itemStats.get(line.itemNameSnapshot) ?? { qty: 0, revenue: 0 };
    item.qty += line.quantity;
    item.revenue += lineRevenue;
    itemStats.set(line.itemNameSnapshot, item);

    const categoryName = line.menuItem.category?.canonicalCategory?.name ?? "Uncategorized";
    const cat = categoryStats.get(categoryName) ?? { qty: 0, revenue: 0 };
    cat.qty += line.quantity;
    cat.revenue += lineRevenue;
    categoryStats.set(categoryName, cat);
  }
  for (const o of billableOrders) {
    const hour = o.placedAt.getUTCHours(); // display layer converts to IST for labeling
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }

  const itemEntries = [...itemStats.entries()].map(([name, v]) => ({ name, ...v }));
  const bestSellingItems = [...itemEntries].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const worstSellingItems = [...itemEntries].sort((a, b) => a.qty - b.qty).slice(0, 5);
  const categoryPerformance = [...categoryStats.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.revenue - a.revenue);
  const peakHours = [...hourCounts.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const completed = billableOrders.filter((o) => o.status === "completed");
  const avgPrepMinutes = completed.length
    ? Math.round(completed.reduce((s, o) => s + (o.updatedAt.getTime() - o.placedAt.getTime()), 0) / completed.length / 60_000)
    : null;

  const cancelledCount = orders.filter((o) => o.status === "cancelled").length;
  const cancellationRatePct = totalOrders ? Math.round((cancelledCount / totalOrders) * 1000) / 10 : 0;
  const noShowCount = orders.filter((o) => o.noShow).length;
  const noShowRatePct = totalOrders ? Math.round((noShowCount / totalOrders) * 1000) / 10 : 0;

  const offerOrders = orders.filter((o) => o.offerRedemption);
  const revenueGeneratedByOffers = offerOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
  const discountGivenInRange = offerOrders.reduce((s, o) => s + Number(o.discountAmount), 0);
  const comboPerformance = offerAnalytics.filter((o) => o.type === "combo");
  const bestPerformingOffer =
    offerAnalytics.length === 0 ? null : [...offerAnalytics].sort((a, b) => b.usageCount - a.usageCount)[0];

  return {
    stall: { name: stall.name, block: stall.block },
    range: { period: range.period, since: range.since.toISOString(), until: range.until.toISOString() },
    revenue,
    totalOrders,
    avgOrderValue,
    newCustomers,
    returningCustomers,
    repeatCustomerRatePct,
    bestSellingItems,
    worstSellingItems,
    categoryPerformance,
    comboPerformance,
    peakHours,
    sla,
    avgPrepMinutes,
    cancellationRatePct,
    noShowRatePct,
    ratingTrend,
    rating: ratingDetail,
    revenueTrend: dayBucketsInRange(billableOrders),
    offers: {
      performance: offerAnalytics,
      revenueGeneratedByOffers,
      discountGiven: discountGivenInRange,
      bestPerformingOffer,
    },
  };
}

/**
 * Super Admin Analytics — campus-wide for a given date range. Reuses
 * getStallRankings (rating rankings), getCampusOfferAnalytics (offer
 * performance), and getRatingTrend (campus rating trend); computes only
 * the genuinely new campus-scoped aggregations here (revenue/orders per
 * stall and per block, peak hours, SLA-violation ranking).
 */
export async function getAdminAnalytics(range: DateRange) {
  const [orders, stalls, ratingRankings, campusRatingTrend, offerPerformance] = await Promise.all([
    prisma.order.findMany({
      where: { placedAt: { gte: range.since, lt: range.until } },
      select: { id: true, stallId: true, status: true, totalAmount: true, placedAt: true, slaViolation: true, noShow: true },
    }),
    prisma.stall.findMany({ select: { id: true, name: true, block: true, status: true } }),
    getStallRankings(),
    getRatingTrend({ since: range.since, until: range.until }),
    getCampusOfferAnalytics(),
  ]);

  const stallById = new Map(stalls.map((s) => [s.id, s]));
  const billableOrders = orders.filter((o) => o.status !== "cancelled" && o.status !== "rejected");
  const campusRevenue = billableOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
  const campusOrders = orders.length;
  const activeStalls = stalls.filter((s) => s.status === "active").length;

  const perStall = new Map<string, { revenue: number; orders: number; slaViolations: number; noShows: number }>();
  const perBlock = new Map<string, { revenue: number; orders: number }>();
  const hourCounts = new Map<number, number>();
  for (const o of orders) {
    const stall = stallById.get(o.stallId);
    const s = perStall.get(o.stallId) ?? { revenue: 0, orders: 0, slaViolations: 0, noShows: 0 };
    s.orders += 1;
    if (o.status !== "cancelled" && o.status !== "rejected") s.revenue += Number(o.totalAmount);
    if (o.slaViolation) s.slaViolations += 1;
    if (o.noShow) s.noShows += 1;
    perStall.set(o.stallId, s);

    if (stall) {
      const b = perBlock.get(stall.block) ?? { revenue: 0, orders: 0 };
      b.orders += 1;
      if (o.status !== "cancelled" && o.status !== "rejected") b.revenue += Number(o.totalAmount);
      perBlock.set(stall.block, b);
    }
    if (o.status !== "cancelled" && o.status !== "rejected") {
      hourCounts.set(o.placedAt.getUTCHours(), (hourCounts.get(o.placedAt.getUTCHours()) ?? 0) + 1);
    }
  }

  const stallComparison = [...perStall.entries()].map(([stallId, v]) => ({
    stallId,
    name: stallById.get(stallId)?.name ?? "Unknown stall",
    block: stallById.get(stallId)?.block ?? "",
    ...v,
    rating: ratingRankings.find((r) => r.stallId === stallId)?.average ?? null,
  }));

  const highestSlaViolationStalls = [...stallComparison].sort((a, b) => b.slaViolations - a.slaViolations).slice(0, 10);
  const lowestRatedStalls = [...ratingRankings].sort((a, b) => a.average - b.average).slice(0, 10);
  const mostPopularBlocks = [...perBlock.entries()]
    .map(([block, v]) => ({ block, ...v }))
    .sort((a, b) => b.revenue - a.revenue);
  const peakCampusHours = [...hourCounts.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    range: { period: range.period, since: range.since.toISOString(), until: range.until.toISOString() },
    campusRevenue,
    campusOrders,
    activeStalls,
    stallRankingsByRating: ratingRankings,
    lowestRatedStalls,
    highestSlaViolationStalls,
    peakCampusHours,
    mostPopularBlocks,
    revenueTrend: dayBucketsInRange(billableOrders),
    campusRatingTrend,
    offerPerformance,
    stallComparison,
  };
}

/** Shapes getOwnerAnalytics' output for CSV/Excel/PDF export — no new calculation, just a display-friendly reshape. */
export function toOwnerReport(data: Awaited<ReturnType<typeof getOwnerAnalytics>>): AnalyticsReport {
  return {
    title: `${data.stall.name} — Analytics (${data.range.period})`,
    summary: {
      Revenue: data.revenue,
      "Total Orders": data.totalOrders,
      "Avg Order Value": data.avgOrderValue,
      "New Customers": data.newCustomers,
      "Returning Customers": data.returningCustomers,
      "Repeat Customer Rate %": data.repeatCustomerRatePct,
      "Avg Prep Time (min)": data.avgPrepMinutes ?? "—",
      "Cancellation Rate %": data.cancellationRatePct,
      "No-Show Rate %": data.noShowRatePct,
      "Avg Rating": data.rating.average ?? "—",
      "Total Ratings": data.rating.count,
      "Revenue From Offers": data.offers.revenueGeneratedByOffers,
      "Discount Given": data.offers.discountGiven,
    },
    tables: [
      { title: "Best Selling Items", rows: data.bestSellingItems },
      { title: "Worst Selling Items", rows: data.worstSellingItems },
      { title: "Category Performance", rows: data.categoryPerformance },
      { title: "Peak Hours (UTC hour)", rows: data.peakHours },
      { title: "Revenue Trend", rows: data.revenueTrend },
      { title: "Rating Trend", rows: data.ratingTrend },
      { title: "Offer Performance", rows: data.offers.performance },
    ],
  };
}

/** Shapes getAdminAnalytics' output for CSV/Excel/PDF export. */
export function toAdminReport(data: Awaited<ReturnType<typeof getAdminAnalytics>>): AnalyticsReport {
  return {
    title: `Campus Analytics (${data.range.period})`,
    summary: {
      "Campus Revenue": data.campusRevenue,
      "Campus Orders": data.campusOrders,
      "Active Stalls": data.activeStalls,
    },
    tables: [
      { title: "Stall Rankings (by rating)", rows: data.stallRankingsByRating },
      { title: "Lowest Rated Stalls", rows: data.lowestRatedStalls },
      { title: "Highest SLA Violations", rows: data.highestSlaViolationStalls },
      { title: "Peak Campus Hours (UTC hour)", rows: data.peakCampusHours },
      { title: "Most Popular Blocks", rows: data.mostPopularBlocks },
      { title: "Revenue Trend", rows: data.revenueTrend },
      { title: "Campus Rating Trend", rows: data.campusRatingTrend },
      { title: "Offer Performance", rows: data.offerPerformance },
      { title: "Stall Comparison", rows: data.stallComparison },
    ],
  };
}
