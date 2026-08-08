import { prisma } from "../lib/prisma";
import { genAI, GEMINI_MODEL } from "../ai/geminiClient";
import { getSlaMetricsForStall, getCompletedOrdersToday } from "./orderService";
import { getStallRatingDetail, getStallRankings } from "./ratingService";
import { getOfferAnalytics, getCampusOfferAnalytics } from "./offerService";
import { getOverview, getStallInsights } from "./analyticsService";

export class BusinessAssistantError extends Error {}

const OWNER_SYSTEM_PROMPT = `You are a business analyst assistant for a single food stall on a campus food-ordering platform.
You are given a JSON snapshot of ONLY this stall's own data (today's orders, SLA performance, ratings, and active offers) — never any other stall's data.
Answer the owner's question using ONLY the data provided. Never invent numbers.
Be concise and business-focused: 3-6 short lines or bullet points. Always include a concrete, actionable recommendation, not just a restatement of the numbers.
If the data doesn't contain enough to answer confidently, say so plainly instead of guessing.`;

const ADMIN_SYSTEM_PROMPT = `You are a business analyst assistant for a Super Admin overseeing an entire campus food-ordering platform.
You are given a JSON snapshot of campus-wide data (per-stall orders/revenue, ratings, SLA-style insights, and offer performance) — this is aggregate/summary data only, never individual student information.
Answer the admin's question using ONLY the data provided. Never invent numbers or stall names not present in the data.
Be concise and business-focused: 3-6 short lines or bullet points, with concrete recommendations (e.g. which stall needs attention and why) where relevant.
If the data doesn't contain enough to answer confidently, say so plainly instead of guessing.`;

async function gatherStallContext(stallId: string) {
  const [stall, completedToday, sla, ratingDetail, offers] = await Promise.all([
    prisma.stall.findUnique({ where: { id: stallId }, select: { name: true, block: true, status: true } }),
    getCompletedOrdersToday(stallId),
    getSlaMetricsForStall(stallId),
    getStallRatingDetail(stallId),
    getOfferAnalytics(stallId),
  ]);
  if (!stall) throw new BusinessAssistantError("Stall not found.");

  const itemCounts = new Map<string, number>();
  for (const o of completedToday) {
    for (const i of o.items) {
      itemCounts.set(i.itemNameSnapshot, (itemCounts.get(i.itemNameSnapshot) ?? 0) + i.quantity);
    }
  }
  const itemSales = [...itemCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty }));

  const hourCounts = new Map<number, number>();
  for (const o of completedToday) {
    const h = new Date(o.placedAt).getHours();
    hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
  }
  const busiestHours = [...hourCounts.entries()].sort((a, b) => b[1] - a[1]).map(([hour, count]) => ({ hour, count }));

  return {
    stall: { name: stall.name, block: stall.block, status: stall.status },
    ordersCompletedToday: completedToday.length,
    revenueToday: completedToday.reduce((s, o) => s + Number(o.totalAmount), 0),
    itemSalesToday: itemSales,
    busiestHoursToday: busiestHours,
    sla,
    ratings: ratingDetail,
    offers,
  };
}

async function gatherCampusContext() {
  const [overview, insights, rankings, offerAnalytics] = await Promise.all([
    getOverview(),
    getStallInsights(),
    getStallRankings(),
    getCampusOfferAnalytics(),
  ]);
  const stalls = await prisma.stall.findMany({ select: { id: true, name: true, block: true, status: true, nightOpen: true } });
  const perStall = stalls.map((s) => ({
    name: s.name,
    block: s.block,
    status: s.status,
    nightOpen: s.nightOpen,
    ...insights[s.id],
  }));

  return { overview, perStall, ratingRankings: rankings, offerPerformance: offerAnalytics };
}

async function askGemini(systemPrompt: string, question: string, context: unknown): Promise<string> {
  const prompt = `Data snapshot:\n${JSON.stringify(context)}\n\nQuestion: ${question}`;
  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction: systemPrompt },
  });
  return response.text ?? "I couldn't generate an answer from the current data — please try again.";
}

export async function askOwnerAssistant(stallId: string, question: string): Promise<string> {
  const context = await gatherStallContext(stallId);
  return askGemini(OWNER_SYSTEM_PROMPT, question, context);
}

export async function askAdminAssistant(question: string): Promise<string> {
  const context = await gatherCampusContext();
  return askGemini(ADMIN_SYSTEM_PROMPT, question, context);
}
