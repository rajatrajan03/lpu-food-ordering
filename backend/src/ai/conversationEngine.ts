import type { Content, Part } from "@google/genai";
import { genAI, GEMINI_MODEL } from "./geminiClient";
import {
  toolDefinitions,
  emptySessionState,
  rememberNames,
  type SessionState,
  type CartLine,
  type SmartFlowState,
  type UsualItemRef,
} from "./tools";
import { prisma } from "../lib/prisma";
import * as menuService from "../services/menuService";
import * as orderService from "../services/orderService";
import * as studentService from "../services/studentService";
import * as preferenceService from "../services/preferenceService";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList, type ListRow } from "../whatsapp/client";

// Gemini's function-calling format wants {name, description, parametersJsonSchema}
// rather than the OpenAI-style {type:"function", function:{...}} shape the tool
// definitions are written in — parametersJsonSchema accepts raw JSON Schema
// as-is, so no deeper conversion of the parameter definitions is needed.
const GEMINI_TOOLS = [
  {
    functionDeclarations: toolDefinitions.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parametersJsonSchema: t.function.parameters,
    })),
  },
];

const GREETING_PATTERN = /^(hi+|hello+|hey+|hlo|yo|start|menu)\b/i;
const GREETING_TEXT =
  "Hi! 👋 I'm the LPU Food ordering assistant. Just tell me what you're craving, or tap an option below.";

const SYSTEM_PROMPT = `You are the ordering assistant for LPU campus food stalls, talking to a student over WhatsApp.
Rules:
- Never invent menu items, prices, availability, or stall names — always call a tool to look them up.
- Never invent or embellish a stall's location. A stall's location is exactly its area and block fields as returned by a tool — nothing else. Never claim a stall is "actually in X, not Y" or state any location detail that isn't literally one of those two field values.
- When the student names a food or craving (e.g. "icecream", "burger"), always pass that word as search_menu's query field. A craving means "find me that food", not "show me everything this stall sells."
- When the craving comes with a location ("chai near CC", "burger near boys hostel"), pass BOTH query and area/block to search_menu in that ONE call. Never fall back to list_stalls-by-area for a craving request — that returns every stall in the area regardless of whether they serve what was asked for, which is wrong.
- When the student names a specific stall by its proper name (e.g. "Chai Sutta Bar", "Khao Piyo") — especially one you don't already have the id for — call list_stalls with that name as the query field to look it up directly. Do NOT ask them what area/block it's in first; that's a search_menu-vs-list_stalls mixup, not something you need to ask about. Once you have its id (from this call, a prior tool result, or Known references), scope search_menu to that stall_id.
- If the student says "different", "something else", "other options", or similar after you've already shown a list, NEVER show the same items again — call search_menu again with the exact same query/stall_id/etc. plus the offset field set to how many items you already showed, so they see a new batch. If that comes back empty, say so plainly instead of repeating the old list.
- A cart can only contain items from one stall. If the student wants a different stall mid-cart, tell them clearly they'll need to check out or clear the current cart first.
- Always show prices when listing items or the cart.
- After calling get_pickup_slots, do NOT list out the slot times yourself — a tappable time picker is sent separately right after your reply. Just say something short like "Pick a pickup time below." and stop. Once the student replies with a time (typed or tapped), resolve it to a pickup_slot_id from Known references' "Pickup slots" map — do NOT call get_pickup_slots again just to re-look-up a time you already showed; only call it again if the student is starting a fresh checkout for a different stall/cart.
- If the student sends something unrelated to picking a slot while one is pending (e.g. "remove it", changing an item), handle that request directly — removing/changing a cart item never requires re-fetching pickup slots.
- Before calling place_order, show a one-line order summary (items, total, slot time) and wait for an explicit yes. Never call place_order on the same turn you first show the summary.
- After place_order succeeds, confirm with the order id (short form), slot time, and total in one short line.
- If a search returns nothing, or an item/variant/slot turns out unavailable, don't just say "not available" — make ONE more tool call to find a close alternative (broader query, different stall, next open slot) before replying.
- When the student names a specific pickup time, pass it as get_pickup_slots' preferred_time (24-hour HH:MM). If the nearest available slot is still far from what they asked (e.g. they said 6pm and the closest is 1pm), say plainly that nothing's available near that time and show what's closest instead — don't just dump the full day's slots as if that's what they asked for.
- "My order history" / "my past orders" -> call get_order_history. "Repeat my last order" / "same as last time" -> call repeat_last_order directly (don't manually look up and re-add items one by one) — it fills the cart from their most recent order and tells you if anything from it is no longer available, which you should mention.
- BE EXTREMELY BRIEF. This is a WhatsApp chat, not a report: 1–3 short lines of text plus a list when needed, nothing more. Never restate the student's question back to them, never add filler like "let me know if you need anything else" or "just say the word", never explain what you're about to do — just do it and show the result. Never use markdown tables — use a short numbered list instead. For a list of results, show at most 4–5 items and stop; do not add a trailing invitation sentence beyond one short "more?" style prompt if truly needed.
- A "Known references" block may follow with name -> id lookups from earlier in this conversation. Use those ids directly instead of calling a tool again for something you already looked up — but never invent an id that isn't listed there or in a tool result. This also covers references like "the first one" or "that one", or a bare number like "2" after you've numbered a list — resolve them yourself from what you just listed, don't ask the student to repeat themselves.
- NEVER show raw database ids to the student, and NEVER repeat or summarize the "Known references" block back in your reply — that block is for your own internal use only, the student must never see it or anything resembling it. When listing stalls or items, number them (1, 2, 3...) and show just the name/area/price; the student will reply by number or name, and you resolve that yourself using the Known references or the numbered list you just sent.
- You only have student-facing tools. Never claim to change stall settings, menus, or other students' orders — that's outside what you can do here.`;

// Gemini's free tier has far more headroom than Groq's did, so this can be
// generous — a multi-step flow (look up stall -> search its menu -> resolve
// a cart conflict) can legitimately need several tool calls in one turn.
const MAX_TOOL_ITERATIONS = 8;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 400;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Safety net for the "never show raw ids" prompt rule — smaller free-tier
 * models occasionally echo the internal "Known references" block straight
 * into their reply instead of just using it. Strip that out at the code
 * level rather than trusting the prompt alone, since a leaked WhatsApp
 * message reaches a real student before anyone can catch a prompt failure.
 */
function stripLeakedIds(text: string): string {
  const cutIndex = text.search(/known references/i);
  const withoutRefBlock = cutIndex === -1 ? text : text.slice(0, cutIndex);
  return withoutRefBlock
    .split("\n")
    .filter((line) => !UUID_PATTERN.test(line))
    .join("\n")
    .trim();
}

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
    knownSlots: s.knownSlots ?? {},
    smartFlow: s.smartFlow,
  };
}

/** Gemini's quota errors surface as HTTP 429 (RESOURCE_EXHAUSTED) — worth a
 * distinct, friendlier reply since "something went wrong" reads like a real
 * bug, not "try again shortly." */
function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: number })?.status ?? (err as { code?: number })?.code;
  const message = String((err as { message?: string })?.message ?? "");
  return status === 429 || /RESOURCE_EXHAUSTED|rate.?limit/i.test(message);
}

/** Transient network/5xx errors are worth one blind retry before giving up. */
async function generateContentWithRetry(contents: Content[], systemInstruction: string, attempts = 3) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction, tools: GEMINI_TOOLS },
      });
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err)) throw err;
    }
  }
  throw lastErr;
}

function knownReferencesText(session: SessionState): string {
  const hasStalls = Object.keys(session.knownStalls).length > 0;
  const hasItems = Object.keys(session.knownItems).length > 0;
  const hasSlots = Object.keys(session.knownSlots).length > 0;
  if (!hasStalls && !hasItems && !hasSlots) return "";
  const parts: string[] = ["\n\nKnown references from earlier in this conversation:"];
  if (hasStalls) parts.push(`Stalls (name -> id): ${JSON.stringify(session.knownStalls)}`);
  if (hasItems) parts.push(`Items (name -> id): ${JSON.stringify(session.knownItems)}`);
  if (hasSlots) parts.push(`Pickup slots (time range -> id): ${JSON.stringify(session.knownSlots)}`);
  return parts.join("\n");
}

/** Formats a Prisma @db.Time value (returned as a Date on 1970-01-01) as "9:00 AM". */
function formatSlotTime(t: Date): string {
  return new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Populated by the get_pickup_slots case so the caller can follow up with a tappable list. */
interface ToolSideEffects {
  pickupSlotRows?: ListRow[];
}

// ---------------------------------------------------------------------------
// Smart Personalized Ordering Flow — a deterministic wizard (not AI tool
// calls) triggered when a returning student messages during their usual
// meal period and has a learned "usual order". Kept separate from the
// tool-calling loop for the same reason onboarding is: each step's buttons
// must reflect exact DB state (their real preferred area, the real stalls
// that actually have every item), which the model can't be trusted to get
// exactly right from free text.
// ---------------------------------------------------------------------------

const MEAL_PERIOD_LABEL: Record<string, string> = {
  breakfast: "breakfast",
  lunch: "lunch",
  snacks: "snack",
  dinner: "dinner",
};

function formatUsualOrder(items: UsualItemRef[]): string {
  return items.map((i) => `${i.quantity}x ${i.itemName}`).join(", ");
}

/** True only when it's the student's own usual meal period AND they have a learned "usual order" to offer. */
async function eligibleForSmartSuggestion(studentId: string): Promise<{ items: UsualItemRef[]; preferredArea: string | null; mealLabel: string } | null> {
  const pref = await preferenceService.getPreferences(studentId);
  if (!pref || !pref.usualOrderItems) return null;
  if (pref.favoriteMealPeriod && pref.favoriteMealPeriod !== preferenceService.currentMealPeriod()) return null;
  const items = pref.usualOrderItems as unknown as UsualItemRef[];
  if (!items.length) return null;
  return {
    items,
    preferredArea: pref.preferredArea,
    mealLabel: pref.favoriteMealPeriod ? MEAL_PERIOD_LABEL[pref.favoriteMealPeriod] : "usual",
  };
}

async function startSmartSuggestion(
  whatsappNumber: string,
  session: SessionState,
  suggestion: { items: UsualItemRef[]; preferredArea: string | null; mealLabel: string },
): Promise<void> {
  await sendWhatsAppButtons(
    whatsappNumber,
    `It's your usual ${suggestion.mealLabel} time! Want your usual — ${formatUsualOrder(suggestion.items)}?`,
    [
      { id: "usual_yes", title: "Yes, that's it" },
      { id: "usual_no", title: "No, something else" },
    ],
  );
  session.smartFlow = {
    stage: "awaiting_usual_confirm",
    usualItems: suggestion.items,
    preferredArea: suggestion.preferredArea ?? undefined,
  };
}

async function sendAreaList(whatsappNumber: string): Promise<void> {
  const areas = await menuService.listDistinctAreas();
  if (areas.length === 0) {
    await sendWhatsAppText(whatsappNumber, "No pickup locations are available right now.");
    return;
  }
  await sendWhatsAppList(
    whatsappNumber,
    "Pick a campus location:",
    "Choose location",
    areas.slice(0, 10).map((a) => ({ id: a, title: a })),
  );
}

async function resolveAreaAndShowStalls(
  whatsappNumber: string,
  session: SessionState,
  flow: SmartFlowState,
  area: string,
): Promise<void> {
  const itemNames = flow.usualItems.map((i) => i.itemName);
  const stalls = await menuService.findStallsWithAllItems(area, itemNames);
  if (stalls.length === 0) {
    await sendWhatsAppText(
      whatsappNumber,
      `No stall near ${area} has your full usual order right now — want to browse instead? Just tell me what you're craving.`,
    );
    session.smartFlow = undefined;
    return;
  }
  flow.matchedStalls = stalls.map((s) => ({ id: s.id, name: s.name, block: s.block }));
  flow.stage = "awaiting_stall";
  session.knownStalls = rememberNames(session.knownStalls, stalls.map((s) => [s.name, s.id]));
  await sendWhatsAppList(
    whatsappNumber,
    "These stalls have your full usual order:",
    "Choose stall",
    flow.matchedStalls.map((s) => ({ id: s.id, title: s.name, description: s.block })),
  );
}

/** Fills the cart from the usual-order item names, re-priced against the chosen stall's current menu. */
async function buildCartFromUsualOrder(
  whatsappNumber: string,
  session: SessionState,
  stallId: string,
  usualItems: UsualItemRef[],
): Promise<void> {
  const menuItems = await prisma.menuItem.findMany({
    where: { stallId, available: true, name: { in: usualItems.map((i) => i.itemName) } },
  });
  const byName = new Map(menuItems.map((m) => [m.name.toLowerCase(), m]));
  const cart: CartLine[] = [];
  for (const u of usualItems) {
    const item = byName.get(u.itemName.toLowerCase());
    if (!item) continue; // defensive — findStallsWithAllItems already verified this, but menus can change mid-flow
    cart.push({ itemId: item.id, itemName: item.name, unitPrice: Number(item.basePrice), quantity: u.quantity });
  }
  if (cart.length === 0) {
    await sendWhatsAppText(whatsappNumber, "Hmm, those items just went unavailable there — tell me what you'd like instead.");
    return;
  }
  session.cart = cart;
  session.activeStallId = stallId;
  session.knownItems = rememberNames(session.knownItems, cart.map((c) => [c.itemName, c.itemId]));
  const total = cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const lines = cart.map((l) => `${l.quantity}x ${l.itemName} — ₹${l.unitPrice * l.quantity}`).join("\n");
  await sendWhatsAppText(
    whatsappNumber,
    `Added your usual order:\n${lines}\nTotal: ₹${total}\n\nReply to add more, remove items, or say "checkout" when ready.`,
  );
}

/** Advances the wizard by one step given the student's reply; always sends directly (never returns text). */
async function handleSmartFlowStep(whatsappNumber: string, text: string, session: SessionState): Promise<void> {
  const flow = session.smartFlow!;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (flow.stage === "awaiting_usual_confirm") {
    const declined = /\bno\b/.test(lower) || lower.includes("something else");
    const accepted = !declined && /\b(yes|usual|same|sure|ok(ay)?|yeah|yep)\b/.test(lower);
    if (!accepted) {
      session.smartFlow = undefined;
      await sendWhatsAppText(whatsappNumber, "No worries! What would you like today?");
      return;
    }
    if (flow.preferredArea) {
      await sendWhatsAppButtons(whatsappNumber, "Where would you like to pick up your order?", [
        { id: "pickup_preferred", title: `Near ${flow.preferredArea}`.slice(0, 20) },
        { id: "pickup_other", title: "Other Location" },
      ]);
      flow.stage = "awaiting_pickup_location";
    } else {
      await sendAreaList(whatsappNumber);
      flow.stage = "awaiting_area_pick";
    }
    return;
  }

  if (flow.stage === "awaiting_pickup_location") {
    if (/other/i.test(trimmed)) {
      await sendAreaList(whatsappNumber);
      flow.stage = "awaiting_area_pick";
      return;
    }
    await resolveAreaAndShowStalls(whatsappNumber, session, flow, flow.preferredArea!);
    return;
  }

  if (flow.stage === "awaiting_area_pick") {
    await resolveAreaAndShowStalls(whatsappNumber, session, flow, trimmed);
    return;
  }

  if (flow.stage === "awaiting_stall") {
    const stall =
      flow.matchedStalls?.find((s) => s.id === trimmed || s.name.toLowerCase() === lower) ?? null;
    if (!stall) {
      await sendWhatsAppText(whatsappNumber, "Sorry, please pick one of the stalls from the list above.");
      return;
    }
    await buildCartFromUsualOrder(whatsappNumber, session, stall.id, flow.usualItems);
    session.smartFlow = undefined;
    return;
  }

  session.smartFlow = undefined;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  studentId: string,
  session: SessionState,
  sideEffects: ToolSideEffects,
): Promise<unknown> {
  switch (name) {
    case "list_stalls": {
      const stalls = await menuService.listStalls({
        area: args.area as string | undefined,
        query: args.query as string | undefined,
        offset: (args.offset as number | undefined) ?? 0,
      });
      session.knownStalls = rememberNames(session.knownStalls, stalls.map((s) => [s.name, s.id]));
      // Trimmed to just what the model needs to talk about a stall — the full
      // Prisma row (openingHours, pickupNote, createdAt, status...) was the
      // single biggest contributor to blowing Groq's free-tier token budget,
      // especially on an unscoped "browse everything" call.
      return stalls.map((s) => ({ id: s.id, name: s.name, area: s.area, block: s.block }));
    }

    case "search_menu": {
      const items = await menuService.searchMenu({
        query: args.query as string | undefined,
        stallId: (args.stall_id as string | undefined) ?? session.activeStallId,
        area: args.area as string | undefined,
        block: args.block as string | undefined,
        categoryName: args.category as string | undefined,
        vegOnly: args.veg_only as boolean | undefined,
        offset: (args.offset as number | undefined) ?? 0,
      });
      session.knownItems = rememberNames(session.knownItems, items.map((i) => [i.name, i.id]));
      session.knownStalls = rememberNames(session.knownStalls, items.map((i) => [i.stall.name, i.stallId]));
      // Same trim as list_stalls — drop the nested full stall/category rows
      // and only keep the fields the model actually needs to answer with.
      return items.map((i) => ({
        id: i.id,
        name: i.name,
        price: Number(i.basePrice),
        veg: i.isVeg,
        stallId: i.stallId,
        stallName: i.stall.name,
        variants: i.variants.map((v) => ({ id: v.id, label: v.label, price: Number(v.price) })),
      }));
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
      const preferredTime = args.preferred_time as string | undefined;
      const match = preferredTime?.match(/^(\d{1,2}):(\d{2})$/);
      const preferredMinutes = match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
      const slots = await menuService.getAvailablePickupSlots(session.activeStallId, { preferredMinutes });
      const labeled = slots.map((s) => ({
        id: s.id,
        time: `${formatSlotTime(s.startTime)} – ${formatSlotTime(s.endTime)}`,
      }));
      sideEffects.pickupSlotRows = labeled.map((s) => ({ id: s.id, title: s.time }));
      session.knownSlots = rememberNames(session.knownSlots, labeled.map((s) => [s.time, s.id]));
      return { slots: labeled };
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

    case "get_order_history": {
      const orders = await orderService.getOrderHistoryForStudent(studentId);
      session.knownStalls = rememberNames(session.knownStalls, orders.map((o) => [o.stall.name, o.stallId]));
      return {
        orders: orders.map((o) => ({
          id: o.id,
          status: o.status,
          stall: o.stall.name,
          placedAt: o.placedAt,
          total: Number(o.totalAmount),
          items: o.items.map((i) => `${i.quantity}x ${i.itemNameSnapshot}`),
        })),
      };
    }

    case "repeat_last_order": {
      const [lastOrder] = await orderService.getOrderHistoryForStudent(studentId, 1);
      if (!lastOrder) return { error: "No past orders to repeat." };

      const menuItems = await prisma.menuItem.findMany({
        where: { id: { in: lastOrder.items.map((i) => i.menuItemId) } },
        include: { variants: true },
      });
      const byId = new Map(menuItems.map((m) => [m.id, m]));

      const newCart: CartLine[] = [];
      const skipped: string[] = [];
      for (const line of lastOrder.items) {
        const item = byId.get(line.menuItemId);
        if (!item || !item.available) {
          skipped.push(line.itemNameSnapshot);
          continue;
        }
        let unitPrice = Number(item.basePrice);
        let variantLabel: string | undefined;
        if (line.variantId) {
          const variant = item.variants.find((v) => v.id === line.variantId && v.available);
          if (!variant) {
            skipped.push(line.itemNameSnapshot);
            continue;
          }
          unitPrice = Number(variant.price);
          variantLabel = variant.label;
        }
        newCart.push({
          itemId: item.id,
          itemName: item.name,
          variantId: line.variantId ?? undefined,
          variantLabel,
          unitPrice,
          quantity: line.quantity,
        });
      }

      if (newCart.length === 0) return { error: "None of the items from that order are available anymore." };

      session.cart = newCart;
      session.activeStallId = lastOrder.stallId;
      session.knownStalls = rememberNames(session.knownStalls, [[lastOrder.stall.name, lastOrder.stallId]]);
      return { cart: newCart, stall: lastOrder.stall.name, skipped };
    }

    default:
      return { error: `Unknown tool ${name}` };
  }
}

/**
 * Runs one WhatsApp message through the model + tool loop and returns the reply text.
 * Returns null when the reply was already sent directly (e.g. the greeting's quick-reply
 * buttons) — the caller should not send anything further for that turn.
 */
export async function handleIncomingMessage(whatsappNumber: string, text: string): Promise<string | null> {
  const { student: found, isNewStudent } = await studentService.findOrCreateStudent(whatsappNumber);
  let student = found;

  // Three-step onboarding gate, driven entirely by what's still missing on
  // the row rather than a separate transient "step" flag — resilient to a
  // student going quiet mid-onboarding and coming back days later; whichever
  // field is still null tells us exactly what this message is answering.
  if (isNewStudent) {
    await sendWhatsAppText(whatsappNumber, studentService.WELCOME_TEXT);
    return null;
  }
  if (!student.registrationNumber) {
    await studentService.saveRegistrationNumber(student.id, text);
    await sendWhatsAppText(whatsappNumber, studentService.ASK_NAME_TEXT);
    return null;
  }
  if (!student.name) {
    student = await studentService.saveName(student.id, text);
    await studentService.touchLastSeen(student.id);
    await sendWhatsAppText(whatsappNumber, studentService.onboardedConfirmationText(student.name!));
    return null;
  }

  // Fully onboarded — compute the return greeting from the *previous* visit
  // before touching lastSeen, then record this visit.
  const returnGreeting = studentService.greetingForReturn(student.lastSeen, student.name);
  await studentService.touchLastSeen(student.id);
  if (returnGreeting) await sendWhatsAppText(whatsappNumber, returnGreeting);

  const session = getSessionState(student.sessionState);

  // A smart-suggestion wizard step in progress takes priority over
  // everything else — "yes"/an area name/a stall name only make sense in
  // that context and would otherwise confuse the greeting check or the AI.
  if (session.smartFlow) {
    await handleSmartFlowStep(whatsappNumber, text, session);
    await prisma.student.update({ where: { id: student.id }, data: { sessionState: session as unknown as object } });
    return null;
  }

  // Trigger on any bare greeting, not just the very first message ever —
  // otherwise "hi" sent mid-conversation just continues whatever topic was
  // last discussed instead of giving a fresh start, which reads as broken.
  if (GREETING_PATTERN.test(text.trim())) {
    const suggestion = await eligibleForSmartSuggestion(student.id);
    if (suggestion) {
      await startSmartSuggestion(whatsappNumber, session, suggestion);
      session.recentMessages = [
        { role: "user" as const, content: truncateForHistory(text) },
        { role: "assistant" as const, content: `Suggested usual order: ${formatUsualOrder(suggestion.items)}` },
      ];
    } else {
      await sendWhatsAppButtons(whatsappNumber, GREETING_TEXT, [
        { id: "browse_stalls", title: "Browse stalls" },
        { id: "track_order", title: "Track my order" },
        { id: "help", title: "Help" },
      ]);
      session.recentMessages = [
        { role: "user" as const, content: truncateForHistory(text) },
        { role: "assistant" as const, content: GREETING_TEXT },
      ];
    }
    await prisma.student.update({
      where: { id: student.id },
      data: { sessionState: session as unknown as object },
    });
    return null;
  }

  const nameContext = student.name ? `\n\nThe student's name is ${student.name} — you may address them by name occasionally (e.g. in a greeting), but don't overuse it.` : "";
  const systemInstruction = SYSTEM_PROMPT + nameContext + knownReferencesText(session);
  const contents: Content[] = [
    ...session.recentMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text }] },
  ];

  let finalReply = "Sorry, something went wrong — please try again.";
  let convergedToText = false;
  const sideEffects: ToolSideEffects = {};

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await generateContentWithRetry(contents, systemInstruction);

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) {
        finalReply = response.text ?? finalReply;
        convergedToText = true;
        break;
      }

      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);

      const responseParts: Part[] = [];
      for (const call of calls) {
        const result = await executeTool(call.name ?? "", call.args ?? {}, student.id, session, sideEffects);
        responseParts.push({ functionResponse: { name: call.name, response: { result } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }
    if (!convergedToText) {
      // Hit MAX_TOOL_ITERATIONS without the model ever giving a plain-text
      // answer — visible in logs so a recurring pattern here (rather than a
      // one-off) is easy to spot, distinct from an actual thrown error.
      console.error(`Conversation engine: exhausted ${MAX_TOOL_ITERATIONS} tool iterations without a final reply`);
      finalReply = "Let's take that one step at a time — what would you like to do?";
    }
  } catch (err) {
    console.error("Conversation engine error:", err);
    if (isRateLimitError(err)) {
      finalReply = "I'm getting a lot of requests right now — give me about a minute and try again 🙏";
    }
  }

  finalReply = stripLeakedIds(finalReply);

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

  // Follow the text reply with a tappable slot picker instead of making the
  // student type back a number/time by hand.
  if (sideEffects.pickupSlotRows?.length) {
    await sendWhatsAppList(whatsappNumber, "Pick a pickup time:", "Choose a slot", sideEffects.pickupSlotRows);
  }

  return finalReply;
}
