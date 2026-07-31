/**
 * One-time import of data/lpu-canteen-data.xlsx into the database.
 *
 * Run with:  npm run import:data          (adds to existing data)
 *            npm run import:data -- --reset   (wipes menu items/categories first, keeps stalls & owners)
 *
 * The source sheet is a flat, denormalized price list — not a clean schema.
 * See the Phase 1/2 discussion for what this script does and does not attempt
 * to clean up automatically:
 *   - Prices: strips a leading "₹" and parses to a number.
 *   - Stalls: a (Block, Restaurant) pair is treated as one physical stall,
 *     since the same brand name can appear at more than one location.
 *   - Categories: mapped onto a small shared taxonomy via categoryMap.ts.
 *     Anything that doesn't match a rule is left unmapped for Super Admin
 *     to assign by hand — see the report printed at the end.
 *   - Items/variants: when the sheet's own Variant column has a value, rows
 *     sharing the same (stall, category, item name) are grouped into one
 *     MenuItem with multiple ItemVariants. When Variant is empty, each row
 *     becomes its own standalone MenuItem — no name-splitting heuristics,
 *     to avoid guessing wrong. Renaming/regrouping those is a dashboard task.
 */
import "dotenv/config";
import path from "path";
import * as XLSX from "xlsx";
import { prisma } from "../lib/prisma";
import { mapRawCategory, CANONICAL_CATEGORIES } from "./categoryMap";

interface SheetRow {
  Area?: string;
  Block?: string;
  Restaurant?: string;
  Category?: string;
  Item?: string;
  Variant?: string;
  Price?: string | number;
  Notes?: string;
}

function cleanPrice(raw: string | number | undefined): number | null {
  if (raw == null) return null;
  const num = Number(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function ensureCanonicalCategories(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const name of CANONICAL_CATEGORIES) {
    const cat = await prisma.canonicalCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    ids.set(name, cat.id);
  }
  return ids;
}

async function resetImportedData() {
  console.log("Resetting menu items, variants, and categories (stalls & owners kept)...");
  await prisma.itemVariant.deleteMany({});
  await prisma.menuItem.deleteMany({});
  await prisma.menuCategory.deleteMany({});
}

async function main() {
  const shouldReset = process.argv.includes("--reset");
  const filePath = path.resolve(__dirname, "../../../data/lpu-canteen-data.xlsx");

  console.log(`Reading ${filePath}`);
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: null });
  console.log(`Found ${rows.length} rows`);

  if (shouldReset) await resetImportedData();
  const canonicalIdsByName = await ensureCanonicalCategories();

  const stallIdByKey = new Map<string, string>();
  const categoryIdByKey = new Map<string, string>();
  // itemKey -> { menuItemId, variantsSeen: Set<label> } for grouping same-name variant rows
  const itemByKey = new Map<string, { id: string }>();

  let imported = 0;
  let skipped = 0;
  const unmatchedCategories = new Map<string, number>();

  for (const row of rows) {
    const block = row.Block?.toString().trim();
    const restaurant = row.Restaurant?.toString().trim();
    const itemName = row.Item?.toString().trim();
    const price = cleanPrice(row.Price);

    if (!block || !restaurant || !itemName || price == null) {
      skipped++;
      continue;
    }
    const area = row.Area?.toString().trim() || null;
    const rawCategory = row.Category?.toString().trim() || "Uncategorized";
    const variantLabel = row.Variant?.toString().trim() || null;

    // --- Stall (Block + Restaurant is the real identity) ---
    const stallKey = `${block}||${restaurant}`;
    let stallId = stallIdByKey.get(stallKey);
    if (!stallId) {
      const stall = await prisma.stall.upsert({
        where: { block_name: { block, name: restaurant } },
        update: { area: area ?? undefined },
        create: { block, name: restaurant, area },
      });
      stallId = stall.id;
      stallIdByKey.set(stallKey, stallId);
    }

    // --- Category (per-stall raw label, mapped to canonical taxonomy) ---
    const categoryKey = `${stallId}||${rawCategory}`;
    let categoryId = categoryIdByKey.get(categoryKey);
    if (!categoryId) {
      const canonicalName = mapRawCategory(rawCategory);
      if (!canonicalName) {
        unmatchedCategories.set(rawCategory, (unmatchedCategories.get(rawCategory) ?? 0) + 1);
      }
      const category = await prisma.menuCategory.upsert({
        where: { stallId_rawLabel: { stallId, rawLabel: rawCategory } },
        update: {},
        create: {
          stallId,
          rawLabel: rawCategory,
          canonicalCategoryId: canonicalName ? canonicalIdsByName.get(canonicalName) : null,
        },
      });
      categoryId = category.id;
      categoryIdByKey.set(categoryKey, categoryId);
    }

    // --- Item (+ variant, if the sheet gave us one) ---
    const itemKey = `${stallId}||${categoryId}||${itemName.toLowerCase()}`;

    if (variantLabel) {
      let item = itemByKey.get(itemKey);
      if (!item) {
        const created = await prisma.menuItem.create({
          data: {
            stallId,
            categoryId,
            name: itemName,
            basePrice: price,
            rawImportText: `${rawCategory} | ${itemName}`,
          },
        });
        item = { id: created.id };
        itemByKey.set(itemKey, item);
      }
      await prisma.itemVariant.create({
        data: { menuItemId: item.id, label: variantLabel, price },
      });
    } else {
      await prisma.menuItem.create({
        data: {
          stallId,
          categoryId,
          name: itemName,
          basePrice: price,
          rawImportText: `${rawCategory} | ${itemName}`,
        },
      });
    }

    imported++;
  }

  console.log(`\nImported ${imported} rows, skipped ${skipped} (missing block/restaurant/item/price).`);
  console.log(`Stalls: ${stallIdByKey.size}`);

  if (unmatchedCategories.size > 0) {
    console.log(`\n${unmatchedCategories.size} raw category labels didn't match the default taxonomy —`);
    console.log("these are saved as unmapped and need a Super Admin review:");
    const top = [...unmatchedCategories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    for (const [label, count] of top) console.log(`  ${count.toString().padStart(4)}x  ${label}`);
    if (unmatchedCategories.size > 25) console.log(`  ...and ${unmatchedCategories.size - 25} more.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
