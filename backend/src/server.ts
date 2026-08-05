import "dotenv/config";
import express from "express";
import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { webhookRouter } from "./routes/webhook";
import { authRouter } from "./routes/auth";
import { ownerOrdersRouter } from "./routes/ownerOrders";
import { adminRouter } from "./routes/adminStalls";
import { startSlaMonitor } from "./services/slaMonitor";

// Last-resort safety net: a bug or a transient failure (e.g. a momentary DB
// blip) anywhere we didn't anticipate should never take the whole process
// down. Route-level errors are already caught by asyncHandler; this only
// catches what slips past that (e.g. errors outside a request context).
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

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
app.use("/api/owner", ownerOrdersRouter);
app.use("/api/admin", adminRouter);

// Catches anything forwarded via next(err) — including every asyncHandler
// rejection — and responds with 500 instead of letting Express's default
// handler leak stack traces or, worse, leaving the request hanging.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Request error:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please try again." });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Backend listening on port ${port}`));

// Order SLA & Accountability sweep — auto-reject/SLA-violation/no-show
// checks, running every minute in-process (see services/slaMonitor.ts).
startSlaMonitor();
