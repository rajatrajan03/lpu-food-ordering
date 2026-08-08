import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import {
  getCompletedOrdersToday,
  getOrderQueueForStall,
  getOrdersForDay,
  getSlaMetricsForStall,
  istDayBounds,
  transitionOrderStatus,
  OrderError,
} from "../services/orderService";
import { triggerRatingPrompt } from "../ai/ratingFlow";
import * as ratingService from "../services/ratingService";
import * as offerService from "../services/offerService";
import { askOwnerAssistant, BusinessAssistantError } from "../services/businessAssistantService";
import { getOwnerAnalytics, resolveDateRange, toOwnerReport, AnalyticsError } from "../services/advancedAnalyticsService";
import { reportToCsv, reportToXlsx, reportToPdf } from "../services/exportService";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const ownerOrdersRouter = Router();
ownerOrdersRouter.use(requireAuth("stall_owner"));

async function assertOwnsStall(ownerId: string, stallId: string) {
  const owner = await prisma.stallOwner.findFirst({
    where: { id: ownerId, stalls: { some: { id: stallId } } },
  });
  return Boolean(owner);
}

ownerOrdersRouter.get(
  "/stalls/:stallId/orders",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    res.json(await getOrderQueueForStall(stallId));
  }),
);

ownerOrdersRouter.get(
  "/stalls/:stallId/orders/completed-today",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    res.json(await getCompletedOrdersToday(stallId));
  }),
);

ownerOrdersRouter.get(
  "/stalls/:stallId/sla-metrics",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const date = req.query.date;
    if (date !== undefined && (typeof date !== "string" || !DATE_PATTERN.test(date))) {
      return res.status(400).json({ error: "Invalid date — expected YYYY-MM-DD." });
    }
    const opts =
      typeof date === "string"
        ? (() => {
            const { start, end } = istDayBounds(date);
            return { since: start, until: end };
          })()
        : {};
    res.json(await getSlaMetricsForStall(stallId, opts));
  }),
);

/** Every order placed on a given past (or present) day, any status — powers the dashboard's date-picker history view. */
ownerOrdersRouter.get(
  "/stalls/:stallId/orders/history",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const date = req.query.date;
    if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
      return res.status(400).json({ error: "date is required, expected YYYY-MM-DD." });
    }
    res.json(await getOrdersForDay(stallId, date));
  }),
);

const transitionSchema = z.object({
  status: z.enum(["accepted", "rejected", "preparing", "ready", "completed"]),
});

ownerOrdersRouter.post(
  "/stalls/:stallId/orders/:orderId/status",
  asyncHandler(async (req, res) => {
    const { stallId, orderId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid target status." });

    try {
      const order = await transitionOrderStatus(orderId, stallId, parsed.data.status);
      if (parsed.data.status === "completed") {
        // Fire-and-forget: never delay the owner's response for a WhatsApp send.
        // This route is the only place a genuine owner-driven completion
        // originates (slaMonitor's no-show sweep calls transitionOrderStatus
        // directly, not through here), so no-show closures never trigger a prompt.
        triggerRatingPrompt({ id: order.id, studentId: order.studentId, stallId: order.stallId }).catch((err) =>
          console.error("Failed to trigger rating prompt:", err),
        );
      }
      res.json(order);
    } catch (err) {
      if (err instanceof OrderError) return res.status(409).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.get(
  "/stalls/:stallId/ratings",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    res.json(await ratingService.getStallRatingDetail(stallId));
  }),
);

ownerOrdersRouter.post(
  "/stalls/:stallId/pause",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const stall = await prisma.stall.update({ where: { id: stallId }, data: { status: "paused" } });
    res.json(stall);
  }),
);

ownerOrdersRouter.post(
  "/stalls/:stallId/resume",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const stall = await prisma.stall.update({ where: { id: stallId }, data: { status: "active" } });
    res.json(stall);
  }),
);

// ---- Offers & Promotions ----

ownerOrdersRouter.get(
  "/stalls/:stallId/offers",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    res.json(await offerService.listOffersForStall(stallId));
  }),
);

ownerOrdersRouter.get(
  "/stalls/:stallId/offers/analytics",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    res.json(await offerService.getOfferAnalytics(stallId));
  }),
);

const offerSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum([
    "percentage_discount",
    "flat_discount",
    "buy_x_get_y",
    "free_item",
    "combo",
    "happy_hour",
    "festival",
    "min_order_value",
  ]),
  active: z.boolean().optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  minOrderValue: z.number().nullable().optional(),
  maxDiscount: z.number().nullable().optional(),
  discountPercent: z.number().int().min(0).max(100).nullable().optional(),
  discountFlat: z.number().nullable().optional(),
  buyQuantity: z.number().int().min(1).nullable().optional(),
  getQuantity: z.number().int().min(1).nullable().optional(),
  freeItemId: z.string().nullable().optional(),
  happyHourStart: z.string().nullable().optional(),
  happyHourEnd: z.string().nullable().optional(),
  applicableItemIds: z.array(z.string()).optional(),
  applicableCategoryNames: z.array(z.string()).optional(),
});

ownerOrdersRouter.post(
  "/stalls/:stallId/offers",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const parsed = offerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const offer = await offerService.createOffer(stallId, parsed.data);
      res.status(201).json(offer);
    } catch (err) {
      if (err instanceof offerService.OfferError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.patch(
  "/stalls/:stallId/offers/:offerId",
  asyncHandler(async (req, res) => {
    const { stallId, offerId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const parsed = offerSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const offer = await offerService.updateOffer(offerId, stallId, parsed.data);
      res.json(offer);
    } catch (err) {
      if (err instanceof offerService.OfferError) return res.status(404).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.delete(
  "/stalls/:stallId/offers/:offerId",
  asyncHandler(async (req, res) => {
    const { stallId, offerId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    try {
      await offerService.deleteOffer(offerId, stallId);
      res.status(204).end();
    } catch (err) {
      if (err instanceof offerService.OfferError) return res.status(404).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.post(
  "/stalls/:stallId/offers/:offerId/:action(activate|deactivate)",
  asyncHandler(async (req, res) => {
    const { stallId, offerId, action } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    try {
      const offer = await offerService.setOfferActive(offerId, stallId, action === "activate");
      res.json(offer);
    } catch (err) {
      if (err instanceof offerService.OfferError) return res.status(404).json({ error: err.message });
      throw err;
    }
  }),
);

// ---- Advanced Analytics ----

function parsePeriodQuery(req: import("express").Request) {
  const period = (req.query.period as string) ?? "today";
  if (!["today", "week", "month", "custom"].includes(period)) {
    throw new AnalyticsError("period must be one of today, week, month, custom.");
  }
  return resolveDateRange(period as "today" | "week" | "month" | "custom", req.query.from as string, req.query.to as string);
}

ownerOrdersRouter.get(
  "/stalls/:stallId/analytics",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    try {
      const range = parsePeriodQuery(req);
      res.json(await getOwnerAnalytics(stallId, range));
    } catch (err) {
      if (err instanceof AnalyticsError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.get(
  "/stalls/:stallId/analytics/export",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const format = (req.query.format as string) ?? "csv";
    if (!["csv", "xlsx", "pdf"].includes(format)) return res.status(400).json({ error: "format must be csv, xlsx, or pdf." });
    try {
      const range = parsePeriodQuery(req);
      const report = toOwnerReport(await getOwnerAnalytics(stallId, range));
      const filenameBase = `analytics-${stallId}-${range.period}`;
      if (format === "csv") {
        res.set("Content-Type", "text/csv").set("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
        return res.send(reportToCsv(report));
      }
      if (format === "xlsx") {
        res
          .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
          .set("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
        return res.send(reportToXlsx(report));
      }
      res.set("Content-Type", "application/pdf").set("Content-Disposition", `attachment; filename="${filenameBase}.pdf"`);
      res.send(await reportToPdf(report));
    } catch (err) {
      if (err instanceof AnalyticsError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }),
);

// ---- AI Business Assistant (owner-scoped — only ever sees this stall's own data) ----

const aiQuestionSchema = z.object({ question: z.string().min(1).max(500) });

ownerOrdersRouter.post(
  "/stalls/:stallId/ai-assistant",
  asyncHandler(async (req, res) => {
    const { stallId } = req.params;
    if (!(await assertOwnsStall(req.auth!.id, stallId))) {
      return res.status(403).json({ error: "You do not manage this stall." });
    }
    const parsed = aiQuestionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A question is required." });
    try {
      const answer = await askOwnerAssistant(stallId, parsed.data.question);
      res.json({ answer });
    } catch (err) {
      if (err instanceof BusinessAssistantError) return res.status(404).json({ error: err.message });
      throw err;
    }
  }),
);

ownerOrdersRouter.get(
  "/stalls/mine",
  asyncHandler(async (req, res) => {
    const owner = await prisma.stallOwner.findUnique({
      where: { id: req.auth!.id },
      include: { stalls: true },
    });
    res.json(owner?.stalls ?? []);
  }),
);
