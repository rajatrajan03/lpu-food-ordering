const GRAPH_API_VERSION = "v21.0";

function apiUrl(path: string): string {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/${path}`;
}

/** Sends a free-form text reply. Only valid within the 24h customer-service window. */
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const res = await fetch(apiUrl("messages"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("WhatsApp send failed:", res.status, errText);
  } else {
    console.log("WhatsApp send succeeded, to:", to, "reply len:", body.length);
  }
}

export interface QuickReplyButton {
  id: string;
  title: string; // WhatsApp caps reply button titles at 20 chars
}

/** Sends up to 3 tappable quick-reply buttons alongside a body message. */
export async function sendWhatsAppButtons(to: string, body: string, buttons: QuickReplyButton[]): Promise<void> {
  const res = await fetch(apiUrl("messages"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("WhatsApp button send failed:", res.status, errText);
  } else {
    console.log("WhatsApp button send succeeded, to:", to);
  }
}
