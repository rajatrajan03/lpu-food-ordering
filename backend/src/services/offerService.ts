import { prisma } from "../lib/prisma";
import { OfferType, Prisma } from "@prisma/client";

export class OfferError extends Error {}

/** Anything with the Prisma model delegates — either the module-level client or an active `tx` from prisma.$transaction. */
type PrismaClientLike = typeof prisma | Prisma.TransactionClient;

interface CartLineForOffer {
  menuItemId: string;
  categoryName?: string | null;
  unitPrice: number;
  quantity: number;
}

/**
 * Offers currently within their valid window and marked active — the only
 * ones eligible to be applied or shown to students. Accepts an optional
 * Prisma client so callers running inside their own `$transaction` (e.g.
 * orderService.placeOrder) can pass `tx` and reuse that transaction's
 * connection instead of opening a second one from the pool — under
 * concurrent load, every nested connection here previously doubled the
 * connections a single order placement needed, which exhausted the pool
 * far faster than expected (caught by tests/load/loadTest.ts).
 */
export async function getActiveOffersForStall(stallId: string, at: Date = new Date(), client: PrismaClientLike = prisma) {
  return client.offer.findMany({
    where: { stallId, active: true, validFrom: { lte: at }, validUntil: { gte: at } },
    orderBy: { createdAt: "desc" },
  });
}

/** Every offer for a stall (any status), for the owner's management screen. */
export async function listOffersForStall(stallId: string) {
  return prisma.offer.findMany({ where: { stallId }, orderBy: { createdAt: "desc" } });
}

const CREATE_FIELDS = [
  "name",
  "description",
  "type",
  "active",
  "validFrom",
  "validUntil",
  "minOrderValue",
  "maxDiscount",
  "discountPercent",
  "discountFlat",
  "buyQuantity",
  "getQuantity",
  "freeItemId",
  "happyHourStart",
  "happyHourEnd",
  "applicableItemIds",
  "applicableCategoryNames",
] as const;

type OfferInput = Partial<Record<(typeof CREATE_FIELDS)[number], unknown>>;

function pickFields(input: OfferInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CREATE_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

export async function createOffer(stallId: string, input: OfferInput) {
  const data = pickFields(input);
  if (!data.name || !data.type || !data.validFrom || !data.validUntil) {
    throw new OfferError("name, type, validFrom, and validUntil are required.");
  }
  return prisma.offer.create({ data: { ...data, stallId } as Prisma.OfferUncheckedCreateInput });
}

export async function updateOffer(offerId: string, stallId: string, input: OfferInput) {
  const data = pickFields(input);
  const result = await prisma.offer.updateMany({ where: { id: offerId, stallId }, data });
  if (result.count === 0) throw new OfferError("Offer not found.");
  return prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
}

export async function deleteOffer(offerId: string, stallId: string) {
  const result = await prisma.offer.deleteMany({ where: { id: offerId, stallId } });
  if (result.count === 0) throw new OfferError("Offer not found.");
}

export async function setOfferActive(offerId: string, stallId: string, active: boolean) {
  const result = await prisma.offer.updateMany({ where: { id: offerId, stallId }, data: { active } });
  if (result.count === 0) throw new OfferError("Offer not found.");
  return prisma.offer.findUniqueOrThrow({ where: { id: offerId } });
}

/** Admin-only — no stallId ownership check, used to enable/disable any campus offer. */
export async function adminSetOfferActive(offerId: string, active: boolean) {
  return prisma.offer.update({ where: { id: offerId }, data: { active } });
}

function isWithinHappyHour(offer: { happyHourStart: string | null; happyHourEnd: string | null }, at: Date): boolean {
  if (!offer.happyHourStart || !offer.happyHourEnd) return true;
  const ist = new Date(at.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  const [sh, sm] = offer.happyHourStart.split(":").map(Number);
  const [eh, em] = offer.happyHourEnd.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

/** Which cart lines an offer's item/category scoping applies to — empty scoping arrays mean "the whole cart". */
function applicableLines(offer: { applicableItemIds: string[]; applicableCategoryNames: string[] }, lines: CartLineForOffer[]): CartLineForOffer[] {
  if (offer.applicableItemIds.length === 0 && offer.applicableCategoryNames.length === 0) return lines;
  return lines.filter(
    (l) =>
      offer.applicableItemIds.includes(l.menuItemId) ||
      (l.categoryName && offer.applicableCategoryNames.includes(l.categoryName)),
  );
}

export interface OfferApplication {
  offerId: string;
  offerName: string;
  discountAmount: number;
  explanation: string;
}

/**
 * Evaluates every active offer for a stall against the given cart and
 * returns the single most beneficial one (highest discount), or null if
 * none apply. Never applies an expired/inactive offer — getActiveOffersForStall
 * already filters those out before anything here runs.
 */
export async function computeBestOffer(
  stallId: string,
  lines: CartLineForOffer[],
  at: Date = new Date(),
  client: PrismaClientLike = prisma,
): Promise<OfferApplication | null> {
  const cartTotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const offers = await getActiveOffersForStall(stallId, at, client);

  let best: OfferApplication | null = null;
  for (const offer of offers) {
    if (offer.minOrderValue != null && cartTotal < Number(offer.minOrderValue)) continue;
    if (offer.type === "happy_hour" && !isWithinHappyHour(offer, at)) continue;

    const scoped = applicableLines(offer, lines);
    if (scoped.length === 0 && (offer.applicableItemIds.length > 0 || offer.applicableCategoryNames.length > 0)) continue;
    const scopedTotal = scoped.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

    let discount = 0;
    let explanation = "";

    switch (offer.type as OfferType) {
      case "percentage_discount":
      case "combo":
      case "festival":
      case "happy_hour": {
        if (offer.discountPercent == null) continue;
        discount = (scopedTotal * offer.discountPercent) / 100;
        explanation = `${offer.discountPercent}% off`;
        break;
      }
      case "flat_discount":
      case "min_order_value": {
        if (offer.discountFlat == null) continue;
        discount = Number(offer.discountFlat);
        explanation = `₹${discount} off`;
        break;
      }
      case "buy_x_get_y": {
        if (!offer.buyQuantity || !offer.getQuantity || scoped.length === 0) continue;
        const totalQty = scoped.reduce((sum, l) => sum + l.quantity, 0);
        if (totalQty < offer.buyQuantity) continue;
        const cheapest = Math.min(...scoped.map((l) => l.unitPrice));
        discount = cheapest * offer.getQuantity;
        explanation = `Buy ${offer.buyQuantity} get ${offer.getQuantity} free`;
        break;
      }
      case "free_item": {
        if (!offer.freeItemId) continue;
        const freeItem = await client.menuItem.findUnique({ where: { id: offer.freeItemId } });
        if (!freeItem) continue;
        discount = Number(freeItem.basePrice);
        explanation = `Free ${freeItem.name}`;
        break;
      }
    }

    if (offer.maxDiscount != null) discount = Math.min(discount, Number(offer.maxDiscount));
    discount = Math.min(discount, cartTotal);
    if (discount <= 0) continue;

    if (!best || discount > best.discountAmount) {
      best = { offerId: offer.id, offerName: offer.name, discountAmount: Math.round(discount * 100) / 100, explanation };
    }
  }
  return best;
}

/** Owner-facing usage stats — computed on the fly via aggregation, no denormalized counters (same convention as ratingService). */
export async function getOfferAnalytics(stallId: string) {
  const offers = await prisma.offer.findMany({ where: { stallId } });
  const redemptions = await prisma.offerRedemption.groupBy({
    by: ["offerId"],
    where: { offer: { stallId } },
    _count: true,
    _sum: { discountAmount: true },
  });
  const byOfferId = new Map(redemptions.map((r) => [r.offerId, r]));
  const now = new Date();
  return offers.map((o) => {
    const r = byOfferId.get(o.id);
    const status = !o.active ? "inactive" : o.validFrom > now ? "scheduled" : o.validUntil < now ? "expired" : "active";
    return {
      id: o.id,
      name: o.name,
      type: o.type,
      status,
      usageCount: r?._count ?? 0,
      totalDiscountGiven: Number(r?._sum.discountAmount ?? 0),
    };
  });
}

/** Campus-wide offer analytics for the Admin Dashboard. */
export async function getCampusOfferAnalytics() {
  const offers = await prisma.offer.findMany({ include: { stall: { select: { name: true, block: true } } } });
  const redemptions = await prisma.offerRedemption.groupBy({ by: ["offerId"], _count: true, _sum: { discountAmount: true } });
  const byOfferId = new Map(redemptions.map((r) => [r.offerId, r]));
  const now = new Date();
  return offers
    .map((o) => {
      const r = byOfferId.get(o.id);
      const status = !o.active ? "inactive" : o.validFrom > now ? "scheduled" : o.validUntil < now ? "expired" : "active";
      return {
        id: o.id,
        name: o.name,
        type: o.type,
        stallName: o.stall.name,
        stallBlock: o.stall.block,
        active: o.active,
        status,
        usageCount: r?._count ?? 0,
        totalDiscountGiven: Number(r?._sum.discountAmount ?? 0),
      };
    })
    .sort((a, b) => b.usageCount - a.usageCount);
}
