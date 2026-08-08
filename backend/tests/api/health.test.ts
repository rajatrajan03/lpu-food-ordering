import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("GET /health", () => {
  it("returns 200 with db connectivity info", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("connected");
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("echoes a request id header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("respects a client-supplied X-Request-Id instead of generating a new one", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "test-fixed-id-123");
    expect(res.headers["x-request-id"]).toBe("test-fixed-id-123");
  });
});

describe("GET /privacy-policy", () => {
  it("returns 200 HTML", async () => {
    const res = await request(app).get("/privacy-policy");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("html");
  });
});

describe("Unknown routes", () => {
  it("returns 404 for a path that doesn't exist", async () => {
    const res = await request(app).get("/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });
});
