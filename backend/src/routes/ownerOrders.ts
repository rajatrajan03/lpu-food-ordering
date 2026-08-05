import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import {
  getCompletedOrdersToday,
  getOrderQueueForStall,
  getSlaMetricsForStall,
  transitionOrderStatus,
  OrderError,
} from "../services/orderService";

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
    res.json(await getSlaMetricsForStall(stallId));
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
      res.json(order);
    } catch (err) {
      if (err instanceof OrderError) return res.status(409).json({ error: err.message });
      throw err;
    }
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
