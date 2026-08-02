import type Groq from "groq-sdk";

// Tool definitions handed to Groq for function-calling. Keep these in sync with
// the dispatcher in conversationEngine.ts — the `name` here must match a case there.
export const toolDefinitions: Groq.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_stalls",
      description:
        "List or look up food stalls on campus (returns up to 10 at a time). Use `query` whenever the student names a specific stall (e.g. 'Chai Sutta Bar') — do not ask them what area it's in, just look it up by name. Use `area` when they want to browse by location instead.",
      parameters: {
        type: "object",
        properties: {
          area: { type: "string", description: "Campus area to filter by, e.g. 'Boys Hostel'." },
          query: { type: "string", description: "Stall name (or part of it) to search for, e.g. 'Chai Sutta Bar'." },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Skip this many stalls before returning results — use when the student asks for more.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_menu",
      description:
        "Search menu items by name/description/category, optionally scoped to one stall or one campus area/block. Call this whenever the student names a food, a craving, or a category — do not guess prices or availability yourself. If they combine a craving with a location (e.g. 'chai near CC'), pass both query and area/block in this ONE call instead of listing every stall in that area.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search, e.g. 'cold coffee' or 'paneer'." },
          stall_id: {
            type: "string",
            description:
              "Restrict results to one stall. Must be an actual id returned by list_stalls or a previous search_menu result — never guess this from a stall's display name. If you only know the stall's name, omit this field and let the search run across all stalls, or call list_stalls first to resolve the id.",
          },
          area: { type: "string", description: "Campus area to restrict results to, e.g. 'CC', 'Boys Hostel'." },
          block: { type: "string", description: "Campus block to restrict results to." },
          category: { type: "string", description: "Canonical category name, e.g. 'Pizza'." },
          veg_only: { type: "boolean" },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Skip this many matches before returning results, using the exact same query/stall_id/category/veg_only as the previous call. Use this when the student says 'different', 'something else', or 'more options' after you've already shown them a list — set it to how many items you already showed them, so they get a fresh batch instead of the same one again.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_cart",
      description: "Show the student's current draft cart and running total.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description:
        "Add an item to the draft cart. The cart can only hold items from one stall at a time — if the student tries to add from a different stall, this will be rejected and you should tell them their current cart must be from one stall.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "Must be an actual id from a search_menu result — never guess it." },
          variant_id: { type: "string", description: "Optional, if the item has size/flavor variants." },
          quantity: { type: "integer", minimum: 1, default: 1 },
        },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description: "Remove an item (optionally a specific variant) from the draft cart.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          variant_id: { type: "string" },
        },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pickup_slots",
      description:
        "Get bookable pickup time slots for the stall the current cart belongs to. Call this once the student is ready to check out.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description:
        "Confirm and place the order for a chosen pickup slot, using everything currently in the cart. Only call this after the student has explicitly confirmed the cart and picked a slot.",
      parameters: {
        type: "object",
        properties: { pickup_slot_id: { type: "string" } },
        required: ["pickup_slot_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Get the status of the student's current active order(s).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description:
        "Cancel an active order. Will fail if the stall has already started preparing it — relay that to the student if so.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
      },
    },
  },
];

export interface CartLine {
  itemId: string;
  itemName: string;
  variantId?: string;
  variantLabel?: string;
  unitPrice: number;
  quantity: number;
}

export interface SessionState {
  activeStallId?: string;
  cart: CartLine[];
  // Short final-reply history only — kept small deliberately. Groq's free
  // tier caps at 12k tokens/minute, so we can't afford to replay full tool
  // call/result payloads every turn.
  recentMessages: { role: "user" | "assistant"; content: string }[];
  // Bounded name -> id lookup, populated whenever list_stalls/search_menu
  // returns results. This is what actually lets the model reference a real
  // stall/item id from an earlier turn, without the token cost of replaying
  // the tool results that produced it.
  knownStalls: Record<string, string>;
  knownItems: Record<string, string>;
}

const MAX_KNOWN_ENTRIES = 30;

/** Adds entries to a name->id map, evicting the oldest ones past the cap. */
export function rememberNames(map: Record<string, string>, entries: [string, string][]): Record<string, string> {
  const merged = { ...map };
  for (const [name, id] of entries) merged[name] = id;
  const keys = Object.keys(merged);
  if (keys.length <= MAX_KNOWN_ENTRIES) return merged;
  const trimmed: Record<string, string> = {};
  for (const key of keys.slice(-MAX_KNOWN_ENTRIES)) trimmed[key] = merged[key];
  return trimmed;
}

export function emptySessionState(): SessionState {
  return { cart: [], recentMessages: [], knownStalls: {}, knownItems: {} };
}
