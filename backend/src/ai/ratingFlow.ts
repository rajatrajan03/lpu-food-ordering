import { prisma } from "../lib/prisma";
import { sendWhatsAppList, type ListRow } from "../whatsapp/client";
import { getSessionState } from "./conversationEngine";
import * as ratingService from "../services/ratingService";

const RATE_STARS_PREFIX = "rate_stars:"; // duplicated constant — matches the one in conversationEngine.ts

/** Fired after an order is marked completed — sends the star-rating prompt and arms session.ratingFlow. Never throws. */
export async function triggerRatingPrompt(order: { id: string; studentId: string; stallId: string }): Promise<void> {
  try {
    if (await ratingService.hasRating(order.id)) return;

    const student = await prisma.student.findUnique({ where: { id: order.studentId } });
    if (!student) return;
    const stall = await prisma.stall.findUnique({ where: { id: order.stallId } });
    if (!stall) return;

    const rows: ListRow[] = [5, 4, 3, 2, 1].map((n) => ({
      id: `${RATE_STARS_PREFIX}${n}`,
      title: `${"⭐".repeat(n)} (${n})`,
    }));
    await sendWhatsAppList(student.whatsappNumber, `⭐⭐⭐⭐⭐\nHow was your experience with ${stall.name}?`, "Rate", rows);

    const session = getSessionState(student.sessionState);
    session.ratingFlow = { orderId: order.id, stallId: order.stallId, stallName: stall.name, stage: "awaiting_stars" };
    await prisma.student.update({ where: { id: student.id }, data: { sessionState: session as unknown as object } });
  } catch (err) {
    console.error("Failed to send rating prompt:", err);
  }
}
