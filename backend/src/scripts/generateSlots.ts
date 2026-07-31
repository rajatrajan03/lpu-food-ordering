/**
 * Generates today's (and optionally the next N days') pickup slots for every
 * active stall. This is meant to run on a schedule (e.g. once daily just
 * after midnight) — there's no cron wired up yet, so run it manually for now:
 *
 *   npm run generate:slots           (today only)
 *   npm run generate:slots -- 7      (today + next 6 days)
 */
import "dotenv/config";
import { generateSlotsForAllStalls } from "../services/slotGenerator";
import { prisma } from "../lib/prisma";

async function main() {
  const days = Number(process.argv[2]) || 1;
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    const count = await generateSlotsForAllStalls(date);
    console.log(`Generated slots for ${count} stalls on ${date.toDateString()}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
