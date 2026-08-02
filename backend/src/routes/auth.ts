import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { sendWhatsAppText } from "../whatsapp/client";

export const authRouter = Router();

const ownerLoginSchema = z.object({ phone: z.string().min(5), password: z.string().min(1) });
const adminLoginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const otpVerifySchema = z.object({ adminId: z.string().uuid(), otp: z.string().length(6) });
const googleLoginSchema = z.object({ credential: z.string().min(1) });

async function verifyGoogleCredential(credential: string): Promise<{ email: string; googleId: string } | null> {
  if (!googleClient) return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) return null;
    return { email: payload.email, googleId: payload.sub };
  } catch {
    return null;
  }
}

const OTP_TTL_MS = 5 * 60 * 1000;
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

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

// Stall Owner Google sign-in is a single step — no OTP, unlike Super Admin below.
authRouter.post(
  "/owner/google",
  asyncHandler(async (req, res) => {
    if (!googleClient) return res.status(503).json({ error: "Google login isn't configured on this server." });
    const parsed = googleLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Missing Google credential." });

    const verified = await verifyGoogleCredential(parsed.data.credential);
    if (!verified) return res.status(401).json({ error: "Invalid Google credential." });

    const owner = await prisma.stallOwner.findUnique({ where: { email: verified.email } });
    if (!owner) return res.status(403).json({ error: "No Stall Owner account is registered for this Google account." });

    if (owner.googleId !== verified.googleId) {
      await prisma.stallOwner.update({ where: { id: owner.id }, data: { googleId: verified.googleId } });
    }
    const token = signToken({ id: owner.id, role: "stall_owner" });
    res.json({ token, name: owner.name });
  }),
);

/** Generates and sends a fresh OTP to the admin's WhatsApp, replacing any still-pending one. */
async function issueOtp(adminId: string, whatsappNumber: string | null) {
  if (!whatsappNumber) {
    throw Object.assign(new Error("No WhatsApp number on file for this admin — cannot send a login code."), {
      httpStatus: 400,
    });
  }
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await prisma.superAdmin.update({
    where: { id: adminId },
    data: { otpCode: otp, otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  await sendWhatsAppText(whatsappNumber, `Your LPU Food admin login code is ${otp}. It expires in 5 minutes.`);
}

authRouter.post(
  "/admin/login",
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "email and password are required." });

    const admin = await prisma.superAdmin.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    try {
      await issueOtp(admin.id, admin.whatsappNumber);
    } catch (err) {
      return res.status((err as { httpStatus?: number }).httpStatus ?? 500).json({ error: (err as Error).message });
    }
    res.json({ otpRequired: true, adminId: admin.id });
  }),
);

authRouter.post(
  "/admin/google",
  asyncHandler(async (req, res) => {
    if (!googleClient) return res.status(503).json({ error: "Google login isn't configured on this server." });
    const parsed = googleLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Missing Google credential." });

    const verified = await verifyGoogleCredential(parsed.data.credential);
    if (!verified) return res.status(401).json({ error: "Invalid Google credential." });

    const admin = await prisma.superAdmin.findUnique({ where: { email: verified.email } });
    if (!admin) return res.status(403).json({ error: "No Super Admin account is registered for this Google account." });

    if (admin.googleId !== verified.googleId) {
      await prisma.superAdmin.update({ where: { id: admin.id }, data: { googleId: verified.googleId } });
    }

    try {
      await issueOtp(admin.id, admin.whatsappNumber);
    } catch (err) {
      return res.status((err as { httpStatus?: number }).httpStatus ?? 500).json({ error: (err as Error).message });
    }
    res.json({ otpRequired: true, adminId: admin.id });
  }),
);

authRouter.post(
  "/admin/verify-otp",
  asyncHandler(async (req, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A 6-digit code is required." });

    const admin = await prisma.superAdmin.findUnique({ where: { id: parsed.data.adminId } });
    if (!admin || !admin.otpCode || !admin.otpExpiresAt) {
      return res.status(401).json({ error: "No login code pending — please sign in again." });
    }
    if (admin.otpExpiresAt < new Date()) {
      return res.status(401).json({ error: "That code has expired — please sign in again." });
    }
    if (admin.otpCode !== parsed.data.otp) {
      return res.status(401).json({ error: "Incorrect code." });
    }

    await prisma.superAdmin.update({ where: { id: admin.id }, data: { otpCode: null, otpExpiresAt: null } });
    const token = signToken({ id: admin.id, role: "super_admin" });
    res.json({ token, name: admin.name });
  }),
);
