import { randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./lib/logger";
import { apiLimiter } from "./lib/rateLimit";
import { prisma } from "./lib/prisma";
import { webhookRouter } from "./routes/webhook";
import { authRouter } from "./routes/auth";
import { ownerOrdersRouter } from "./routes/ownerOrders";
import { adminRouter } from "./routes/adminStalls";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    rawBody?: Buffer;
  }
}

/**
 * Builds the Express app with every middleware/route wired up, but never
 * calls `.listen()` or starts the SLA sweep — split out from server.ts
 * specifically so the API test suite (tests/api/*.test.ts) can drive it
 * in-process via supertest without binding a real port or running the
 * background cron. server.ts is the actual production entrypoint: it
 * imports this, calls `.listen()`, and starts startSlaMonitor()/the
 * WhatsApp token check.
 */
export function createApp() {
  const app = express();
  // Render sits in front of the app behind a single reverse-proxy hop —
  // without this, express-rate-limit sees Render's X-Forwarded-For header
  // and (by design, as a misconfiguration guard) throws on every request
  // instead of silently trusting a spoofable header. `1` means "trust
  // exactly one hop", which also makes req.ip resolve to the real client IP.
  app.set("trust proxy", 1);
  app.use(cors());
  // `verify` captures the exact raw bytes sent, before JSON parsing — the
  // webhook signature check (routes/webhook.ts) needs to hash those exact
  // bytes, not a re-serialized copy that could differ byte-for-byte.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // A per-request id, echoed back in the response header and included in
  // every structured log line for that request.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = req.header("x-request-id") ?? randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  app.get("/health", async (_req, res) => {
    const startedAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "connected", uptimeSeconds: Math.round(process.uptime()), latencyMs: Date.now() - startedAt });
    } catch (err) {
      logger.error("health.db_unreachable", { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: "degraded", db: "unreachable" });
    }
  });

  // Required by Meta before the app can be published — see PRIVACY_POLICY.md
  // for the source content. Served as static HTML so it doesn't need its own
  // hosting; the tunnel URL + this path is what goes in Meta's app settings.
  app.get("/privacy-policy", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Privacy Policy — LPU Food Ordering</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1b2320}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.5rem}</style></head>
<body>
<h1>Privacy Policy — LPU Food Pre-Booking System</h1>
<p>This WhatsApp ordering assistant is a student project for pre-booking food at LPU campus stalls.</p>
<h2>What we collect</h2>
<p>Your WhatsApp phone number, name (if provided), and the food orders you place (items, prices, pickup times). Stall owners see order details only for orders placed at their own stall.</p>
<h2>How it's used</h2>
<p>Solely to operate the ordering service: identifying your account, processing your cart and orders, and showing stall owners the orders they need to prepare.</p>
<h2>Who it's shared with</h2>
<p>Not sold or shared with third parties. Messages are processed via Meta's WhatsApp Business Platform and an AI language model provider (Groq) solely to understand and respond to your messages.</p>
<h2>Contact</h2>
<p>Questions about this policy can be directed to the developer via the WhatsApp number this bot operates on.</p>
</body></html>`);
  });

  app.use("/webhook/whatsapp", webhookRouter);
  app.use("/api/auth", authRouter);
  app.use("/api", apiLimiter);
  app.use("/api/owner", ownerOrdersRouter);
  app.use("/api/admin", adminRouter);

  // Catches anything forwarded via next(err) — including every asyncHandler
  // rejection — and responds with 500 instead of letting Express's default
  // handler leak stack traces or, worse, leaving the request hanging.
  // Deliberately never forwards err.message to the client here: known,
  // intentional error classes (OrderError, OfferError, RatingError, etc.)
  // already send their own friendly message earlier in each route and never
  // reach this handler — anything that does reach here is unexpected, so the
  // safe default is a generic message, with the real detail only in the log.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error("request.unhandled_error", {
      requestId: req.requestId,
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
