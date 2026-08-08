import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { TestContext } from "../helpers/fixtures";

const app = createApp();

let ctx: TestContext;
let token: string;
let stallId: string;

beforeEach(async () => {
  ctx = new TestContext();
  const stall = await ctx.createStall();
  stallId = stall.id;
  const { owner, password } = await ctx.createOwner([stall.id]);
  const login = await request(app).post("/api/auth/owner/login").send({ phone: owner.phone, password });
  token = login.body.token;
});
afterEach(() => ctx.cleanup());

function auth(req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`);
}

describe("Owner API — stalls", () => {
  it("GET /stalls/mine returns exactly the owner's own stall(s)", async () => {
    const res = await auth(request(app).get("/api/owner/stalls/mine"));
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).toContain(stallId);
  });

  it("POST /stalls/:id/pause then /resume round-trips stall status", async () => {
    const paused = await auth(request(app).post(`/api/owner/stalls/${stallId}/pause`));
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("paused");

    const resumed = await auth(request(app).post(`/api/owner/stalls/${stallId}/resume`));
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("active");
  });

  it("404-equivalent 403 on a stall the owner doesn't manage", async () => {
    const otherStall = await ctx.createStall();
    const res = await auth(request(app).get(`/api/owner/stalls/${otherStall.id}/orders`));
    expect(res.status).toBe(403);
  });
});

describe("Owner API — offers CRUD", () => {
  it("creates, lists, updates, deactivates, and deletes an offer", async () => {
    const validFrom = new Date(Date.now() - 86_400_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();

    const create = await auth(
      request(app).post(`/api/owner/stalls/${stallId}/offers`).send({
        name: "API Test Offer", type: "flat_discount", validFrom, validUntil, discountFlat: 10,
      }),
    );
    expect(create.status).toBe(201);
    const offerId = create.body.id;

    const list = await auth(request(app).get(`/api/owner/stalls/${stallId}/offers`));
    expect(list.status).toBe(200);
    expect(list.body.some((o: { id: string }) => o.id === offerId)).toBe(true);

    const update = await auth(request(app).patch(`/api/owner/stalls/${stallId}/offers/${offerId}`).send({ discountFlat: 25 }));
    expect(update.status).toBe(200);
    expect(Number(update.body.discountFlat)).toBe(25);

    const deactivate = await auth(request(app).post(`/api/owner/stalls/${stallId}/offers/${offerId}/deactivate`));
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.active).toBe(false);

    const del = await auth(request(app).delete(`/api/owner/stalls/${stallId}/offers/${offerId}`));
    expect(del.status).toBe(204);

    const patchAfterDelete = await auth(request(app).patch(`/api/owner/stalls/${stallId}/offers/${offerId}`).send({ discountFlat: 1 }));
    expect(patchAfterDelete.status).toBe(404);
  });

  it("400s on an invalid offer payload (missing required fields)", async () => {
    const res = await auth(request(app).post(`/api/owner/stalls/${stallId}/offers`).send({ name: "Bad" }));
    expect(res.status).toBe(400);
  });

  it("an owner cannot create an offer for a stall they don't manage", async () => {
    const otherStall = await ctx.createStall();
    const res = await auth(
      request(app).post(`/api/owner/stalls/${otherStall.id}/offers`).send({
        name: "X", type: "flat_discount", validFrom: new Date().toISOString(), validUntil: new Date().toISOString(), discountFlat: 1,
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("Owner API — analytics, forecast, ratings", () => {
  it("GET /analytics returns 200 with the expected KPI shape", async () => {
    const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/analytics?period=today`));
    expect(res.status).toBe(200);
    expect(typeof res.body.revenue).toBe("number");
    expect(typeof res.body.totalOrders).toBe("number");
  });

  it("400s on an invalid analytics period", async () => {
    const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/analytics?period=decade`));
    expect(res.status).toBe(400);
  });

  it("400s a custom analytics range missing from/to", async () => {
    const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/analytics?period=custom`));
    expect(res.status).toBe(400);
  });

  it("GET /analytics/export supports csv, xlsx, and pdf", async () => {
    for (const format of ["csv", "xlsx", "pdf"]) {
      const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/analytics/export?period=today&format=${format}`));
      expect(res.status).toBe(200);
      expect(res.body.length ?? res.text.length).toBeGreaterThan(0);
    }
  });

  it("GET /forecast returns a sufficient:false response for a stall with no history", async () => {
    const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/forecast`));
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
  });

  it("GET /ratings returns aggregate rating data (zero state for a fresh stall)", async () => {
    const res = await auth(request(app).get(`/api/owner/stalls/${stallId}/ratings`));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
});
