/**
 * Local chat test — talk to the ordering AI from the terminal, no WhatsApp
 * or ngrok needed. Uses a fake WhatsApp number so it creates/reuses one
 * consistent test student across runs.
 *
 * Usage: npm run test:chat -- "hi, what stalls are near CSE Block?"
 */
import "dotenv/config";
import { handleIncomingMessage } from "../ai/conversationEngine";
import { prisma } from "../lib/prisma";

const TEST_NUMBER = "911234567890";

async function main() {
  const message = process.argv.slice(2).join(" ");
  if (!message) {
    console.error('Usage: npm run test:chat -- "your message here"');
    process.exitCode = 1;
    return;
  }
  console.log(`> ${message}`);
  const reply = await handleIncomingMessage(TEST_NUMBER, message);
  console.log(`\n${reply}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
