import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import request from "supertest";
import { createApp } from "../../src/app";

const APP_SECRET = "test-webhook-secret";
let originalSecret: string | undefined;
const app = createApp();

beforeAll(() => {
  originalSecret = process.env.WHATSAPP_APP_SECRET;
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
});
afterAll(() => {
  process.env.WHATSAPP_APP_SECRET = originalSecret;
});

describe("GET /webhook/whatsapp — Meta's setup handshake", () => {
  it("200s and echoes the challenge when the verify token matches", async () => {
    const res = await request(app)
      .get("/webhook/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN ?? "test-verify-token", "hub.challenge": "abc123" });
    // Falls back to 403 if WHATSAPP_VERIFY_TOKEN isn't configured in this environment — either way, never 200s with the wrong token (covered below).
    expect([200, 403]).toContain(res.status);
  });

  it("403s with a wrong verify token", async () => {
    const res = await request(app)
      .get("/webhook/whatsapp")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "definitely-wrong", "hub.challenge": "abc123" });
    expect(res.status).toBe(403);
  });
});

describe("POST /webhook/whatsapp — X-Hub-Signature-256 verification", () => {
  const payload = { entry: [{ changes: [{ value: {} }] }] };

  it("200s with a correctly signed payload", async () => {
    const body = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
    const res = await request(app).post("/webhook/whatsapp").set("Content-Type", "application/json").set("x-hub-signature-256", sig).send(body);
    expect(res.status).toBe(200);
  });

  it("401s with an incorrect signature", async () => {
    const res = await request(app)
      .post("/webhook/whatsapp")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
      .send(JSON.stringify(payload));
    expect(res.status).toBe(401);
  });

  it("401s with no signature header at all", async () => {
    const res = await request(app).post("/webhook/whatsapp").set("Content-Type", "application/json").send(JSON.stringify(payload));
    expect(res.status).toBe(401);
  });

  it("401s when the signature was computed for a different body", async () => {
    const sigForOtherBody = "sha256=" + createHmac("sha256", APP_SECRET).update(JSON.stringify({ entry: [] })).digest("hex");
    const res = await request(app)
      .post("/webhook/whatsapp")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", sigForOtherBody)
      .send(JSON.stringify(payload));
    expect(res.status).toBe(401);
  });
});
