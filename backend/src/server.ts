import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { validateEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { apiLimiter } from "./lib/rateLimit";
import { prisma } from "./lib/prisma";
import { webhookRouter } from "./routes/webhook";
import { authRouter } from "./routes/auth";
import { ownerOrdersRouter } from "./routes/ownerOrders";
import { adminRouter } from "./routes/adminStalls";
import { startSlaMonitor } from "./services/slaMonitor";

// Fail fast on a broken production config (missing DB, insecure JWT secret
// still set in production) rather than serving requests that will 500 or
// sign forgeable tokens. See lib/env.ts for exactly what's checked.
validateEnv();

// Last-resort safety net: a bug or a transient failure (e.g. a momentary DB
// blip) anywhere we didn't anticipate should never take the whole process
// down. Route-level errors are already caught by asyncHandler; this only
// catches what slips past that (e.g. errors outside a request context).
process.on("unhandledRejection", (err) => logger.error("process.unhandled_rejection", { error: err instanceof Error ? err.message : String(err) }));
process.on("uncaughtException", (err) => logger.error("process.uncaught_exception", { error: err instanceof Error ? err.message : String(err) }));

const app = express();
app.use(cors());
// `verify` captures the exact raw bytes Meta sent, before JSON parsing —
// the webhook signature check (routes/webhook.ts) needs to hash those exact
// bytes, not a re-serialized copy that could differ byte-for-byte.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

// A per-request id, echoed back in the response header and included in every
// structured log line for that request — makes it possible to correlate a
// user-reported error with the exact server-side log entries.
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = req.header("x-request-id") ?? randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    rawBody?: Buffer;
  }
}

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

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => logger.info("server.started", { port, nodeEnv: process.env.NODE_ENV ?? "development" }));

// Order SLA & Accountability sweep — auto-reject/SLA-violation/no-show
// checks, running every minute in-process (see services/slaMonitor.ts).
startSlaMonitor();

// Best-effort, non-blocking visibility into the WhatsApp access token's
// type/expiry at boot — a short-lived USER token (Meta's test-app default)
// silently breaks the bot every 1-2 hours; a permanent System User token
// (see HANDOFF.md §3) has no expires_at. This never blocks startup or
// throws — it's purely a log line for whoever's watching Render's logs.
if (process.env.WHATSAPP_ACCESS_TOKEN) {
  fetch(
    `https://graph.facebook.com/v21.0/debug_token?input_token=${process.env.WHATSAPP_ACCESS_TOKEN}&access_token=${process.env.WHATSAPP_ACCESS_TOKEN}`,
  )
    .then((r) => r.json() as Promise<{ data?: { type?: string; is_valid?: boolean; expires_at?: number } }>)
    .then((data) => {
      const info = data?.data;
      if (!info) return;
      const expiresAt = info.expires_at;
      const isPermanent = !expiresAt || expiresAt === 0;
      logger.info("whatsapp.token_status", {
        type: info.type,
        isValid: info.is_valid,
        isPermanent,
        expiresAt: isPermanent || !expiresAt ? null : new Date(expiresAt * 1000).toISOString(),
      });
      if (!isPermanent) {
        logger.warn("whatsapp.token_not_permanent", {
          note: "Using a short-lived token — see HANDOFF.md §3 for how to generate a permanent System User token.",
        });
      }
    })
    .catch(() => {
      /* best-effort only — never block or fail startup over this */
    });
}
