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

type AlternativeStall = { id: string; name: string; area: string | null; block: string };

/**
 * Three-tier fallback so an auto-rejected student is left with at least one
 * alternative whenever any active stall exists at all, instead of silently
 * getting nothing the moment the original stall's area has nothing else:
 *   1. Other stalls in the same area.
 *   2. If none: other stalls in the same block (a wider net than area, but
 *      still physically close).
 *   3. If still none: the campus's most active stalls overall (no rating
 *      system exists in the schema, so order volume is the honest proxy).
 * Returns both the matched stalls and which tier matched, so the caller can
 * word the message appropriately.
 */
async function findAlternativeStalls(
  originalStallId: string,
  area: string | null,
  block: string,
): Promise<{ stalls: AlternativeStall[]; tier: "area" | "block" | "active" | null }> {
  if (area) {
    const nearby = await menuService.listStalls({ area, limit: 4 });
    const options = nearby.filter((s) => s.id !== originalStallId).slice(0, 3);
    if (options.length > 0) return { stalls: options, tier: "area" };
  }

  const sameBlock = await menuService.listStalls({ block, limit: 4 });
  const blockOptions = sameBlock.filter((s) => s.id !== originalStallId).slice(0, 3);
  if (blockOptions.length > 0) return { stalls: blockOptions, tier: "block" };

  const active = await menuService.listMostActiveStalls({ limit: 3, excludeIds: [originalStallId] });
  if (active.length > 0) return { stalls: active, tier: "active" };

  return { stalls: [], tier: null };
}

/**
 * Best-effort "here's what else is available" follow-up after an auto-reject
 * — never blocks the reject itself. Sends a real tappable stall list (same
 * id scheme as the Browse Stalls flow, `stall:<id>`) and primes the
 * student's browseFlow to a matching screen so tapping one continues
 * straight into the normal category -> item -> cart flow instead of
 * dead-ending as a suggestion.
 */
async function suggestAlternativeStalls(studentId: string, originalStallId: string, area: string | null, block: string): Promise<void> {
  try {
    const { stalls: options, tier } = await findAlternativeStalls(originalStallId, area, block);
    if (options.length === 0) return;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) return;

    const header =
      tier === "area"
        ? `Other stalls near ${area}:`
        : tier === "block"
          ? `Other stalls in ${block}:`
          : "Other popular stalls you could try:";
    const rows: ListRow[] = options.map((s) => ({
      id: `stall:${s.id}`,
      title: s.name.slice(0, 24),
      description: s.block ?? undefined,
    }));
    await sendWhatsAppList(student.whatsappNumber, header, "Choose stall", rows);

    const session = getSessionState(student.sessionState);
    session.knownStalls = rememberNames(session.knownStalls, options.map((s) => [s.name, s.id]));
    // Only the "area" tier maps onto a real Browse Stalls "stall_list"
    // screen (that screen's `area` field is used verbatim to re-query by
    // area if the student taps Back — stuffing a block value into it would
    // silently break that query, since block and area are different
    // fields). For the "block"/"active" tiers, leave browseFlow untouched;
    // a tapped stall:<id> still resolves correctly by falling through to
    // the AI loop via the knownStalls map populated above.
    if (tier === "area" && area) {
      session.browseFlow = { current: { screen: "stall_list", area }, stack: [{ screen: "location_list" }] };
    }
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
      await suggestAlternativeStalls(order.studentId, order.stallId, order.stall.area, order.stall.block);
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
