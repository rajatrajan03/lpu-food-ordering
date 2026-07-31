import { prisma } from "../lib/prisma";
import { OrderStatus } from "@prisma/client";

export class OrderError extends Error {}

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
        items: { create: orderItemsData },
      },
      include: { items: true, pickupSlot: true },
    });

    return order;
  });
}

export async function cancelOrder(orderId: string, studentId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
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
      where: { id: orderId },
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

export async function transitionOrderStatus(
  orderId: string,
  stallId: string,
  nextStatus: OrderStatus,
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
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
    return tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
  });
}

export async function getActiveOrdersForStudent(studentId: string) {
  return prisma.order.findMany({
    where: { studentId, status: { notIn: ["completed", "cancelled", "rejected"] } },
    include: { items: true, pickupSlot: true, stall: true },
    orderBy: { placedAt: "desc" },
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
