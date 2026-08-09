import bcrypt from "bcryptjs";
import { prisma } from "../../src/lib/prisma";

/**
 * There is no separate provisioned test database for this project — tests
 * run against the same Supabase Postgres as production (see HANDOFF.md's
 * testing section). Every fixture created here is tagged with the
 * `TEST_PREFIX` in a human-visible field (name/displayId/etc.) and tracked
 * for teardown, mirroring the create-fixture / assert / clean-up discipline
 * this project's ad-hoc tmpTest*.ts scripts used throughout development —
 * just formalized into reusable, permanent test helpers.
 */
export const TEST_PREFIX = "TEST_FX_";

// A plain Date.now()-based suffix collides under real concurrency — many
// fixtures created inside the same Promise.all batch (as the load test
// does deliberately, and as a real rush-hour surge would too) land in the
// same millisecond. A monotonic counter guarantees uniqueness regardless
// of how many fixtures are created in the same tick; this was a real bug
// caught by tests/load/loadTest.ts's concurrent-fixture-creation run.
let fixtureCounter = 0;
function nextId(): string {
  fixtureCounter += 1;
  return fixtureCounter.toString().padStart(8, "0");
}

// Deliberately NOT truncated to a "realistic" phone-number length — the
// schema only requires a minimum length (min(5)), and truncating a
// counter-suffixed string is exactly what reintroduced collisions once
// before (see the comment above). Correctness under concurrency wins over
// looking exactly like a real phone number.
export function uniquePhone(): string {
  return `9${nextId()}`;
}

export function uniqueEmail(): string {
  return `${TEST_PREFIX}${nextId()}@example.test`;
}

export function uniqueWhatsapp(): string {
  return `91${nextId()}`;
}

// Pure UTC construction, deliberately not local Date methods — `slotDate` is
// a @db.Date and `startTime`/`endTime` are @db.Time columns with no
// timezone of their own, and this app's read side (menuService's
// getAvailablePickupSlots) computes "today" via `fromDate.getUTCFullYear()`
// etc. Building fixtures with local `setHours` (IST on a dev machine) makes
// slotDate silently land on the *previous* UTC calendar date for roughly a
// third of the day (IST midnight-5:30am), which only shows up as test
// flakiness depending on what wall-clock hour happens to be running when
// the suite executes — exactly what happened here (a grace-period test
// passed for hours, then started failing once real time crossed the
// UTC-day boundary). Pure UTC arithmetic is deterministic regardless of
// what timezone or time of day the suite runs in.
function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcTimeOfDay(hh: number, mm: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0, 0));
}

/**
 * Tracks every fixture id created through this context and tears them all
 * down in dependency-safe order. Use one TestContext per test (create in
 * beforeEach, call ctx.cleanup() in afterEach) so tests never leak fixtures
 * into the real database even if an assertion throws mid-test.
 */
export class TestContext {
  orderIds: string[] = [];
  stallIds: string[] = [];
  studentIds: string[] = [];
  ownerIds: string[] = [];
  adminIds: string[] = [];

  async createStall(overrides: Partial<{ name: string; block: string; status: "active" | "paused"; pickupGraceMinutes: number }> = {}) {
    const stall = await prisma.stall.create({
      data: {
        name: overrides.name ?? `${TEST_PREFIX}Stall_${nextId()}`,
        block: overrides.block ?? "TestBlock",
        status: overrides.status ?? "active",
        pickupGraceMinutes: overrides.pickupGraceMinutes,
      },
    });
    this.stallIds.push(stall.id);
    return stall;
  }

  async createOwner(stallIds: string[], password = "TestPass123!") {
    const passwordHash = await bcrypt.hash(password, 4); // low cost factor — speed, not security, for tests
    const owner = await prisma.stallOwner.create({
      data: {
        name: `${TEST_PREFIX}Owner`,
        phone: uniquePhone(),
        passwordHash,
        stalls: { connect: stallIds.map((id) => ({ id })) },
      },
    });
    this.ownerIds.push(owner.id);
    return { owner, password };
  }

  async createAdmin(password = "TestAdmin123!") {
    const passwordHash = await bcrypt.hash(password, 4);
    const admin = await prisma.superAdmin.create({
      data: { name: `${TEST_PREFIX}Admin`, email: uniqueEmail(), passwordHash },
    });
    this.adminIds.push(admin.id);
    return { admin, password };
  }

  async createStudent(overrides: Partial<{ name: string; registrationNumber: string; whatsappNumber: string }> = {}) {
    const student = await prisma.student.create({
      data: {
        whatsappNumber: overrides.whatsappNumber ?? uniqueWhatsapp(),
        name: overrides.name ?? `${TEST_PREFIX}Student`,
        registrationNumber: overrides.registrationNumber ?? `REG${Date.now()}`,
      },
    });
    this.studentIds.push(student.id);
    return student;
  }

  async createMenuItem(stallId: string, overrides: Partial<{ name: string; basePrice: number; available: boolean }> = {}) {
    return prisma.menuItem.create({
      data: {
        stallId,
        name: overrides.name ?? `${TEST_PREFIX}Item_${nextId()}`,
        basePrice: overrides.basePrice ?? 100,
        available: overrides.available ?? true,
      },
    });
  }

  /** `hour` is UTC (not local/IST) — see utcDayStart/utcTimeOfDay's comment for why. */
  async createPickupSlot(stallId: string, opts: { dayOffset?: number; hour?: number; maxCapacity?: number } = {}) {
    const ref = new Date();
    ref.setUTCDate(ref.getUTCDate() + (opts.dayOffset ?? 0));
    const dayStart = utcDayStart(ref);
    const hour = opts.hour ?? 12;
    return prisma.pickupSlot.create({
      data: {
        stallId,
        slotDate: dayStart,
        startTime: utcTimeOfDay(hour, 0),
        endTime: utcTimeOfDay(hour, 15),
        maxCapacity: opts.maxCapacity ?? 8,
      },
    });
  }

  /** Creates a fully-formed order (with one item) directly via Prisma — bypasses orderService.placeOrder's slot-booking transaction, for tests that need a specific status/timestamps rather than exercising placeOrder itself. */
  async createOrder(params: {
    studentId: string;
    stallId: string;
    pickupSlotId: string;
    menuItemId: string;
    status?: "placed" | "accepted" | "rejected" | "preparing" | "ready" | "completed" | "cancelled";
    totalAmount?: number;
    placedAt?: Date;
    updatedAt?: Date;
    noShow?: boolean;
    slaViolation?: boolean;
  }) {
    const order = await prisma.order.create({
      data: {
        displayId: `${TEST_PREFIX}${nextId()}`,
        studentId: params.studentId,
        stallId: params.stallId,
        pickupSlotId: params.pickupSlotId,
        status: params.status ?? "placed",
        totalAmount: params.totalAmount ?? 100,
        placedAt: params.placedAt,
        updatedAt: params.updatedAt,
        noShow: params.noShow ?? false,
        slaViolation: params.slaViolation ?? false,
        items: {
          create: [{ menuItemId: params.menuItemId, quantity: 1, unitPrice: params.totalAmount ?? 100, itemNameSnapshot: "Test Item" }],
        },
      },
    });
    this.orderIds.push(order.id);
    return order;
  }

  /** Registers an order created some other way (e.g. via orderService.placeOrder) for teardown. */
  trackOrder(orderId: string) {
    this.orderIds.push(orderId);
  }

  async cleanup() {
    if (this.orderIds.length > 0) {
      await prisma.rating.deleteMany({ where: { orderId: { in: this.orderIds } } });
      await prisma.offerRedemption.deleteMany({ where: { orderId: { in: this.orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: this.orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: this.orderIds } } });
    }
    if (this.stallIds.length > 0) {
      // MenuItem/PickupSlot/Offer/Rating(stall-scoped)/StudentPreference all cascade from Stall.
      await prisma.stall.deleteMany({ where: { id: { in: this.stallIds } } });
    }
    if (this.ownerIds.length > 0) {
      await prisma.stallOwner.deleteMany({ where: { id: { in: this.ownerIds } } });
    }
    if (this.adminIds.length > 0) {
      await prisma.superAdmin.deleteMany({ where: { id: { in: this.adminIds } } });
    }
    if (this.studentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: this.studentIds } } });
    }
    this.orderIds = [];
    this.stallIds = [];
    this.studentIds = [];
    this.ownerIds = [];
    this.adminIds = [];
  }
}
