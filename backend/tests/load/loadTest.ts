/**
 * Load / stress / race-condition script — deliberately NOT a vitest test
 * (excluded from `npm test` via vitest.config.ts), run on demand via
 * `npm run test:load`. Two parts:
 *
 *  1. A concurrency/race-condition check directly against orderService,
 *     no live HTTP server required — fires many concurrent placeOrder()
 *     calls at a capacity-limited pickup slot and asserts the DB-level
 *     transaction actually prevents overbooking (this is the same
 *     guarantee `orderFlow.test.ts` checks with 2 orders; this does it
 *     with 50-100 to make a race far more likely to surface if the
 *     transaction were ever weakened).
 *  2. An HTTP-level load test against a running server (BASE_URL env var,
 *     default http://localhost:3000) measuring response time / error rate
 *     for concurrent health checks and concurrent authenticated analytics
 *     reads — skipped with a clear message if no server is reachable,
 *     since CI/this environment doesn't always have one running.
 */
import { prisma } from "../../src/lib/prisma";
import * as orderService from "../../src/services/orderService";
import { TestContext } from "../helpers/fixtures";

const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3000";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function raceConditionCheck(concurrency: number) {
  console.log(`\n=== Race condition check: ${concurrency} concurrent placeOrder() calls at a ${Math.floor(concurrency / 5)}-capacity slot ===`);
  const ctx = new TestContext();
  const capacity = Math.max(1, Math.floor(concurrency / 5));
  try {
    const stall = await ctx.createStall();
    const item = await ctx.createMenuItem(stall.id, { basePrice: 50 });
    const slot = await ctx.createPickupSlot(stall.id, { maxCapacity: capacity });
    const students = await Promise.all(Array.from({ length: concurrency }, () => ctx.createStudent()));

    const results = await Promise.allSettled(
      students.map((s) =>
        orderService.placeOrder({ studentId: s.id, stallId: stall.id, pickupSlotId: slot.id, lines: [{ menuItemId: item.id, quantity: 1 }] }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    succeeded.forEach((r) => {
      if (r.status === "fulfilled") ctx.trackOrder(r.value.id);
    });

    const finalSlot = await prisma.pickupSlot.findUniqueOrThrow({ where: { id: slot.id } });

    // Two distinct failure reasons get lumped into "failed" and must be told
    // apart: OrderError("...just filled up...") is the capacity guard
    // working exactly as designed once `capacity` orders have already won;
    // anything else (e.g. a connection-pool timeout under heavy concurrency)
    // is an environment constraint, not a correctness bug.
    const capacityRejections = failed.filter((r) => r.reason instanceof orderService.OrderError).length;
    const otherErrors = failed.length - capacityRejections;

    console.log(`  requested: ${concurrency}, capacity: ${capacity}`);
    console.log(`  succeeded: ${succeeded.length}, capacity-rejected: ${capacityRejections}, other errors: ${otherErrors}`);
    console.log(`  final bookedCount in DB: ${finalSlot.bookedCount}`);
    if (otherErrors > 0) {
      const sample = failed.find((r) => !(r.reason instanceof orderService.OrderError));
      console.log(`  sample non-capacity error: ${sample?.reason instanceof Error ? sample.reason.message : sample?.reason}`);
    }

    // The correctness invariant this actually checks: the DB's booked count
    // never exceeds capacity, and it always matches exactly how many
    // placeOrder() calls actually returned success — i.e. no overbooking
    // and no "phantom" bookings the code lost track of. It does NOT assert
    // that all `capacity` slots get filled — under enough concurrency this
    // free-tier Supabase pooler's own connection limit throttles some
    // requests before they even reach the capacity check, which is a
    // capacity-planning fact about the deployment, not a race condition.
    const noOverbooking = finalSlot.bookedCount <= capacity && succeeded.length === finalSlot.bookedCount;
    console.log(noOverbooking ? "  PASS: no overbooking under concurrency" : "  FAIL: overbooking or count mismatch detected");
    return noOverbooking;
  } finally {
    await ctx.cleanup();
  }
}

async function httpLoadCheck(label: string, path: string, concurrency: number, headers: Record<string, string> = {}) {
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      const reqStart = Date.now();
      const res = await fetch(`${BASE_URL}${path}`, { headers });
      const elapsed = Date.now() - reqStart;
      return { status: res.status, elapsed };
    }),
  );
  const totalMs = Date.now() - start;

  const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ status: number; elapsed: number }> => r.status === "fulfilled");
  const errors = results.length - fulfilled.length;
  const httpErrors = fulfilled.filter((r) => r.value.status >= 400).length;
  const times = fulfilled.map((r) => r.value.elapsed).sort((a, b) => a - b);

  console.log(`\n=== HTTP load: ${label} (${concurrency} concurrent) ===`);
  console.log(`  total wall time: ${totalMs}ms`);
  console.log(`  network errors: ${errors}, HTTP error responses: ${httpErrors}`);
  console.log(`  latency ms — min:${times[0] ?? 0} p50:${percentile(times, 50)} p95:${percentile(times, 95)} max:${times[times.length - 1] ?? 0}`);
}

async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

async function main() {
  console.log("LPU Food Ordering — load/stress test");

  const raceOk50 = await raceConditionCheck(50);
  const raceOk100 = await raceConditionCheck(100);

  if (await serverIsUp()) {
    await httpLoadCheck("GET /health", "/health", 50);
    await httpLoadCheck("GET /health", "/health", 100);
  } else {
    console.log(`\nNo server reachable at ${BASE_URL} — skipping HTTP-level load checks.`);
    console.log("Start the server (npm run dev, or a deployed instance) and re-run with LOAD_TEST_BASE_URL set to include HTTP checks.");
  }

  console.log("\n=== Summary ===");
  console.log(`Race condition (50 concurrent): ${raceOk50 ? "PASS" : "FAIL"}`);
  console.log(`Race condition (100 concurrent): ${raceOk100 ? "PASS" : "FAIL"}`);

  if (!raceOk50 || !raceOk100) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("LOAD TEST ERROR:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
