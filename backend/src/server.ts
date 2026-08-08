import "dotenv/config";
import { validateEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { createApp } from "./app";
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

const app = createApp();

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
