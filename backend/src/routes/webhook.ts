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

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];
  if (!message || message.type !== "text") return;

  const from = message.from as string;
  const text = message.text?.body as string;

  handleIncomingMessage(from, text)
    .then((reply) => sendWhatsAppText(from, reply))
    .catch((err) => console.error("Failed to handle WhatsApp message:", err));
});
