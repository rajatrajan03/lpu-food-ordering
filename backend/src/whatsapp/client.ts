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
  }
}
