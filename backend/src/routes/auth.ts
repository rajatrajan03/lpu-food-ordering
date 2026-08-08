import { randomInt } from "crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma";
import { requireAuth, revokeToken, signToken } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { authLimiter, otpLimiter } from "../lib/rateLimit";
import { auditLog } from "../lib/logger";
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
    console.log("Google credential verified for email:", payload.email);
    return { email: payload.email, googleId: payload.sub };
  } catch (err) {
    console.error("Google credential verification failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

const OTP_TTL_MS = 5 * 60 * 1000;
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

// Temporarily disabled at the user's request (2026-08-09) — OTP delivery
// goes over WhatsApp only, and there's no email-sending service configured
// yet to offer as an alternative. Flip this back to `true` once one is
// wired up (see issueOtp) to restore Super Admin 2FA. Every other admin
// login rule (email+password, Google sign-in) is unchanged.
const ADMIN_OTP_ENABLED = false;

authRouter.post(
  "/owner/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = ownerLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "phone and password are required." });

    const owner = await prisma.stallOwner.findUnique({ where: { phone: parsed.data.phone } });
    if (!owner || !(await bcrypt.compare(parsed.data.password, owner.passwordHash))) {
      auditLog("auth.owner_login_failed", { phone: parsed.data.phone, ip: req.ip });
      return res.status(401).json({ error: "Incorrect phone number or password." });
    }
    const token = signToken({ id: owner.id, role: "stall_owner" });
    auditLog("auth.owner_login_succeeded", { ownerId: owner.id, ip: req.ip });
    res.json({ token, name: owner.name });
  }),
);

// Stall Owner Google sign-in is a single step — no OTP, unlike Super Admin below.
authRouter.post(
  "/owner/google",
  authLimiter,
  asyncHandler(async (req, res) => {
    if (!googleClient) return res.status(503).json({ error: "Google login isn't configured on this server." });
    const parsed = googleLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Missing Google credential." });

    const verified = await verifyGoogleCredential(parsed.data.credential);
    if (!verified) return res.status(401).json({ error: "Invalid Google credential." });

    const owner = await prisma.stallOwner.findUnique({ where: { email: verified.email } });
    if (!owner) {
      auditLog("auth.owner_google_login_failed", { email: verified.email, ip: req.ip });
      return res.status(403).json({ error: "No Stall Owner account is registered for this Google account." });
    }

    if (owner.googleId !== verified.googleId) {
      await prisma.stallOwner.update({ where: { id: owner.id }, data: { googleId: verified.googleId } });
    }
    const token = signToken({ id: owner.id, role: "stall_owner" });
    auditLog("auth.owner_google_login_succeeded", { ownerId: owner.id, ip: req.ip });
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
  // Cryptographically secure — a login code guards a Super Admin account,
  // Math.random() is not appropriate for anything security-sensitive.
  const otp = randomInt(100000, 1000000).toString();
  await prisma.superAdmin.update({
    where: { id: adminId },
    data: { otpCode: otp, otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  await sendWhatsAppText(whatsappNumber, `Your LPU Food admin login code is ${otp}. It expires in 5 minutes.`);
}

authRouter.post(
  "/admin/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "email and password are required." });

    const admin = await prisma.superAdmin.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
      auditLog("auth.admin_login_failed", { email: parsed.data.email, ip: req.ip });
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    if (!ADMIN_OTP_ENABLED) {
      const token = signToken({ id: admin.id, role: "super_admin" });
      auditLog("auth.admin_login_succeeded", { adminId: admin.id, ip: req.ip, otpSkipped: true });
      return res.json({ token, name: admin.name });
    }

    try {
      await issueOtp(admin.id, admin.whatsappNumber);
    } catch (err) {
      return res.status((err as { httpStatus?: number }).httpStatus ?? 500).json({ error: (err as Error).message });
    }
    auditLog("auth.admin_otp_issued", { adminId: admin.id, ip: req.ip });
    res.json({ otpRequired: true, adminId: admin.id });
  }),
);

authRouter.post(
  "/admin/google",
  authLimiter,
  asyncHandler(async (req, res) => {
    if (!googleClient) return res.status(503).json({ error: "Google login isn't configured on this server." });
    const parsed = googleLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Missing Google credential." });

    const verified = await verifyGoogleCredential(parsed.data.credential);
    if (!verified) return res.status(401).json({ error: "Invalid Google credential." });

    const admin = await prisma.superAdmin.findUnique({ where: { email: verified.email } });
    if (!admin) {
      auditLog("auth.admin_google_login_failed", { email: verified.email, ip: req.ip });
      return res.status(403).json({ error: "No Super Admin account is registered for this Google account." });
    }

    if (admin.googleId !== verified.googleId) {
      await prisma.superAdmin.update({ where: { id: admin.id }, data: { googleId: verified.googleId } });
    }

    if (!ADMIN_OTP_ENABLED) {
      const token = signToken({ id: admin.id, role: "super_admin" });
      auditLog("auth.admin_login_succeeded", { adminId: admin.id, ip: req.ip, via: "google", otpSkipped: true });
      return res.json({ token, name: admin.name });
    }

    try {
      await issueOtp(admin.id, admin.whatsappNumber);
    } catch (err) {
      return res.status((err as { httpStatus?: number }).httpStatus ?? 500).json({ error: (err as Error).message });
    }
    auditLog("auth.admin_otp_issued", { adminId: admin.id, ip: req.ip, via: "google" });
    res.json({ otpRequired: true, adminId: admin.id });
  }),
);

authRouter.post(
  "/admin/verify-otp",
  otpLimiter,
  asyncHandler(async (req, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A 6-digit code is required." });

    const admin = await prisma.superAdmin.findUnique({ where: { id: parsed.data.adminId } });
    if (!admin || !admin.otpCode || !admin.otpExpiresAt) {
      return res.status(401).json({ error: "No login code pending — please sign in again." });
    }
    if (admin.otpExpiresAt < new Date()) {
      auditLog("auth.admin_otp_expired", { adminId: admin.id, ip: req.ip });
      return res.status(401).json({ error: "That code has expired — please sign in again." });
    }
    if (admin.otpCode !== parsed.data.otp) {
      auditLog("auth.admin_otp_incorrect", { adminId: admin.id, ip: req.ip });
      return res.status(401).json({ error: "Incorrect code." });
    }

    await prisma.superAdmin.update({ where: { id: admin.id }, data: { otpCode: null, otpExpiresAt: null } });
    const token = signToken({ id: admin.id, role: "super_admin" });
    auditLog("auth.admin_login_succeeded", { adminId: admin.id, ip: req.ip });
    res.json({ token, name: admin.name });
  }),
);

/** Logout: revokes just this token (its jti) — other sessions for the same account are unaffected. */
authRouter.post(
  "/logout",
  requireAuth(),
  asyncHandler(async (req, res) => {
    revokeToken(req.auth!);
    auditLog("auth.logout", { userId: req.auth!.id, role: req.auth!.role, ip: req.ip });
    res.json({ ok: true });
  }),
);
