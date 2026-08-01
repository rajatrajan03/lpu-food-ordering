import type Groq from "groq-sdk";
import { groq, GROQ_MODEL } from "./groqClient";
import { toolDefinitions, emptySessionState, rememberNames, type SessionState, type CartLine } from "./tools";
import { prisma } from "../lib/prisma";
import * as menuService from "../services/menuService";
import * as orderService from "../services/orderService";

const SYSTEM_PROMPT = `You are the ordering assistant for LPU campus food stalls, talking to a student over WhatsApp.
Rules:
- Never invent menu items, prices, availability, or stall names — always call a tool to look them up.
- A cart can only contain items from one stall. If the student wants a different stall mid-cart, tell them clearly they'll need to check out or clear the current cart first.
- Always show prices when listing items or the cart.
- Before calling place_order, make sure the student has confirmed both the cart contents and the pickup slot.
- Keep replies short and conversational — this is a chat, not a report. Never use markdown tables (WhatsApp renders them as raw "|" characters, not a table) — use a short numbered list instead, and if a search returns many results, mention only the best 4-5 and say there are more if the student wants to narrow it down.
- A "Known references" block may follow with name -> id lookups from earlier in this conversation. Use those ids directly instead of calling a tool again for something you already looked up — but never invent an id that isn't listed there or in a tool result.`;

// Kept deliberately small — Groq's free tier caps at 12k tokens/minute, and
// this history is resent on every single turn.
const MAX_TOOL_ITERATIONS = 5;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 400;

function truncateForHistory(text: string): string {
  return text.length > MAX_HISTORY_MESSAGE_CHARS
    ? text.slice(0, MAX_HISTORY_MESSAGE_CHARS) + "…"
    : text;
}

function getSessionState(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object") return emptySessionState();
  const s = raw as Partial<SessionState>;
  return {
    activeStallId: s.activeStallId,
    cart: s.cart ?? [],
    recentMessages: s.recentMessages ?? [],
    knownStalls: s.knownStalls ?? {},
    knownItems: s.knownItems ?? {},
  };
}

function isToolUseFailedError(err: unknown): boolean {
  const code = (err as { error?: { error?: { code?: string } } })?.error?.error?.code;
  return code === "tool_use_failed";
}

/**
 * Groq's Llama tool-calling occasionally emits a malformed pseudo-call
 * (e.g. `<function=...>`) instead of a real tool_calls response, which the
 * API rejects with a 400 `tool_use_failed`. This is a known, usually
 * transient quirk — retrying the same request almost always succeeds.
 */
async function createChatCompletionWithRetry(
  messages: Groq.Chat.Completions.ChatCompletionMessageParam[],
  attempts = 5,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
      });
    } catch (err) {
      lastErr = err;
      if (!isToolUseFailedError(err)) throw err;
    }
  }
  throw lastErr;
}

function knownReferencesMessage(session: SessionState): Groq.Chat.Completions.ChatCompletionMessageParam | null {
  const hasStalls = Object.keys(session.knownStalls).length > 0;
  const hasItems = Object.keys(session.knownItems).length > 0;
  if (!hasStalls && !hasItems) return null;
  const parts: string[] = ["Known references from earlier in this conversation:"];
  if (hasStalls) parts.push(`Stalls (name -> id): ${JSON.stringify(session.knownStalls)}`);
  if (hasItems) parts.push(`Items (name -> id): ${JSON.stringify(session.knownItems)}`);
  return { role: "system", content: parts.join("\n") };
}

async function findOrCreateStudent(whatsappNumber: string) {
  return prisma.student.upsert({
    where: { whatsappNumber },
    update: { lastActiveAt: new Date() },
    create: { whatsappNumber, sessionState: emptySessionState() as unknown as object },
  });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  studentId: string,
  session: SessionState,
): Promise<unknown> {
  switch (name) {
    case "list_stalls": {
      const stalls = await menuService.listStalls({ area: args.area as string | undefined });
      session.knownStalls = rememberNames(session.knownStalls, stalls.map((s) => [s.name, s.id]));
      return stalls;
    }

    case "search_menu": {
      const items = await menuService.searchMenu({
        query: args.query as string | undefined,
        stallId: (args.stall_id as string | undefined) ?? session.activeStallId,
        categoryName: args.category as string | undefined,
        vegOnly: args.veg_only as boolean | undefined,
      });
      session.knownItems = rememberNames(session.knownItems, items.map((i) => [i.name, i.id]));
      session.knownStalls = rememberNames(session.knownStalls, items.map((i) => [i.stall.name, i.stallId]));
      return items;
    }

    case "view_cart":
      return { cart: session.cart, total: session.cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0) };

    case "add_to_cart": {
      const itemId = args.item_id as string;
      const item = await prisma.menuItem.findUnique({
        where: { id: itemId },
        include: { variants: true },
      });
      if (!item || !item.available) return { error: "That item isn't available." };

      if (session.cart.length > 0 && session.activeStallId && session.activeStallId !== item.stallId) {
        return {
          error:
            "Your cart already has items from a different stall. Place or clear that order first before adding from another stall.",
        };
      }

      let unitPrice = Number(item.basePrice);
      let variantLabel: string | undefined;
      const variantId = args.variant_id as string | undefined;
      if (variantId) {
        const variant = item.variants.find((v) => v.id === variantId && v.available);
        if (!variant) return { error: "That variant isn't available." };
        unitPrice = Number(variant.price);
        variantLabel = variant.label;
      }

      const quantity = Math.max(1, Number(args.quantity) || 1);
      const line: CartLine = { itemId, itemName: item.name, variantId, variantLabel, unitPrice, quantity };
      session.cart.push(line);
      session.activeStallId = item.stallId;
      return { added: line, cart: session.cart };
    }

    case "remove_from_cart": {
      const itemId = args.item_id as string;
      const variantId = args.variant_id as string | undefined;
      session.cart = session.cart.filter((l) => !(l.itemId === itemId && l.variantId === variantId));
      if (session.cart.length === 0) session.activeStallId = undefined;
      return { cart: session.cart };
    }

    case "get_pickup_slots": {
      if (!session.activeStallId) return { error: "Add something to the cart first." };
      const slots = await menuService.getAvailablePickupSlots(session.activeStallId);
      return { slots };
    }

    case "place_order": {
      if (!session.activeStallId || session.cart.length === 0) {
        return { error: "The cart is empty." };
      }
      try {
        const order = await orderService.placeOrder({
          studentId,
          stallId: session.activeStallId,
          pickupSlotId: args.pickup_slot_id as string,
          lines: session.cart.map((l) => ({ menuItemId: l.itemId, variantId: l.variantId, quantity: l.quantity })),
        });
        session.cart = [];
        session.activeStallId = undefined;
        return { order };
      } catch (err) {
        return { error: err instanceof orderService.OrderError ? err.message : "Could not place the order." };
      }
    }

    case "get_order_status":
      return { orders: await orderService.getActiveOrdersForStudent(studentId) };

    case "cancel_order":
      try {
        return { order: await orderService.cancelOrder(args.order_id as string, studentId) };
      } catch (err) {
        return { error: err instanceof orderService.OrderError ? err.message : "Could not cancel the order." };
      }

    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** Runs one WhatsApp message through the model + tool loop and returns the reply text. */
export async function handleIncomingMessage(whatsappNumber: string, text: string): Promise<string> {
  const student = await findOrCreateStudent(whatsappNumber);
  const session = getSessionState(student.sessionState);

  const knownRefs = knownReferencesMessage(session);
  const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(knownRefs ? [knownRefs] : []),
    ...session.recentMessages,
    { role: "user", content: text },
  ];

  let finalReply = "Sorry, something went wrong — please try again.";

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const completion = await createChatCompletionWithRetry(messages);

      const choice = completion.choices[0].message;
      messages.push(choice);

      if (!choice.tool_calls || choice.tool_calls.length === 0) {
        finalReply = choice.content ?? finalReply;
        break;
      }

      for (const call of choice.tool_calls) {
        // Some models emit the literal string "null" for a no-argument call
        // (valid JSON, but JSON.parse("null") === null, not {}) — normalize it.
        const parsed = JSON.parse(call.function.arguments || "{}");
        const args = parsed && typeof parsed === "object" ? parsed : {};
        const result = await executeTool(call.function.name, args, student.id, session);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
  } catch (err) {
    console.error("Conversation engine error:", err);
  }

  // Only the short final exchange is kept long-term — real ids for next turn
  // come from knownStalls/knownItems above, not from replaying tool results.
  // Hard length cap is a safety net independent of the "keep replies short"
  // prompt instruction — one unusually long reply (e.g. a big search result
  // list) shouldn't be able to blow the token budget for the next several turns.
  session.recentMessages = [
    ...session.recentMessages,
    { role: "user" as const, content: truncateForHistory(text) },
    { role: "assistant" as const, content: truncateForHistory(finalReply) },
  ].slice(-MAX_HISTORY_MESSAGES);

  await prisma.student.update({
    where: { id: student.id },
    data: { sessionState: session as unknown as object },
  });

  return finalReply;
}
