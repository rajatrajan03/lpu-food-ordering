import { Router } from "express";
import { sendWhatsAppText } from "../whatsapp/client";
import { handleIncomingMessage } from "../ai/conversationEngine";

export const webhookRouter = Router();

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
webhookRouter.post("/", (req, res) => {
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
  let text: string | undefined;
  if (message.type === "text") {
    text = message.text?.body as string;
  } else if (message.type === "interactive" && message.interactive?.button_reply) {
    text = message.interactive.button_reply.title as string;
  }
  if (!text) return;

  console.log("Processing message from", from, ":", text);
  handleIncomingMessage(from, text)
    .then((reply) => {
      if (reply === null) return; // engine already sent a reply directly (e.g. greeting buttons)
      console.log("Got reply from conversation engine, length:", reply?.length);
      return sendWhatsAppText(from, reply);
    })
    .catch((err) => console.error("Failed to handle WhatsApp message:", err));
});
