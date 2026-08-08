import { prisma } from "../lib/prisma";
import { genAI, GEMINI_MODEL } from "../ai/geminiClient";
import { getOwnerAnalytics, getAdminAnalytics, resolveDateRange } from "./advancedAnalyticsService";

export class ForecastError extends Error {}

// Below this many distinct order-days (or total orders) in the lookback
// window, a forecast would just be Gemini guessing — refuse rather than
// fabricate, per the explicit product requirement.
const MIN_ORDER_DAYS = 5;
const MIN_TOTAL_ORDERS = 10;
const LOOKBACK_DAYS = 30;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function tomorrowIstWeekday(): string {
  const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const tomorrow = new Date(nowIst.getTime() + 24 * 60 * 60_000);
  return WEEKDAY_NAMES[tomorrow.getDay()];
}

const OWNER_FORECAST_SCHEMA = {
  type: "object",
  properties: {
    expectedOrdersTomorrow: { type: "number" },
    expectedRevenueTomorrow: { type: "number" },
    expectedCustomerVolume: { type: "number" },
    peakHours: { type: "array", items: { type: "object", properties: { hourLabel: { type: "string" }, note: { type: "string" } }, required: ["hourLabel"] } },
    expectedOfferPerformance: { type: "string" },
    expectedSlaLoad: { type: "string" },
    predictedBestSellers: { type: "array", items: { type: "object", properties: { name: { type: "string" }, expectedQty: { type: "number" } }, required: ["name"] } },
    predictedWorstSellers: { type: "array", items: { type: "object", properties: { name: { type: "string" }, expectedQty: { type: "number" } }, required: ["name"] } },
    suggestedPrepQuantities: { type: "array", items: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item", "qty"] } },
    recommendedStockIncrease: { type: "array", items: { type: "object", properties: { item: { type: "string" }, reason: { type: "string" } }, required: ["item", "reason"] } },
    suggestedStaffing: { type: "string" },
    likelyToSellOut: { type: "array", items: { type: "string" } },
    overstocked: { type: "array", items: { type: "string" } },
    recommendedOffersForTomorrow: { type: "array", items: { type: "object", properties: { name: { type: "string" }, reason: { type: "string" } }, required: ["name", "reason"] } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
  },
  required: [
    "expectedOrdersTomorrow",
    "expectedRevenueTomorrow",
    "expectedCustomerVolume",
    "peakHours",
    "predictedBestSellers",
    "predictedWorstSellers",
    "confidence",
    "summary",
  ],
};

const ADMIN_FORECAST_SCHEMA = {
  type: "object",
  properties: {
    expectedCampusOrdersTomorrow: { type: "number" },
    expectedCampusRevenueTomorrow: { type: "number" },
    busiestBlocks: { type: "array", items: { type: "object", properties: { block: { type: "string" }, note: { type: "string" } }, required: ["block"] } },
    highestDemandStalls: { type: "array", items: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
    expectedPeakHours: { type: "array", items: { type: "object", properties: { hourLabel: { type: "string" }, note: { type: "string" } }, required: ["hourLabel"] } },
    campusTrends: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    summary: { type: "string" },
  },
  required: ["expectedCampusOrdersTomorrow", "expectedCampusRevenueTomorrow", "busiestBlocks", "highestDemandStalls", "confidence", "summary"],
};

const FORECAST_RULES = `You are a demand-forecasting assistant. You are given ONLY a JSON snapshot of real historical business data — never invent numbers, item names, stall names, or trends not present in the data. Base every prediction strictly on the patterns in the data (recent trend, day-of-week pattern for the target day, recent best/worst sellers). Give concrete, actionable numbers where the schema asks for them. If the data is thin for a specific field (e.g. no offers redeemed), say so plainly in that field rather than guessing. Respond ONLY with JSON matching the provided schema.`;

interface InsufficientData {
  sufficient: false;
  reason: string;
}

async function ownerHistorySnapshot(stallId: string) {
  const range = resolveDateRange("month");
  const [analytics, dayOfWeekOrders] = await Promise.all([
    getOwnerAnalytics(stallId, range),
    prisma.order.findMany({
      where: { stallId, placedAt: { gte: range.since, lt: range.until }, status: { not: "cancelled" } },
      select: { placedAt: true, totalAmount: true },
    }),
  ]);

  const byWeekday = new Map<string, { orders: number; revenue: number }>();
  for (const o of dayOfWeekOrders) {
    const day = WEEKDAY_NAMES[o.placedAt.getUTCDay()];
    const bucket = byWeekday.get(day) ?? { orders: 0, revenue: 0 };
    bucket.orders += 1;
    bucket.revenue += Number(o.totalAmount);
    byWeekday.set(day, bucket);
  }

  const distinctOrderDays = new Set(dayOfWeekOrders.map((o) => o.placedAt.toISOString().slice(0, 10))).size;

  return {
    sufficient: distinctOrderDays >= MIN_ORDER_DAYS && dayOfWeekOrders.length >= MIN_TOTAL_ORDERS,
    distinctOrderDays,
    totalOrders: dayOfWeekOrders.length,
    targetWeekday: tomorrowIstWeekday(),
    weekdayPattern: Object.fromEntries(byWeekday),
    last30Days: {
      revenue: analytics.revenue,
      totalOrders: analytics.totalOrders,
      avgOrderValue: analytics.avgOrderValue,
      bestSellingItems: analytics.bestSellingItems,
      worstSellingItems: analytics.worstSellingItems,
      categoryPerformance: analytics.categoryPerformance,
      peakHours: analytics.peakHours,
      revenueTrend: analytics.revenueTrend,
      sla: analytics.sla,
      cancellationRatePct: analytics.cancellationRatePct,
      noShowRatePct: analytics.noShowRatePct,
      rating: analytics.rating,
      offers: analytics.offers,
    },
  };
}

export async function getOwnerForecast(stallId: string) {
  const stall = await prisma.stall.findUnique({ where: { id: stallId }, select: { name: true } });
  if (!stall) throw new ForecastError("Stall not found.");

  const snapshot = await ownerHistorySnapshot(stallId);
  if (!snapshot.sufficient) {
    return {
      sufficient: false as const,
      reason: `Not enough order history yet — ${snapshot.totalOrders} orders across ${snapshot.distinctOrderDays} day(s) in the last ${LOOKBACK_DAYS} days. Need at least ${MIN_TOTAL_ORDERS} orders across ${MIN_ORDER_DAYS} distinct days for a reliable forecast.`,
    };
  }

  const prompt = `Target day to forecast: tomorrow (${snapshot.targetWeekday}), for stall "${stall.name}".\n\nHistorical data snapshot:\n${JSON.stringify(snapshot)}`;
  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: FORECAST_RULES, responseMimeType: "application/json", responseSchema: OWNER_FORECAST_SCHEMA },
  });

  const parsed = JSON.parse(response.text ?? "{}");
  return { sufficient: true as const, generatedAt: new Date().toISOString(), basedOnDays: snapshot.distinctOrderDays, targetWeekday: snapshot.targetWeekday, ...parsed };
}

async function adminHistorySnapshot() {
  const range = resolveDateRange("month");
  const [analytics, orders] = await Promise.all([
    getAdminAnalytics(range),
    prisma.order.findMany({
      where: { placedAt: { gte: range.since, lt: range.until }, status: { not: "cancelled" } },
      select: { id: true, placedAt: true },
    }),
  ]);
  const distinctOrderDays = new Set(orders.map((o) => o.placedAt.toISOString().slice(0, 10))).size;

  return {
    sufficient: distinctOrderDays >= MIN_ORDER_DAYS && orders.length >= MIN_TOTAL_ORDERS,
    distinctOrderDays,
    totalOrders: orders.length,
    targetWeekday: tomorrowIstWeekday(),
    last30Days: {
      campusRevenue: analytics.campusRevenue,
      campusOrders: analytics.campusOrders,
      activeStalls: analytics.activeStalls,
      stallRankingsByRating: analytics.stallRankingsByRating,
      highestSlaViolationStalls: analytics.highestSlaViolationStalls,
      peakCampusHours: analytics.peakCampusHours,
      mostPopularBlocks: analytics.mostPopularBlocks,
      revenueTrend: analytics.revenueTrend,
      stallComparison: analytics.stallComparison,
    },
  };
}

export async function getAdminForecast() {
  const snapshot = await adminHistorySnapshot();
  if (!snapshot.sufficient) {
    return {
      sufficient: false as const,
      reason: `Not enough campus-wide order history yet — ${snapshot.totalOrders} orders across ${snapshot.distinctOrderDays} day(s) in the last ${LOOKBACK_DAYS} days. Need at least ${MIN_TOTAL_ORDERS} orders across ${MIN_ORDER_DAYS} distinct days for a reliable forecast.`,
    };
  }

  const prompt = `Target day to forecast: tomorrow (${snapshot.targetWeekday}), campus-wide across all stalls.\n\nHistorical data snapshot:\n${JSON.stringify(snapshot)}`;
  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: FORECAST_RULES, responseMimeType: "application/json", responseSchema: ADMIN_FORECAST_SCHEMA },
  });

  const parsed = JSON.parse(response.text ?? "{}");
  return { sufficient: true as const, generatedAt: new Date().toISOString(), basedOnDays: snapshot.distinctOrderDays, targetWeekday: snapshot.targetWeekday, ...parsed };
}

export type { InsufficientData };
