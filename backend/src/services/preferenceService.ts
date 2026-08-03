import { prisma } from "../lib/prisma";
import type { MealPeriod } from "@prisma/client";

export interface UsualOrderItem {
  itemName: string;
  quantity: number;
}

export interface FavoriteItem {
  itemName: string;
  count: number;
}

/** Same IST-offset approach as menuService's night-time check — no separate timezone dependency. */
function istMinutesOfDay(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + 330) % 1440;
}

export function classifyMealPeriod(date: Date): MealPeriod {
  const minutes = istMinutesOfDay(date);
  const hour = minutes / 60;
  if (hour >= 6 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 19) return "snacks";
  return "dinner"; // 19:00–23:59 and the 00:00–05:59 late-night tail
}

export function currentMealPeriod(): MealPeriod {
  return classifyMealPeriod(new Date());
}

/**
 * Rebuilds a student's preference row from scratch using every completed
 * order — cheap enough to run per-completion (a student's order history is
 * small) and avoids any incremental-update drift bugs. Call after any order
 * transitions to "completed".
 */
export async function recomputeStudentPreferences(studentId: string): Promise<void> {
  const orders = await prisma.order.findMany({
    where: { studentId, status: "completed" },
    include: { items: true, pickupSlot: true, stall: true },
    orderBy: { placedAt: "desc" },
  });

  if (orders.length === 0) {
    await prisma.studentPreference.deleteMany({ where: { studentId } });
    return;
  }

  // Favorite stall: most completed orders, ties broken by most recent.
  const stallCounts = new Map<string, number>();
  for (const o of orders) stallCounts.set(o.stallId, (stallCounts.get(o.stallId) ?? 0) + 1);
  const favoriteStallId = [...stallCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const favoriteStall = orders.find((o) => o.stallId === favoriteStallId)!.stall;

  // Favorite meal period: bucket each order's pickup start time.
  const periodCounts = new Map<MealPeriod, number>();
  for (const o of orders) {
    const period = classifyMealPeriod(o.pickupSlot.startTime);
    periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
  }
  const favoriteMealPeriod = [...periodCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Favorite items: total quantity ordered, across all orders.
  const itemCounts = new Map<string, number>();
  for (const o of orders) {
    for (const line of o.items) {
      itemCounts.set(line.itemNameSnapshot, (itemCounts.get(line.itemNameSnapshot) ?? 0) + line.quantity);
    }
  }
  const favoriteItems: FavoriteItem[] = [...itemCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([itemName, count]) => ({ itemName, count }));

  // "Usual order": the most frequently repeated exact combination (by item
  // name + quantity) across orders; falls back to the most recent order's
  // items when nothing repeats (new-ish students with varied history).
  const signatureCounts = new Map<string, { count: number; items: UsualOrderItem[] }>();
  for (const o of orders) {
    const items: UsualOrderItem[] = o.items
      .map((l) => ({ itemName: l.itemNameSnapshot, quantity: l.quantity }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName));
    const signature = items.map((i) => `${i.itemName}:${i.quantity}`).join("|");
    const existing = signatureCounts.get(signature);
    if (existing) existing.count += 1;
    else signatureCounts.set(signature, { count: 1, items });
  }
  const bestSignature = [...signatureCounts.values()].sort((a, b) => b.count - a.count)[0];
  const usualOrderItems: UsualOrderItem[] =
    bestSignature.count > 1
      ? bestSignature.items
      : orders[0].items.map((l) => ({ itemName: l.itemNameSnapshot, quantity: l.quantity }));

  await prisma.studentPreference.upsert({
    where: { studentId },
    create: {
      studentId,
      favoriteStallId,
      favoriteMealPeriod,
      preferredArea: favoriteStall.area,
      preferredBlock: favoriteStall.block,
      usualOrderItems: usualOrderItems as unknown as object,
      favoriteItems: favoriteItems as unknown as object,
      ordersAnalyzed: orders.length,
    },
    update: {
      favoriteStallId,
      favoriteMealPeriod,
      preferredArea: favoriteStall.area,
      preferredBlock: favoriteStall.block,
      usualOrderItems: usualOrderItems as unknown as object,
      favoriteItems: favoriteItems as unknown as object,
      ordersAnalyzed: orders.length,
    },
  });
}

export async function getPreferences(studentId: string) {
  return prisma.studentPreference.findUnique({
    where: { studentId },
    include: { favoriteStall: true },
  });
}
