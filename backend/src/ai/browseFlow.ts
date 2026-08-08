import { prisma } from "../lib/prisma";
import * as menuService from "../services/menuService";
import * as orderService from "../services/orderService";
import * as preferenceService from "../services/preferenceService";
import * as ratingService from "../services/ratingService";
import { rememberNames, type SessionState, type CartLine, type BrowseScreen } from "./tools";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppList, type ListRow } from "../whatsapp/client";

// ---------------------------------------------------------------------------
// Button-first navigation: Home -> Browse Stalls -> location -> stall ->
// category -> items -> item detail, plus a flat "More" menu. A deterministic
// wizard for the same reason smartFlow/onboarding are: buttons/lists at every
// step must reflect exact DB state, which free-text AI generation can't be
// trusted to get exactly right. Falls through to the AI loop whenever the
// student's reply doesn't match an expected option, so search/questions keep
// working mid-browse.
// ---------------------------------------------------------------------------

export const HOME_BUTTON_IDS = { browse: "home_browse", forYou: "home_foryou", more: "home_more" };
export const MORE_ROW_IDS = {
  cart: "more_cart",
  track: "more_track",
  recent: "more_recent",
  fav: "more_fav",
  profile: "more_profile",
  help: "more_help",
};
const NAV_BACK = "nav_back";
const NAV_HOME = "nav_home";
const POST_ADD_CONTINUE_ID = "post_add_continue";
const POST_ADD_CART_ID = "post_add_cart";
const POST_ADD_CHECKOUT_ID = "post_add_checkout";

/** Formats a Prisma @db.Time value as "9:00 AM" in IST — the production server runs in UTC. */
function formatSlotTime(t: Date): string {
  return new Date(t).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

const ORDER_STATUS_EMOJI: Partial<Record<string, string>> = {
  placed: "🕐",
  accepted: "✅",
  preparing: "👨‍🍳",
  ready: "🎉",
  completed: "✔️",
  cancelled: "❌",
  rejected: "🚫",
};

type ActiveOrder = Awaited<ReturnType<typeof orderService.getActiveOrdersForStudent>>[number];

/** One order's full status block — stall, items, total, IST pickup time, status. */
export function buildOrderStatusBlock(o: ActiveOrder): string {
  const items = o.items.map((i) => `${i.quantity}x ${i.itemNameSnapshot}`).join(", ");
  const pickupTime = `${formatSlotTime(o.pickupSlot.startTime)} – ${formatSlotTime(o.pickupSlot.endTime)}`;
  const emoji = ORDER_STATUS_EMOJI[o.status] ?? "📦";
  return `${emoji} #${o.displayId} — ${o.stall.name}\n${items}\nTotal: ₹${Number(o.totalAmount)}\nPickup: ${pickupTime}\nStatus: ${o.status}`;
}

export const ORDER_STATUS_PICK_PREFIX = "order_status:";

/** List rows for picking which active order to check, when there's more than one at once. Keyed on the internal id — displayId is shown, never used as a lookup key. */
export function buildOrderStatusRows(orders: ActiveOrder[]): ListRow[] {
  return orders.map((o) => ({
    id: `${ORDER_STATUS_PICK_PREFIX}${o.id}`,
    title: `#${o.displayId} - ${o.stall.name}`.slice(0, 24),
    description: o.status,
  }));
}

/** Sends the single order's status directly, or (if more than one is active) a picker list first. */
export async function sendOrderStatus(whatsappNumber: string, studentId: string): Promise<void> {
  const orders = await orderService.getActiveOrdersForStudent(studentId);
  if (orders.length === 0) {
    await sendWhatsAppText(whatsappNumber, "You have no active orders right now.");
    return;
  }
  if (orders.length === 1) {
    await sendWhatsAppText(whatsappNumber, buildOrderStatusBlock(orders[0]));
    return;
  }
  await sendWhatsAppList(
    whatsappNumber,
    "You have multiple active orders — which one?",
    "Choose order",
    buildOrderStatusRows(orders),
  );
}

/** Handles a tap on an order-status picker row. Returns false if `id` isn't one of them. */
export async function handleOrderStatusPick(whatsappNumber: string, id: string, studentId: string): Promise<boolean> {
  if (!id.startsWith(ORDER_STATUS_PICK_PREFIX)) return false;
  const orderId = id.slice(ORDER_STATUS_PICK_PREFIX.length);
  const orders = await orderService.getActiveOrdersForStudent(studentId);
  const order = orders.find((o) => o.id === orderId);
  if (!order) {
    await sendWhatsAppText(whatsappNumber, "That order isn't active anymore.");
    return true;
  }
  await sendWhatsAppText(whatsappNumber, buildOrderStatusBlock(order));
  return true;
}

export async function sendHomeScreen(whatsappNumber: string, name: string | null, session: SessionState): Promise<void> {
  session.browseFlow = undefined;
  const greetName = name ? `, ${name}` : "";
  await sendWhatsAppButtons(whatsappNumber, `👋 Welcome back${greetName}!`, [
    { id: HOME_BUTTON_IDS.browse, title: "🍽 Browse Stalls" },
    { id: HOME_BUTTON_IDS.forYou, title: "✨ For You" },
    { id: HOME_BUTTON_IDS.more, title: "☰ More" },
  ]);
}

export const POST_ORDER_TRACK_ID = "post_track";
export const POST_ORDER_CANCEL_PREFIX = "post_cancel:";

/** Sent right after a successful place_order confirmation — gives an immediate next step instead of leaving the student to type. */
export async function sendPostOrderActions(whatsappNumber: string, orderId: string): Promise<void> {
  await sendWhatsAppButtons(whatsappNumber, "What would you like to do next?", [
    { id: POST_ORDER_TRACK_ID, title: "📦 Track Order" },
    { id: `${POST_ORDER_CANCEL_PREFIX}${orderId}`, title: "❌ Cancel Order" },
  ]);
}

/** Shared cart-summary text — used by the More menu's View Cart row and the post-add-to-cart prompt. */
function buildCartSummary(session: SessionState): string {
  if (session.cart.length === 0) return "Your cart is empty.";
  const total = session.cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const lines = session.cart.map((l) => `${l.quantity}x ${l.itemName} — ₹${l.unitPrice * l.quantity}`).join("\n");
  return `🛒 Your cart:\n${lines}\nTotal: ₹${total}`;
}

/**
 * Deterministic checkout for the post-add Checkout button — sends the
 * pickup-slot picker directly via menuService rather than routing "Checkout"
 * through the AI as free text. The AI has occasionally misread that exact
 * button title as an unrelated food query; a critical action like this
 * shouldn't depend on the model correctly interpreting a button label.
 * The student's next reply (a tapped/typed slot) still resolves through the
 * normal AI loop via knownSlots, same as the AI-driven get_pickup_slots path.
 */
async function sendCheckoutPickupSlots(whatsappNumber: string, session: SessionState): Promise<void> {
  if (!session.activeStallId || session.cart.length === 0) {
    await sendWhatsAppText(whatsappNumber, "Your cart is empty — add something first.");
    return;
  }
  const slots = await menuService.getAvailablePickupSlots(session.activeStallId);
  if (slots.length === 0) {
    await sendWhatsAppText(whatsappNumber, "No pickup slots are available right now — please try again shortly.");
    return;
  }
  const labeled = slots.map((s) => ({
    id: s.id,
    time: `${formatSlotTime(s.startTime)} – ${formatSlotTime(s.endTime)}`,
  }));
  session.knownSlots = rememberNames(session.knownSlots, labeled.map((s) => [s.time, s.id]));
  const rows: ListRow[] = labeled.map((s) => ({ id: s.id, title: s.time }));
  session.browseFlow = undefined;
  await sendWhatsAppList(whatsappNumber, "Pick a pickup time:", "Choose a slot", rows);
}

/** Sent right after Add To Cart — an explicit next step instead of silently dropping back into the item list. */
async function sendPostAddButtons(whatsappNumber: string): Promise<void> {
  await sendWhatsAppButtons(whatsappNumber, "What would you like to do next?", [
    { id: POST_ADD_CONTINUE_ID, title: "➕ Add More" },
    { id: POST_ADD_CART_ID, title: "🛒 View Cart" },
    { id: POST_ADD_CHECKOUT_ID, title: "✅ Checkout" },
  ]);
}

export async function sendMoreMenu(whatsappNumber: string): Promise<void> {
  const rows: ListRow[] = [
    { id: MORE_ROW_IDS.cart, title: "🛒 View Cart" },
    { id: MORE_ROW_IDS.track, title: "📦 Track Order" },
    { id: MORE_ROW_IDS.recent, title: "🕒 Recent Orders" },
    { id: MORE_ROW_IDS.fav, title: "⭐ Favorite Stalls" },
    { id: MORE_ROW_IDS.profile, title: "👤 My Profile" },
    { id: MORE_ROW_IDS.help, title: "❓ Help" },
    { id: NAV_HOME, title: "🏠 Home" },
  ];
  await sendWhatsAppList(whatsappNumber, "More options:", "Choose", rows);
}

/** Handles a tap on a More-menu row. Returns false if `id` isn't one of them (e.g. Home, handled by the caller). */
export async function handleMoreSelection(
  whatsappNumber: string,
  id: string,
  studentId: string,
  session: SessionState,
): Promise<boolean> {
  switch (id) {
    case MORE_ROW_IDS.cart: {
      const summary = buildCartSummary(session);
      const suffix = session.cart.length > 0 ? '\n\nSay "checkout" when ready.' : "";
      await sendWhatsAppText(whatsappNumber, summary + suffix);
      return true;
    }
    case MORE_ROW_IDS.track: {
      await sendOrderStatus(whatsappNumber, studentId);
      return true;
    }
    case MORE_ROW_IDS.recent: {
      const orders = await orderService.getOrderHistoryForStudent(studentId, 5);
      if (orders.length === 0) {
        await sendWhatsAppText(whatsappNumber, "No past orders yet.");
        return true;
      }
      const lines = orders.map((o) => `${o.stall.name} — ₹${Number(o.totalAmount)} — ${o.status}`).join("\n");
      await sendWhatsAppText(whatsappNumber, `🕒 Recent orders:\n${lines}`);
      return true;
    }
    case MORE_ROW_IDS.fav: {
      const pref = await preferenceService.getPreferences(studentId);
      if (!pref?.favoriteStall) {
        await sendWhatsAppText(whatsappNumber, "No favorite stall yet — order a bit more and I'll learn it!");
        return true;
      }
      await sendWhatsAppText(whatsappNumber, `⭐ Your favorite stall: ${pref.favoriteStall.name}`);
      return true;
    }
    case MORE_ROW_IDS.profile: {
      const student = await prisma.student.findUnique({ where: { id: studentId } });
      await sendWhatsAppText(whatsappNumber, `👤 ${student?.name ?? "—"}\nReg No: ${student?.registrationNumber ?? "—"}`);
      return true;
    }
    case MORE_ROW_IDS.help: {
      await sendWhatsAppText(
        whatsappNumber,
        '❓ Tell me what you\'re craving, or use Browse Stalls / For You from the Home menu. You can always type "home" or "back".',
      );
      return true;
    }
    default:
      return false;
  }
}

function enterScreen(session: SessionState, screen: BrowseScreen): void {
  if (!session.browseFlow) {
    session.browseFlow = { current: screen, stack: [] };
    return;
  }
  session.browseFlow.stack.push(session.browseFlow.current);
  session.browseFlow.current = screen;
}

function addDetailToCart(session: SessionState, detail: Extract<BrowseScreen, { screen: "item_detail" }>): void {
  const existing = session.cart.find((l) => l.itemId === detail.itemId && !l.variantId);
  if (existing) existing.quantity += detail.quantity;
  else {
    const line: CartLine = {
      itemId: detail.itemId,
      itemName: detail.itemName,
      unitPrice: detail.unitPrice,
      quantity: detail.quantity,
    };
    session.cart.push(line);
  }
  session.activeStallId = detail.stallId;
  session.knownItems = rememberNames(session.knownItems, [[detail.itemName, detail.itemId]]);
}

function goBack(session: SessionState): BrowseScreen | null {
  const flow = session.browseFlow;
  if (!flow || flow.stack.length === 0) return null;
  flow.current = flow.stack.pop()!;
  return flow.current;
}

export async function startBrowseStalls(whatsappNumber: string, session: SessionState): Promise<void> {
  session.browseFlow = { current: { screen: "location_list" }, stack: [] };
  await renderLocationList(whatsappNumber);
}

async function renderLocationList(whatsappNumber: string): Promise<void> {
  const areas = await menuService.listDistinctAreas();
  if (areas.length === 0) {
    await sendWhatsAppText(whatsappNumber, "No pickup locations are available right now.");
    return;
  }
  const rows: ListRow[] = areas.slice(0, 9).map((a) => ({ id: `loc:${a}`, title: a.slice(0, 24) }));
  rows.push({ id: NAV_HOME, title: "🏠 Home" });
  await sendWhatsAppList(whatsappNumber, "Choose a pickup location:", "Choose location", rows);
}

async function renderStallList(whatsappNumber: string, session: SessionState, area: string): Promise<void> {
  const stalls = await menuService.listStalls({ area, limit: 8 });
  if (stalls.length === 0) {
    await sendWhatsAppText(whatsappNumber, `No stalls available near ${area} right now.`);
    goBack(session);
    return;
  }
  session.knownStalls = rememberNames(session.knownStalls, stalls.map((s) => [s.name, s.id]));
  const ratings = await ratingService.getStallRatingSummaries(stalls.map((s) => s.id));
  const rows: ListRow[] = stalls.map((s) => {
    const r = ratings.get(s.id);
    const ratingText = r && r.count > 0 ? `⭐ ${r.average} (${r.count} Ratings)` : undefined;
    const description = [s.block, ratingText].filter(Boolean).join(" · ") || undefined;
    return { id: `stall:${s.id}`, title: s.name.slice(0, 24), description: description?.slice(0, 72) };
  });
  rows.push({ id: NAV_BACK, title: "⬅️ Back" });
  rows.push({ id: NAV_HOME, title: "🏠 Home" });
  await sendWhatsAppList(whatsappNumber, `Stalls near ${area}:`, "Choose stall", rows);
}

async function renderCategoryMenu(whatsappNumber: string, stallId: string, stallName: string): Promise<void> {
  const categories = await menuService.listStallCategories(stallId);
  if (categories.length === 0) {
    await sendWhatsAppText(whatsappNumber, `${stallName} has no items available right now.`);
    return;
  }
  if (categories.length <= 3) {
    await sendWhatsAppButtons(
      whatsappNumber,
      `${stallName} — choose a category:`,
      categories.map((c) => ({ id: `cat:${c}`, title: c.slice(0, 20) })),
    );
    return;
  }
  const rows: ListRow[] = categories.slice(0, 8).map((c) => ({ id: `cat:${c}`, title: c.slice(0, 24) }));
  rows.push({ id: NAV_BACK, title: "⬅️ Back" });
  rows.push({ id: NAV_HOME, title: "🏠 Home" });
  await sendWhatsAppList(whatsappNumber, `${stallName} — choose a category:`, "Choose category", rows);
}

async function renderItemList(
  whatsappNumber: string,
  session: SessionState,
  stallId: string,
  stallName: string,
  categoryName: string,
): Promise<void> {
  const items = await menuService.listItemsInCategoryName(stallId, categoryName);
  if (items.length === 0) {
    await sendWhatsAppText(whatsappNumber, `No items available in ${categoryName} right now.`);
    goBack(session);
    return;
  }
  session.knownItems = rememberNames(session.knownItems, items.map((i) => [i.name, i.id]));
  const rows: ListRow[] = items.slice(0, 8).map((i) => ({
    id: `item:${i.id}`,
    title: i.name.slice(0, 24),
    description: `₹${Number(i.basePrice)}`.slice(0, 72),
  }));
  rows.push({ id: NAV_BACK, title: "⬅️ Back" });
  rows.push({ id: NAV_HOME, title: "🏠 Home" });
  await sendWhatsAppList(whatsappNumber, `${stallName} — ${categoryName}:`, "Choose item", rows);
}

async function renderItemDetail(whatsappNumber: string, screen: Extract<BrowseScreen, { screen: "item_detail" }>): Promise<void> {
  const subtotal = screen.unitPrice * screen.quantity;
  const rows: ListRow[] = [
    { id: "qty_inc", title: "➕ Increase Quantity" },
    { id: "qty_dec", title: "➖ Decrease Quantity" },
    { id: "add_cart", title: "🛒 Add To Cart" },
    { id: "continue_shop", title: "➡️ Continue Shopping" },
    { id: NAV_BACK, title: "⬅️ Back" },
    { id: NAV_HOME, title: "🏠 Home" },
  ];
  await sendWhatsAppList(
    whatsappNumber,
    `${screen.itemName} — ₹${screen.unitPrice} x ${screen.quantity} = ₹${subtotal}`,
    "Choose action",
    rows,
  );
}

async function renderScreen(whatsappNumber: string, session: SessionState, screen: BrowseScreen): Promise<void> {
  switch (screen.screen) {
    case "location_list":
      return renderLocationList(whatsappNumber);
    case "stall_list":
      return renderStallList(whatsappNumber, session, screen.area);
    case "category_menu":
      return renderCategoryMenu(whatsappNumber, screen.stallId, screen.stallName);
    case "item_list":
      return renderItemList(whatsappNumber, session, screen.stallId, screen.stallName, screen.categoryName);
    case "item_detail":
      return renderItemDetail(whatsappNumber, screen);
  }
}

export type BrowseFlowResult = "handled" | "home" | "fallthrough";

/**
 * Advances the Browse Stalls wizard by one step.
 * - "handled": already sent a reply, stay put.
 * - "home": browseFlow cleared, caller should send the Home screen.
 * - "fallthrough": browseFlow cleared, reply didn't match anything here —
 *   caller should run the normal AI loop so search/questions keep working.
 */
export async function handleBrowseFlowStep(
  whatsappNumber: string,
  text: string,
  interactiveId: string | undefined,
  session: SessionState,
): Promise<BrowseFlowResult> {
  const flow = session.browseFlow!;
  const id = interactiveId ?? "";
  const lower = text.trim().toLowerCase();

  if (id === NAV_HOME || lower === "home") {
    session.browseFlow = undefined;
    return "home";
  }
  if (id === NAV_BACK || lower === "back") {
    const prev = goBack(session);
    if (!prev) {
      session.browseFlow = undefined;
      return "home";
    }
    await renderScreen(whatsappNumber, session, prev);
    return "handled";
  }
  if (id === POST_ADD_CONTINUE_ID) {
    await renderScreen(whatsappNumber, session, flow.current);
    return "handled";
  }
  if (id === POST_ADD_CART_ID) {
    await sendWhatsAppText(whatsappNumber, buildCartSummary(session));
    await sendPostAddButtons(whatsappNumber);
    return "handled";
  }
  if (id === POST_ADD_CHECKOUT_ID) {
    await sendCheckoutPickupSlots(whatsappNumber, session);
    return "handled";
  }

  switch (flow.current.screen) {
    case "location_list": {
      const area = id.startsWith("loc:") ? id.slice(4) : text.trim();
      enterScreen(session, { screen: "stall_list", area });
      await renderStallList(whatsappNumber, session, area);
      return "handled";
    }

    case "stall_list": {
      let stallId: string | undefined;
      let stallName: string | undefined;
      if (id.startsWith("stall:")) {
        stallId = id.slice(6);
        stallName = Object.entries(session.knownStalls).find(([, v]) => v === stallId)?.[0];
      } else {
        stallId = session.knownStalls[text.trim()];
        stallName = text.trim();
      }
      if (!stallId) {
        // Doesn't match a stall from the list — let the AI loop handle it
        // (e.g. a craving, "checkout", "clear cart") rather than repeating
        // "pick from the list" forever for input that was never going to match.
        session.browseFlow = undefined;
        return "fallthrough";
      }
      enterScreen(session, { screen: "category_menu", stallId, stallName: stallName ?? "Stall" });
      await renderCategoryMenu(whatsappNumber, stallId, stallName ?? "Stall");
      return "handled";
    }

    case "category_menu": {
      const cm = flow.current;
      const categoryName = id.startsWith("cat:") ? id.slice(4) : text.trim();
      enterScreen(session, { screen: "item_list", stallId: cm.stallId, stallName: cm.stallName, categoryName });
      await renderItemList(whatsappNumber, session, cm.stallId, cm.stallName, categoryName);
      return "handled";
    }

    case "item_list": {
      const il = flow.current;
      const itemId = id.startsWith("item:") ? id.slice(5) : session.knownItems[text.trim()];
      if (!itemId) {
        session.browseFlow = undefined;
        return "fallthrough";
      }
      const item = await prisma.menuItem.findUnique({ where: { id: itemId } });
      if (!item || !item.available) {
        await sendWhatsAppText(whatsappNumber, "That item just went unavailable — pick another.");
        return "handled";
      }
      const detail: BrowseScreen = {
        screen: "item_detail",
        stallId: il.stallId,
        stallName: il.stallName,
        itemId: item.id,
        itemName: item.name,
        unitPrice: Number(item.basePrice),
        quantity: 1,
      };
      enterScreen(session, detail);
      await renderItemDetail(whatsappNumber, detail);
      return "handled";
    }

    case "item_detail": {
      const detail = flow.current;
      if (id === "qty_inc") {
        detail.quantity += 1;
        await renderItemDetail(whatsappNumber, detail);
        return "handled";
      }
      if (id === "qty_dec") {
        detail.quantity = Math.max(1, detail.quantity - 1);
        await renderItemDetail(whatsappNumber, detail);
        return "handled";
      }
      if (id === "add_cart") {
        if (session.cart.length > 0 && session.activeStallId && session.activeStallId !== detail.stallId) {
          // Must give an actual way forward here, not just a warning — free
          // text like "clear"/"checkout" won't match anything on this screen
          // and would otherwise trap the student in a "please choose above" loop.
          await sendWhatsAppButtons(
            whatsappNumber,
            "Your cart has items from a different stall. Clear it and add this instead?",
            [
              { id: "conflict_clear", title: "🗑 Clear & Add" },
              { id: "conflict_cancel", title: "❌ Cancel" },
            ],
          );
          return "handled";
        }
        addDetailToCart(session, detail);
        await sendWhatsAppText(whatsappNumber, `Added ${detail.quantity}x ${detail.itemName} to your cart. 🛒`);
        // Never jump straight to checkout after one add, but don't just
        // silently drop back into the item list either — an explicit next
        // step (add more / view full cart / checkout) beats making the
        // student guess that typing "checkout" works.
        goBack(session);
        await sendPostAddButtons(whatsappNumber);
        return "handled";
      }
      if (id === "conflict_clear") {
        session.cart = [];
        session.activeStallId = undefined;
        addDetailToCart(session, detail);
        await sendWhatsAppText(whatsappNumber, `Cleared your old cart and added ${detail.quantity}x ${detail.itemName}. 🛒`);
        goBack(session);
        await sendPostAddButtons(whatsappNumber);
        return "handled";
      }
      if (id === "conflict_cancel") {
        const prev = goBack(session);
        if (prev) await renderScreen(whatsappNumber, session, prev);
        else session.browseFlow = undefined;
        return "handled";
      }
      if (id === "continue_shop") {
        const prev = goBack(session);
        if (prev) await renderScreen(whatsappNumber, session, prev);
        else session.browseFlow = undefined;
        return "handled";
      }
      // Unrecognized input on this screen (a stray typed message, not a
      // tapped option) — clear the flow and let the AI loop handle it
      // instead of repeating "please choose above" forever.
      session.browseFlow = undefined;
      return "fallthrough";
    }

    default:
      session.browseFlow = undefined;
      return "fallthrough";
  }
}
