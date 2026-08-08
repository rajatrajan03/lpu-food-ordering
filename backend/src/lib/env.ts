import { logger } from "./logger";

const INSECURE_JWT_SECRET = "dev-only-secret-change-me";

// Always required, in every environment — nothing in this app runs without a DB.
const REQUIRED_ALWAYS = ["DATABASE_URL"] as const;

// Required for the app to actually function in production (WhatsApp + AI +
// dashboard auth); missing any of these in dev just means that one
// subsystem won't work locally, which is fine for e.g. dashboard-only work.
const REQUIRED_IN_PRODUCTION = [
  "JWT_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "GEMINI_API_KEY",
] as const;

// Optional but recommended — missing these degrades a specific feature
// rather than breaking the app, so only warn.
const RECOMMENDED = ["WHATSAPP_APP_SECRET", "GOOGLE_CLIENT_ID"] as const;

/**
 * Fails fast at startup on a genuinely broken production config (missing
 * DB, or a production deploy still running the insecure default JWT
 * secret) rather than serving requests that will 500 or, worse, sign
 * forgeable tokens. In development, missing optional-in-prod vars only
 * warn — this must not break `npm run dev` for someone working on just
 * the dashboard/menu-import scripts without full WhatsApp credentials.
 */
export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === "production";
  const missing: string[] = REQUIRED_ALWAYS.filter((k) => !process.env[k]);
  if (isProd) missing.push(...REQUIRED_IN_PRODUCTION.filter((k) => !process.env[k]));

  if (missing.length > 0) {
    logger.error("env.validation_failed", { missing });
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  if (isProd && process.env.JWT_SECRET === INSECURE_JWT_SECRET) {
    logger.error("env.insecure_jwt_secret_in_production");
    throw new Error("JWT_SECRET is still the insecure default — set a long random value before running in production.");
  }

  const missingRecommended = RECOMMENDED.filter((k) => !process.env[k]);
  if (missingRecommended.length > 0) {
    logger.warn("env.recommended_vars_missing", {
      missing: missingRecommended,
      note: "WHATSAPP_APP_SECRET missing disables webhook signature verification; GOOGLE_CLIENT_ID missing disables Google sign-in. Neither blocks startup.",
    });
  }

  logger.info("env.validated", { nodeEnv: process.env.NODE_ENV ?? "development" });
}
