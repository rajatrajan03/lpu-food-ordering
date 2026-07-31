/**
 * Best-effort mapping from the 267 raw category spellings in the source sheet
 * to a small shared taxonomy, so "browse by category" works the same way
 * across all 54 stalls. First matching rule wins. Anything that matches
 * nothing is left unmapped — Super Admin reviews those via
 * GET /api/admin/menu-categories/unmapped and assigns them by hand.
 */
export const CANONICAL_CATEGORIES = [
  "Pizza",
  "Pasta",
  "Sandwich",
  "Burger",
  "Maggi",
  "Noodles & Chinese",
  "Momos",
  "Rice & Biryani",
  "South Indian",
  "North Indian & Thali",
  "Rolls & Wraps",
  "Fries & Snacks",
  "Chaat & Street Food",
  "Soups",
  "Hot Beverages",
  "Cold Beverages",
  "Desserts & Ice Cream",
  "Combos & Meals",
  "Breads & Parathas",
  "Add-ons & Extras",
  "Salads",
] as const;

const RULES: [RegExp, (typeof CANONICAL_CATEGORIES)[number]][] = [
  [/pizza/i, "Pizza"],
  [/pasta/i, "Pasta"],
  [/sandwich|sandwhich|sub'?s?|footlong/i, "Sandwich"],
  [/burger|moburg/i, "Burger"],
  [/maggi/i, "Maggi"],
  [/noodle|chinese|indo-chinese|thukpa|ramyun|spring roll|gimbap|sushi/i, "Noodles & Chinese"],
  [/momo/i, "Momos"],
  [/rice|biry?ani|fried rice/i, "Rice & Biryani"],
  [/dosa|idli|uttapam|south\s*(indian|breakfast|snacks|tea)/i, "South Indian"],
  [/thali|north indian|paneer|chaap|tandoor|naan|kulcha|tikka/i, "North Indian & Thali"],
  [/roll|wrap|kathi|burrito|taco/i, "Rolls & Wraps"],
  [/fries|potato|pakoda|puff|starter/i, "Fries & Snacks"],
  [/chaat|pav\s*bhaji|pao\s*bhaji|vada pav|poha|street food|bun/i, "Chaat & Street Food"],
  [/soup/i, "Soups"],
  [/coffee|tea|chai/i, "Hot Beverages"],
  [/shake|mojito|krusher|ice tea|juice|lassi|cooler|boba|matcha|drinkology|refresh|mocktail|soft drink|beverage/i, "Cold Beverages"],
  [/dessert|ice\s*cream|sundae|softy|brownie|cake|waffle|chocolawa/i, "Desserts & Ice Cream"],
  [/combo|meal|thukpa|bowl|special\s*packed/i, "Combos & Meals"],
  [/paratha|bread|prantha|roti|crust/i, "Breads & Parathas"],
  [/add[\s-]?on|extra|topping|dip|side/i, "Add-ons & Extras"],
  [/salad/i, "Salads"],
];

export function mapRawCategory(raw: string | null | undefined): (typeof CANONICAL_CATEGORIES)[number] | null {
  if (!raw) return null;
  for (const [pattern, canonical] of RULES) {
    if (pattern.test(raw)) return canonical;
  }
  return null;
}
