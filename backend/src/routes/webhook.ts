import { timingSafeEqual, createHmac } from "crypto";
import { Router } from "express";
import { sendWhatsAppText } from "../whatsapp/client";
import { handleIncomingMessage } from "../ai/conversationEngine";
import { webhookLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";

export const webhookRouter = Router();

let warnedNoAppSecret = false;

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body.
 * Requires WHATSAPP_APP_SECRET to be set (server.ts captures req.rawBody via
 * express.json's `verify` option so this can hash the exact bytes Meta signed,
 * not a re-serialized copy that could differ byte-for-byte).
 *
 * Backward-compatible on purpose: if WHATSAPP_APP_SECRET isn't configured yet
 * (it isn't, as of this change, on the current Render deployment), this logs
 * a one-time warning and lets the request through rather than breaking the
 * live webhook — set the env var to actually enforce verification.
 */
function isValidSignature(req: import("express").Request): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    if (!warnedNoAppSecret) {
      logger.warn("webhook.signature_verification_disabled", {
        note: "WHATSAPP_APP_SECRET is not set — signature verification is skipped. Set it in the environment to enforce.",
      });
      warnedNoAppSecret = true;
    }
    return true;
  }

  const header = req.header("x-hub-signature-256");
  const rawBody = (req as import("express").Request & { rawBody?: Buffer }).rawBody;
  if (!header || !rawBody) return false;

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(header);
  // Lengths must match before timingSafeEqual (it throws on mismatched
  // buffer lengths rather than returning false).
  return expectedBuf.length === givenBuf.length && timingSafeEqual(expectedBuf, givenBuf);
}

// Meta can (and does) deliver two messages from the same number close enough
// together that their handleIncomingMessage calls overlap — both read the
// same Student row before either has written back, silently losing one
// side's update (onboarding fields, cart state). This chains each phone
// number's calls so they run strictly one at a time, in arrival order,
// while different numbers still process fully in parallel. Never evicted,
// but each entry is just a settled-Promise reference — negligible memory
// even at thousands of distinct numbers over the process lifetime.
const perNumberQueue = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = perNumberQueue.get(key) ?? Promise.resolve();
  const result = prior.then(task, task);
  perNumberQueue.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

// Meta calls this once, at setup time, to verify you own the endpoint.
webhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Meta calls this for every inbound message/status update.
// Must return 200 quickly — Meta retries (and eventually disables the webhook)
// on repeated slow/failed responses, so we ack first and reply asynchronously.
webhookRouter.post("/", webhookLimiter, (req, res) => {
  if (!isValidSignature(req)) {
    logger.warn("webhook.invalid_signature", { ip: req.ip });
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  console.log("Webhook POST received:", JSON.stringify(req.body).slice(0, 500));

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];
  if (!message) return;

  const from = message.from as string;
  // A tapped quick-reply button arrives as its own message type, not "text" —
  // feed the button's label through as if the student had typed it, so the
  // existing natural-language tool loop handles it the same way either path.
  // The button/row id is also forwarded (when present) so the deterministic
  // menu-navigation flow can match on a stable id instead of parsing text.
  let text: string | undefined;
  let interactiveId: string | undefined;
  if (message.type === "text") {
    text = message.text?.body as string;
  } else if (message.type === "interactive" && message.interactive?.button_reply) {
    text = message.interactive.button_reply.title as string;
    interactiveId = message.interactive.button_reply.id as string;
  } else if (message.type === "interactive" && message.interactive?.list_reply) {
    text = message.interactive.list_reply.title as string;
    interactiveId = message.interactive.list_reply.id as string;
  }
  if (!text) return;

  console.log("Processing message from", from, ":", text);
  runSerialized(from, () => handleIncomingMessage(from, text, interactiveId))
    .then((reply) => {
      if (reply === null) return; // engine already sent a reply directly (e.g. greeting buttons)
      console.log("Got reply from conversation engine, length:", reply?.length);
      return sendWhatsAppText(from, reply);
    })
    .catch((err) => console.error("Failed to handle WhatsApp message:", err));
});
