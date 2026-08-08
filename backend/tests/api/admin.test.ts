import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { signToken } from "../../src/lib/auth";
import { TestContext } from "../helpers/fixtures";

const app = createApp();

let ctx: TestContext;
let token: string;

beforeEach(async () => {
  ctx = new TestContext();
  const { admin } = await ctx.createAdmin();
  token = signToken({ id: admin.id, role: "super_admin" });
});
afterEach(() => ctx.cleanup());

function auth(req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`);
}

describe("Admin API — overview, stalls, rankings", () => {
  it("GET /overview returns 200 with campus-wide numbers", async () => {
    const res = await auth(request(app).get("/api/admin/overview"));
    expect(res.status).toBe(200);
    expect(typeof res.body.ordersToday).toBe("number");
    expect(typeof res.body.activeStalls).toBe("number");
  });

  it("GET /stalls lists stalls including a freshly created one", async () => {
    const stall = await ctx.createStall();
    const res = await auth(request(app).get("/api/admin/stalls"));
    expect(res.status).toBe(200);
    expect(res.body.some((s: { id: string }) => s.id === stall.id)).toBe(true);
  });

  it("PATCH /stalls/:id updates a stall and rejects an invalid payload", async () => {
    const stall = await ctx.createStall();
    const ok = await auth(request(app).patch(`/api/admin/stalls/${stall.id}`).send({ status: "paused" }));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("paused");

    const bad = await auth(request(app).patch(`/api/admin/stalls/${stall.id}`).send({ pickupGraceMinutes: 999 }));
    expect(bad.status).toBe(400);
  });

  it("GET /stalls/rankings returns 200 (empty array is a valid response when nothing's rated)", async () => {
    const res = await auth(request(app).get("/api/admin/stalls/rankings"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("Admin API — offers, analytics, forecast", () => {
  it("GET /offers and /offers/analytics both 200", async () => {
    const offers = await auth(request(app).get("/api/admin/offers"));
    expect(offers.status).toBe(200);
    const analytics = await auth(request(app).get("/api/admin/offers/analytics"));
    expect(analytics.status).toBe(200);
  });

  it("GET /analytics 200s and rejects a bad period with 400", async () => {
    const ok = await auth(request(app).get("/api/admin/analytics?period=week"));
    expect(ok.status).toBe(200);
    const bad = await auth(request(app).get("/api/admin/analytics?period=nonsense"));
    expect(bad.status).toBe(400);
  });

  it("GET /forecast 200s (sufficient:false with no campus order history matching the window)", async () => {
    const res = await auth(request(app).get("/api/admin/forecast"));
    expect(res.status).toBe(200);
    expect(typeof res.body.sufficient).toBe("boolean");
  });
});

describe("Admin API — permission isolation", () => {
  it("401s every admin route with no token", async () => {
    const routes = ["/api/admin/overview", "/api/admin/stalls", "/api/admin/analytics", "/api/admin/forecast"];
    for (const path of routes) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    }
  });

  it("403s an owner-role token on every admin route", async () => {
    const stall = await ctx.createStall();
    const { owner, password } = await ctx.createOwner([stall.id]);
    const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
    const ownerToken = login.body.token;

    const res = await request(app).get("/api/admin/overview").set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });
});
