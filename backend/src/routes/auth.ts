import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";

export const authRouter = Router();

const ownerLoginSchema = z.object({ phone: z.string().min(5), password: z.string().min(1) });
const adminLoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post(
  "/owner/login",
  asyncHandler(async (req, res) => {
    const parsed = ownerLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "phone and password are required." });

    const owner = await prisma.stallOwner.findUnique({ where: { phone: parsed.data.phone } });
    if (!owner || !(await bcrypt.compare(parsed.data.password, owner.passwordHash))) {
      return res.status(401).json({ error: "Incorrect phone number or password." });
    }
    const token = signToken({ id: owner.id, role: "stall_owner" });
    res.json({ token, name: owner.name });
  }),
);

authRouter.post(
  "/admin/login",
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "email and password are required." });

    const admin = await prisma.superAdmin.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    const token = signToken({ id: admin.id, role: "super_admin" });
    res.json({ token, name: admin.name });
  }),
);
