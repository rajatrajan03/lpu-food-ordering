import rateLimit from "express-rate-limit";
import { logger } from "./logger";

function handler(name: string) {
  return (req: import("express").Request, res: import("express").Response) => {
    logger.warn("rate_limit.exceeded", { limiter: name, path: req.path, ip: req.ip });
    res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  };
}

// General dashboard API traffic (owner/admin routes) — generous, this is
// legitimate polling (Owner Dashboard refreshes the order queue every 10s)
// plus normal click-driven usage, not something to throttle aggressively.
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("api"),
});

// Login endpoints — tight enough to slow down credential-stuffing/brute
// force without punishing a real user mistyping their password a couple times.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("auth"),
});

// OTP verification — a 6-digit code has only 1,000,000 combinations, so
// this must be tight enough to make brute-forcing it within the 5-minute
// TTL infeasible.
export const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("otp"),
});

// Meta's webhook — generous (Meta can burst-deliver queued messages), but
// present as a backstop against a misbehaving/malicious sender hammering
// the endpoint directly.
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("webhook"),
});
