import { prisma } from "../lib/prisma";
import { sendWhatsAppList, type ListRow } from "../whatsapp/client";
import * as menuService from "./menuService";
import { transitionOrderStatus, slotEndInstant, DEFAULT_PICKUP_GRACE_MINUTES } from "./orderService";
import { getSessionState } from "../ai/conversationEngine";
import { rememberNames } from "../ai/tools";

// ---------------------------------------------------------------------------
// Order SLA & Accountability — a lightweight in-process sweep (setInterval),
// not a new piece of infrastructure. Consistent with this app's existing
// single-Node-process Render deployment; if it ever runs on multiple
// instances this would need a distributed lock, but that's not the current
// architecture and adding one now would be solving a problem that doesn't
// exist yet.
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Best-effort "here's what else is nearby" follow-up after an auto-reject —
 * never blocks the reject itself. Sends a real tappable stall list (same id
 * scheme as the Browse Stalls flow, `stall:<id>`) and primes the student's
 * browseFlow to the same "stall_list" screen they'd be on had they picked
 * this area from Browse Stalls — so tapping one continues straight into the
 * normal category -> item -> cart flow instead of dead-ending as a suggestion.
 */
async function suggestAlternativeStalls(studentId: string, originalStallId: string, area: string | null): Promise<void> {
  if (!area) return;
  try {
    const nearby = await menuService.listStalls({ area, limit: 4 });
    const options = nearby.filter((s) => s.id !== originalStallId).slice(0, 3);
    if (options.length === 0) return;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) return;

    const rows: ListRow[] = options.map((s) => ({
      id: `stall:${s.id}`,
      title: s.name.slice(0, 24),
      description: s.block ?? undefined,
    }));
    await sendWhatsAppList(student.whatsappNumber, `Other stalls near ${area}:`, "Choose stall", rows);

    const session = getSessionState(student.sessionState);
    session.knownStalls = rememberNames(session.knownStalls, options.map((s) => [s.name, s.id]));
    session.browseFlow = {
      current: { screen: "stall_list", area },
      stack: [{ screen: "location_list" }],
    };
    await prisma.student.update({ where: { id: studentId }, data: { sessionState: session as unknown as object } });
  } catch (err) {
    console.error("SLA sweep: failed to suggest alternative stalls:", err);
  }
}

/** Orders past their accept deadline, still awaiting a response — auto-rejected, no penalty to the owner. */
async function sweepUnansweredOrders(): Promise<void> {
  const now = new Date();
  const overdue = await prisma.order.findMany({
    where: { status: "placed", acceptDeadline: { lte: now } },
    include: { stall: true },
  });
  for (const order of overdue) {
    try {
      // transitionOrderStatus awaits the rejection notification internally,
      // so it's guaranteed to have gone out before the alternatives list —
      // matters here since both are separate WhatsApp messages to the same chat.
      await transitionOrderStatus(order.id, order.stallId, "rejected", { auto: true });
      await suggestAlternativeStalls(order.studentId, order.stallId, order.stall.area);
    } catch (err) {
      console.error(`SLA sweep: failed to auto-reject order ${order.id}:`, err);
    }
  }
}

/**
 * Orders accepted but never marked ready before their pickup slot ended —
 * flags the SLA violation the moment it happens, even before the order (if
 * ever) actually gets marked ready. transitionOrderStatus separately
 * finalizes the exact delay if/when it does reach "ready".
 */
async function sweepSlaViolations(): Promise<void> {
  const now = new Date();
  const candidates = await prisma.order.findMany({
    where: { status: { in: ["accepted", "preparing"] }, slaViolation: false },
    include: { pickupSlot: true },
  });
  for (const order of candidates) {
    const slotEnd = slotEndInstant(order.pickupSlot.slotDate, order.pickupSlot.endTime);
    if (slotEnd >= now) continue;
    const minutesLate = Math.ceil((now.getTime() - slotEnd.getTime()) / 60_000);
    try {
      await prisma.order.update({
        where: { id: order.id },
        data: { slaViolation: true, slaViolationMinutes: minutesLate },
      });
    } catch (err) {
      console.error(`SLA sweep: failed to flag SLA violation for order ${order.id}:`, err);
    }
  }
}

/** Orders ready but never collected within the pickup slot + grace period — closed out, never counted against the owner. */
async function sweepNoShows(): Promise<void> {
  const now = new Date();
  const candidates = await prisma.order.findMany({
    where: { status: "ready" },
    include: { pickupSlot: true, stall: true },
  });
  for (const order of candidates) {
    const graceMinutes = order.stall.pickupGraceMinutes ?? DEFAULT_PICKUP_GRACE_MINUTES;
    const deadline = new Date(
      slotEndInstant(order.pickupSlot.slotDate, order.pickupSlot.endTime).getTime() + graceMinutes * 60_000,
    );
    if (deadline >= now) continue;
    try {
      await transitionOrderStatus(order.id, order.stallId, "completed", { noShow: true });
    } catch (err) {
      console.error(`SLA sweep: failed to close no-show order ${order.id}:`, err);
    }
  }
}

export async function runSlaSweep(): Promise<void> {
  await sweepUnansweredOrders();
  await sweepSlaViolations();
  await sweepNoShows();
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Starts the SLA sweep loop. Safe to call once at server startup — idempotent if called again. */
export function startSlaMonitor(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runSlaSweep().catch((err) => console.error("SLA sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}
