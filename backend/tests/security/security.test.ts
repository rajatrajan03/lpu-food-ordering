import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../../src/app";
import { TestContext } from "../helpers/fixtures";

const app = createApp();

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("Security — rate limiting", () => {
  it("throttles repeated failed login attempts with 429 (authLimiter: 15/15min)", async () => {
    // authLimiter is a module-level singleton (lib/rateLimit.ts), shared by
    // every createApp() instance in this process — flooding it from the
    // same source IP every other test uses (127.0.0.1) would 429 every
    // subsequent real login in the rest of the suite. `app.set("trust
    // proxy", 1)` means express-rate-limit keys on X-Forwarded-For, so a
    // synthetic IP here isolates this test's flood from everything else.
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/auth/owner/login")
        .set("X-Forwarded-For", "10.0.0.99")
        .send({ phone: "0000000000", password: "wrong" });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  }, 30_000);
});

describe("Security — JWT integrity", () => {
  it("rejects a token with a tampered payload (role escalation attempt)", async () => {
    const stall = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stall.id]);
    const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    expect(login.status).toBe(200);
    const [header, payload, signature] = (login.body.token as string).split(".");

    // Attempt to escalate stall_owner -> super_admin by rewriting the payload
    // without re-signing — the original signature can no longer match.
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    const tamperedPayload = Buffer.from(JSON.stringify({ ...decoded, role: "super_admin" })).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;

    const res = await request(app).get("/api/admin/overview").set("Authorization", `Bearer ${tamperedToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ id: "x", role: "stall_owner" }, process.env.JWT_SECRET ?? "dev-only-secret-change-me", {
      issuer: "lpu-food-ordering",
      audience: "lpu-food-dashboard",
      expiresIn: "-1h",
    });
    const res = await request(app).get("/api/owner/stalls/mine").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token minted for a different issuer/audience", async () => {
    const wrongAudience = jwt.sign({ id: "x", role: "stall_owner" }, process.env.JWT_SECRET ?? "dev-only-secret-change-me", {
      issuer: "some-other-app",
      audience: "some-other-dashboard",
      expiresIn: "1h",
    });
    const res = await request(app).get("/api/owner/stalls/mine").set("Authorization", `Bearer ${wrongAudience}`);
    expect(res.status).toBe(401);
  });
});

describe("Security — permission isolation", () => {
  it("an owner's token cannot read another owner's stall data", async () => {
    const stallA = await ctx.createStall();
    const stallB = await ctx.createStall();
    const { owner: ownerA, password: passA } = await ctx.createOwner([stallA.id]);
    await ctx.createOwner([stallB.id]);

    const loginA = await request(app).post("/api/auth/owner/login").send({ phone: ownerA.phone, password: passA });
    expect(loginA.status).toBe(200);
    const res = await request(app).get(`/api/owner/stalls/${stallB.id}/orders`).set("Authorization", `Bearer ${loginA.body.token}`);
    expect(res.status).toBe(403);
  });

  it("students have no dashboard API surface at all — every owner/admin route requires a signed JWT, which nothing student-facing ever issues", async () => {
    // There is no /api/student/* namespace in this app by design — the
    // entire student experience is WhatsApp-only (see HANDOFF.md §4). This
    // test documents that invariant: hitting any dashboard route with no
    // token is uniformly 401, never a student-scoped 200.
    const res = await request(app).get("/api/owner/stalls/mine");
    expect(res.status).toBe(401);
  });
});
