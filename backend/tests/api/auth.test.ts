import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { signToken } from "../../src/lib/auth";
import { TestContext } from "../helpers/fixtures";

const app = createApp();

let ctx: TestContext;
beforeEach(() => {
  ctx = new TestContext();
});
afterEach(() => ctx.cleanup());

describe("POST /api/auth/owner/login", () => {
  it("400s on a malformed body", async () => {
    const res = await request(app).post("/api/auth/owner/login").send({});
    expect(res.status).toBe(400);
  });

  it("401s on wrong credentials", async () => {
    const res = await request(app).post("/api/auth/owner/login").send({ phone: "0000000000", password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("200s and returns a token on correct credentials", async () => {
    const stall = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stall.id]);
    const res = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.name).toBe(owner.name);
  });
});

describe("Role authorization / permission isolation across owner and admin routes", () => {
  it("401s a protected route with no token", async () => {
    const res = await request(app).get("/api/owner/stalls/mine");
    expect(res.status).toBe(401);
  });

  it("401s a protected route with a garbage token", async () => {
    const res = await request(app).get("/api/owner/stalls/mine").set("Authorization", "Bearer garbage.token.value");
    expect(res.status).toBe(401);
  });

  it("403s when an owner token is used against an admin-only route", async () => {
    const stall = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stall.id]);
    const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    const res = await request(app).get("/api/admin/overview").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  it("403s when an admin token is used against an owner-only route", async () => {
    const { admin } = await ctx.createAdmin();
    // Real login goes through OTP delivery (a WhatsApp send) which isn't
    // something to exercise here — mint a token the same way signToken
    // does post-OTP, to isolate exactly what's being tested: requireAuth's
    // role check on this route, not the OTP flow (covered separately below).
    const token = signToken({ id: admin.id, role: "super_admin" });
    const res = await request(app).get("/api/owner/stalls/mine").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("an owner cannot manage a stall they don't own", async () => {
    const stallA = await ctx.createStall();
    const stallB = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stallA.id]);
    const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    const res = await request(app)
      .post(`/api/owner/stalls/${stallB.id}/pause`)
      .set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/auth/admin/login + OTP flow", () => {
  // Super Admin OTP is temporarily disabled (ADMIN_OTP_ENABLED = false in
  // routes/auth.ts, 2026-08-09 — no email-sending service configured yet
  // to offer as an alternative to WhatsApp delivery) — correct credentials
  // return a token directly, same shape as owner login. Once OTP is
  // switched back on, this test's 200 branch should assert
  // `otpRequired`/`adminId` instead (still no WhatsApp number on the
  // fixture admin, so it would 400 — see the comment that used to be here).
  it("returns a token directly on correct password (OTP currently disabled)", async () => {
    const { admin, password } = await ctx.createAdmin();
    const res = await request(app).post("/api/auth/admin/login").send({ email: admin.email, password });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.name).toBe(admin.name);
  });

  it("401s on wrong admin password", async () => {
    const { admin } = await ctx.createAdmin();
    const res = await request(app).post("/api/auth/admin/login").send({ email: admin.email, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("400s verify-otp with a malformed code", async () => {
    const { admin } = await ctx.createAdmin();
    const res = await request(app).post("/api/auth/admin/verify-otp").send({ adminId: admin.id, otp: "abc" });
    expect(res.status).toBe(400);
  });

  it("401s verify-otp when no code is pending", async () => {
    const { admin } = await ctx.createAdmin();
    const res = await request(app).post("/api/auth/admin/verify-otp").send({ adminId: admin.id, otp: "123456" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout — token revocation", () => {
  it("revokes the token so it's rejected on subsequent requests", async () => {
    const stall = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stall.id]);
    const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    const token = login.body.token;

    const before = await request(app).get("/api/owner/stalls/mine").set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    const logout = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const after = await request(app).get("/api/owner/stalls/mine").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("401s a logout attempt with no token", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(401);
  });
});
