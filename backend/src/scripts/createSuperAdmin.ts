/**
 * One-time bootstrap for the first Super Admin account, since there is no
 * self-signup by design (Super Admin is the root of trust for the whole system).
 *
 * Usage: npm run create:admin -- --name "Rajat" --email you@example.com --password "changeme123"
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("--name");
  const email = arg("--email");
  const password = arg("--password");

  if (!name || !email || !password) {
    console.error('Usage: npm run create:admin -- --name "Name" --email you@example.com --password "secret"');
    process.exitCode = 1;
    return;
  }
  if (password.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.superAdmin.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { name, email, passwordHash },
  });
  console.log(`Super Admin ready: ${admin.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
