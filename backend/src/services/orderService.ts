import { randomInt } from "crypto";
import { prisma } from "../lib/prisma";
import { OrderStatus, Prisma } from "@prisma/client";
import { sendWhatsAppText } from "../whatsapp/client";
import { recomputeStudentPreferences } from "./preferenceService";

export class OrderError extends Error {}

// Order SLA & Accountability constants. Both are minutes, both fixed app-wide
// except the pickup grace period, which a stall can override (see Stall.pickupGraceMinutes).
export const ACCEPT_DEADLINE_MINUTES = 10;
export const DEFAULT_PICKUP_GRACE_MINUTES = 10;

// Customer-facing order number — random and unrelated to id/placedAt/count
// on purpose, so it never reveals order sequence, daily volume, or timing.
// 8 chars from a 36-symbol alphabet is ~2.8 trillion combinations, so a
// collision is not worth defensive retry logic at this app's scale.
const DISPLAY_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DISPLAY_ID_LENGTH = 8;

function generateDisplayId(): string {
  let code = "";
  for (let i = 0; i < DISPLAY_ID_LENGTH; i++) {
    code += DISPLAY_ID_CHARS[randomInt(DISPLAY_ID_CHARS.length)];
  }
  return `ORD-${code}`;
}

// WhatsApp renders *text* as bold — used here for a consistent, clean header
// line instead of a wall of casual emoji, per feedback that the old copy
// ("has been accepted ✅ We'll let you know...") read unpolished.
const STATUS_LINES: Partial<Record<OrderStatus, string>> = {
  accepted: "Accepted — we'll prepare it shortly.",
  rejected: "Not accepted this time. Your pickup slot has been released.",
  preparing: "Being prepared now.",
  ready: "Ready for pickup!",
};

/** Formats a Prisma @db.Time value as "9:00 AM" in IST — the production server runs in UTC. */
function formatSlotTime(t: Date): string {
  return new Date(t).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Awaited by the caller so any follow-up message (e.g. slaMonitor's
 * alternative-stall suggestion after an auto-reject) is guaranteed to be
 * sent after this one — but errors are swallowed internally so a
 * notification failure never fails the status transition itself.
 *
 * Includes the full order detail (items, total, pickup time), not just a
 * one-line status phrase — a student can easily have more than one order
 * in flight, and updates for different orders land in the same WhatsApp
 * thread with no way to separate them; the content itself has to make it
 * obvious which order a given push is about.
 */
async function notifyStudentOfStatus(order: { id: string; studentId: string; status: OrderStatus }): Promise<void> {
  const line = STATUS_LINES[order.status];
  if (!line) return;
  try {
    const full = await prisma.order.findUnique({
      where: { id: order.id },
      include: { items: true, pickupSlot: true, stall: true, student: true },
    });
    if (!full) return;
    const items = full.items.map((i) => `${i.quantity}x ${i.itemNameSnapshot}`).join(", ");
    const pickupTime = `${formatSlotTime(full.pickupSlot.startTime)} – ${formatSlotTime(full.pickupSlot.endTime)}`;
    const text = `*Order Update* — ${full.stall.name} (#${full.displayId})\n${items}\nTotal: ₹${Number(full.totalAmount)}\nPickup: ${pickupTime}\n${line}`;
    await sendWhatsAppText(full.student.whatsappNumber, text);
  } catch (err) {
    console.error("Failed to send order status WhatsApp notification:", err);
  }
}

const CANCELLABLE_STATUSES: OrderStatus[] = ["placed", "accepted"];

interface CartLine {
  menuItemId: string;
  variantId?: string;
  quantity: number;
}

/**
 * Books a pickup slot and creates the order atomically: the slot's booked_count
 * is only incremented if capacity remains, in the same transaction that creates
 * the order — this is what prevents overbooking under concurrent rush-hour orders.
 */
export async function placeOrder(params: {
  studentId: string;
  stallId: string;
  pickupSlotId: string;
  lines: CartLine[];
}) {
  const { studentId, stallId, pickupSlotId, lines } = params;
  if (lines.length === 0) throw new OrderError("Cannot place an empty order.");

  return prisma.$transaction(async (tx) => {
    const slot = await tx.pickupSlot.findUnique({ where: { id: pickupSlotId } });
    if (!slot || slot.stallId !== stallId) {
      throw new OrderError("That pickup slot no longer exists for this stall.");
    }

    const updatedSlot = await tx.pickupSlot.updateMany({
      where: { id: pickupSlotId, bookedCount: { lt: slot.maxCapacity } },
      data: { bookedCount: { increment: 1 } },
    });
    if (updatedSlot.count === 0) {
      throw new OrderError("That pickup slot just filled up. Please pick another time.");
    }

    const menuItemIds = lines.map((l) => l.menuItemId);
    const items = await tx.menuItem.findMany({
      where: { id: { in: menuItemIds }, stallId },
      include: { variants: true },
    });
    const itemsById = new Map(items.map((i) => [i.id, i]));

    let totalAmount = 0;
    const orderItemsData = lines.map((line) => {
      const item = itemsById.get(line.menuItemId);
      if (!item || !item.available) {
        throw new OrderError(`One of the items in your cart is no longer available.`);
      }
      let unitPrice = Number(item.basePrice);
      if (line.variantId) {
        const variant = item.variants.find((v) => v.id === line.variantId && v.available);
        if (!variant) throw new OrderError(`Selected variant for ${item.name} is unavailable.`);
        unitPrice = Number(variant.price);
      }
      totalAmount += unitPrice * line.quantity;
      return {
        menuItemId: item.id,
        variantId: line.variantId ?? null,
        quantity: line.quantity,
        unitPrice,
        itemNameSnapshot: item.name,
      };
    });

    const order = await tx.order.create({
      data: {
        studentId,
        stallId,
        pickupSlotId,
        totalAmount,
        displayId: generateDisplayId(),
        acceptDeadline: new Date(Date.now() + ACCEPT_DEADLINE_MINUTES * 60_000),
        items: { create: orderItemsData },
      },
      include: { items: true, pickupSlot: true },
    });

    return order;
  });
}

/**
 * `orderIdentifier` accepts either the internal id (button-tap paths, which
 * already have the real row id) or the customer-facing displayId (the AI
 * tool-calling path, which never sees anything but displayId).
 */
export async function cancelOrder(orderIdentifier: string, studentId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { OR: [{ id: orderIdentifier }, { displayId: orderIdentifier }] },
    });
    if (!order || order.studentId !== studentId) {
      throw new OrderError("Order not found.");
    }
    if (!CANCELLABLE_STATUSES.includes(order.status)) {
      throw new OrderError(
        "This order can no longer be cancelled — the stall has already started preparing it.",
      );
    }
    await tx.pickupSlot.update({
      where: { id: order.pickupSlotId },
      data: { bookedCount: { decrement: 1 } },
    });
    return tx.order.update({
      where: { id: order.id },
      data: { status: "cancelled", cancelledReason: "Cancelled by student" },
    });
  });
}

/** Stall-owner-side transitions: placed→accepted/rejected, accepted→preparing→ready→completed. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "rejected"],
  accepted: ["preparing"],
  preparing: ["ready"],
  ready: ["completed"],
  rejected: [],
  cancelled: [],
  completed: [],
};

/**
 * `opts.auto` marks a system-initiated auto-reject (unanswered past the
 * accept deadline) — kept distinct from an owner's own reject so it's never
 * counted against the owner. `opts.noShow` marks a system-initiated closure
 * of a ready order nobody collected in time — also never counted against
 * the owner.
 */
export async function transitionOrderStatus(
  orderId: string,
  stallId: string,
  nextStatus: OrderStatus,
  opts: { auto?: boolean; noShow?: boolean } = {},
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { pickupSlot: true } });
    if (!order || order.stallId !== stallId) throw new OrderError("Order not found.");
    if (!ALLOWED_TRANSITIONS[order.status].includes(nextStatus)) {
      throw new OrderError(`Cannot move order from ${order.status} to ${nextStatus}.`);
    }
    if (nextStatus === "rejected" || nextStatus === "cancelled") {
      await tx.pickupSlot.update({
        where: { id: order.pickupSlotId },
        data: { bookedCount: { decrement: 1 } },
      });
    }

    const now = new Date();
    const data: Prisma.OrderUpdateInput = { status: nextStatus };
    if (nextStatus === "accepted") {
      data.acceptedAt = now;
    }
    if (nextStatus === "ready") {
      data.readyAt = now;
      // Owner's SLA commitment is "ready before the pickup slot ends" —
      // flag it right here if that's already blown, no need to wait for
      // the background sweep to catch it.
      const slotEnd = slotEndInstant(order.pickupSlot.slotDate, order.pickupSlot.endTime);
      if (now > slotEnd) {
        data.slaViolation = true;
        data.slaViolationMinutes = Math.ceil((now.getTime() - slotEnd.getTime()) / 60_000);
      }
    }
    if (nextStatus === "rejected" && opts.auto) {
      data.autoRejected = true;
      data.cancelledReason = `Auto-rejected — stall did not respond within ${ACCEPT_DEADLINE_MINUTES} minutes.`;
    }
    if (nextStatus === "completed" && opts.noShow) {
      data.noShow = true;
      data.noShowAt = now;
    }

    return tx.order.update({ where: { id: orderId }, data });
  }).then(async (order) => {
    await notifyStudentOfStatus(order);
    // Learned preferences (favorite stall/meal-period/usual order) are only
    // ever built from orders the student actually collected — a no-show
    // shouldn't shape future "usual order" suggestions.
    if (order.status === "completed" && !order.noShow) {
      recomputeStudentPreferences(order.studentId).catch((err) =>
        console.error("Failed to recompute student preferences:", err),
      );
    }
    return order;
  });
}

// How long an order stays "trackable" after its pickup window ends, before
// it stops showing up in student-facing status checks even if the stall
// never advanced its status — otherwise a stall that forgets to update an
// order leaves it showing as "active" indefinitely, days later.
const POST_PICKUP_GRACE_MINUTES = 15;

/** slotDate (DATE) and endTime (TIME) are stored separately — reassemble the actual instant the slot ends at. */
export function slotEndInstant(slotDate: Date, endTime: Date): Date {
  const d = new Date(slotDate);
  d.setUTCHours(endTime.getUTCHours(), endTime.getUTCMinutes(), endTime.getUTCSeconds(), 0);
  return d;
}

/**
 * "Active" orders for student-facing status checks — excludes ones whose
 * pickup window (plus a short grace period) has already passed, even if the
 * stall never advanced their status past "placed". A day-level cutoff isn't
 * enough here: a 2:30 PM slot should stop showing up well before midnight,
 * not just once the calendar day changes.
 */
export async function getActiveOrdersForStudent(studentId: string) {
  const orders = await prisma.order.findMany({
    where: { studentId, status: { notIn: ["completed", "cancelled", "rejected"] } },
    include: { items: true, pickupSlot: true, stall: true },
    orderBy: { placedAt: "desc" },
  });
  const now = new Date();
  return orders.filter((o) => {
    const expiresAt = new Date(
      slotEndInstant(o.pickupSlot.slotDate, o.pickupSlot.endTime).getTime() + POST_PICKUP_GRACE_MINUTES * 60_000,
    );
    return expiresAt > now;
  });
}

/** Full order history (any status), most recent first — powers "show my past orders" and "repeat my last order". */
export async function getOrderHistoryForStudent(studentId: string, limit = 10) {
  return prisma.order.findMany({
    where: { studentId },
    include: { items: true, stall: true },
    orderBy: { placedAt: "desc" },
    take: limit,
  });
}

export async function getOrderQueueForStall(stallId: string) {
  return prisma.order.findMany({
    where: { stallId, status: { notIn: ["completed", "cancelled", "rejected"] } },
    include: { items: true, pickupSlot: true, student: true },
    orderBy: { placedAt: "asc" },
  });
}

/** Today's completed orders for a stall — powers the collapsed "Completed today" queue section. */
export async function getCompletedOrdersToday(stallId: string) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return prisma.order.findMany({
    where: { stallId, status: "completed", updatedAt: { gte: todayStart } },
    include: { items: true, pickupSlot: true, student: true },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * Order SLA & Accountability stats for a stall's Owner Dashboard — defaults
 * to today (UTC calendar day, matching how pickup slots are day-bucketed
 * elsewhere), computed on the fly from the Order rows rather than a
 * separate running-aggregate table, same approach as analyticsService.ts.
 */
export async function getSlaMetricsForStall(stallId: string, opts: { since?: Date } = {}) {
  const since =
    opts.since ??
    (() => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    })();

  const orders = await prisma.order.findMany({
    where: { stallId, placedAt: { gte: since } },
    include: { pickupSlot: true },
  });

  const accepted = orders.filter((o) => o.acceptedAt);
  const avgAcceptanceSeconds = accepted.length
    ? Math.round(
        accepted.reduce((sum, o) => sum + (o.acceptedAt!.getTime() - o.placedAt.getTime()), 0) /
          accepted.length /
          1000,
      )
    : null;

  const missedAcceptanceDeadlines = orders.filter((o) => o.autoRejected).length;
  const slaViolations = orders.filter((o) => o.slaViolation).length;

  const readyOrders = orders.filter((o) => o.readyAt);
  const onTimeReady = readyOrders.filter(
    (o) => o.readyAt!.getTime() <= slotEndInstant(o.pickupSlot.slotDate, o.pickupSlot.endTime).getTime(),
  );
  const onTimePreparationRate = readyOrders.length
    ? Math.round((onTimeReady.length / readyOrders.length) * 100)
    : null;

  const customerNoShows = orders.filter((o) => o.noShow).length;

  return {
    since: since.toISOString(),
    totalOrders: orders.length,
    avgAcceptanceSeconds,
    missedAcceptanceDeadlines,
    slaViolations,
    onTimePreparationRate,
    customerNoShows,
  };
}
