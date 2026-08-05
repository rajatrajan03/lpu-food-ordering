import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { getOverview, getRecentActivity, getStallInsights } from "../services/analyticsService";
import { listStudents, countStudents } from "../services/studentService";

export const adminRouter = Router();
adminRouter.use(requireAuth("super_admin"));

// ---- Operations center (read-only aggregations, additive — see analyticsService) ----

adminRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  }),
);

adminRouter.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    res.json(await getRecentActivity(limit));
  }),
);

adminRouter.get(
  "/stalls/insights",
  asyncHandler(async (_req, res) => {
    res.json(await getStallInsights());
  }),
);

// ---- Stalls ----

adminRouter.get(
  "/stalls",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.stall.findMany({ include: { owners: true }, orderBy: { name: "asc" } }));
  }),
);

const updateStallSchema = z.object({
  name: z.string().optional(),
  status: z.enum(["active", "paused"]).optional(),
  nightOpen: z.boolean().optional(),
  openingHours: z.record(z.string()).optional(),
  pickupNote: z.string().optional(),
  // No-show grace period (minutes past the pickup slot's end) — configurable
  // per stall; null/omitted falls back to orderService.DEFAULT_PICKUP_GRACE_MINUTES.
  pickupGraceMinutes: z.number().int().min(0).max(60).nullable().optional(),
});

adminRouter.patch(
  "/stalls/:stallId",
  asyncHandler(async (req, res) => {
    const parsed = updateStallSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const stall = await prisma.stall.update({ where: { id: req.params.stallId }, data: parsed.data });
    res.json(stall);
  }),
);

const bulkStatusSchema = z.object({
  stallIds: z.array(z.string()).optional(), // omit to apply to every stall
  status: z.enum(["active", "paused"]),
});

// Bulk pause/resume — used by the "Pause all" / "Resume all" toolbar action,
// a single updateMany instead of the dashboard looping one PATCH per stall.
adminRouter.post(
  "/stalls/bulk-status",
  asyncHandler(async (req, res) => {
    const parsed = bulkStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { stallIds, status } = parsed.data;
    const result = await prisma.stall.updateMany({
      where: stallIds ? { id: { in: stallIds } } : {},
      data: { status },
    });
    res.json({ updated: result.count });
  }),
);

// ---- Stall owners ----

const createOwnerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().email().optional().or(z.literal("")),
  password: z.string().min(6),
  stallIds: z.array(z.string()).min(1),
});

adminRouter.post(
  "/owners",
  asyncHandler(async (req, res) => {
    const parsed = createOwnerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const { name, phone, email, password, stallIds } = parsed.data;

    const passwordHash = await bcrypt.hash(password, 10);
    const owner = await prisma.stallOwner.create({
      data: {
        name,
        phone,
        email: email ? email : undefined,
        passwordHash,
        stalls: { connect: stallIds.map((id) => ({ id })) },
      },
      include: { stalls: true },
    });
    res.status(201).json(owner);
  }),
);

// ---- Canonical categories (the curated taxonomy) ----

adminRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.canonicalCategory.findMany({ orderBy: { name: "asc" } }));
  }),
);

adminRouter.post(
  "/categories",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "name is required." });
    const category = await prisma.canonicalCategory.create({ data: { name: parsed.data.name } });
    res.status(201).json(category);
  }),
);

// Re-map a stall's raw imported category label onto a canonical category.
// This is the review step for the AI-assisted category-normalization pass.
adminRouter.patch(
  "/menu-categories/:menuCategoryId",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ canonicalCategoryId: z.string() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "canonicalCategoryId is required." });
    const menuCategory = await prisma.menuCategory.update({
      where: { id: req.params.menuCategoryId },
      data: { canonicalCategoryId: parsed.data.canonicalCategoryId },
    });
    res.json(menuCategory);
  }),
);

adminRouter.get(
  "/menu-categories/unmapped",
  asyncHandler(async (_req, res) => {
    res.json(
      await prisma.menuCategory.findMany({
        where: { canonicalCategoryId: null },
        include: { stall: true },
      }),
    );
  }),
);

// ---- Menu items ----

adminRouter.get(
  "/stalls/:stallId/items",
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.menuItem.findMany({
        where: { stallId: req.params.stallId },
        include: { variants: true, category: true },
      }),
    );
  }),
);

const updateItemSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  basePrice: z.number().optional(),
  isVeg: z.boolean().optional(),
  imageUrl: z.string().optional(),
  available: z.boolean().optional(),
});

adminRouter.patch(
  "/items/:itemId",
  asyncHandler(async (req, res) => {
    const parsed = updateItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const item = await prisma.menuItem.update({ where: { id: req.params.itemId }, data: parsed.data });
    res.json(item);
  }),
);

// ---- Students (WhatsApp onboarding) — read-only: registration numbers are
// stored as given at onboarding and never edited from here. ----

adminRouter.get(
  "/students",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const [students, total] = await Promise.all([listStudents({ limit, offset }), countStudents()]);
    res.json({ students, total });
  }),
);
