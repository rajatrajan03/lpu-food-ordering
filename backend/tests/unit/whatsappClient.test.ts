import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  vi.resetModules();
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

async function loadClientWithFetchStub(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  return import("../../src/whatsapp/client");
}

describe("whatsapp/client — notification helpers", () => {
  it("sendWhatsAppText posts to the correct Graph API URL with the phone number id and bearer token", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = await loadClientWithFetchStub(async (url, init) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    await client.sendWhatsAppText("919999999999", "Hello there");

    expect(capturedUrl).toContain("123456/messages");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "919999999999", type: "text", text: { body: "Hello there" } });
  });

  it("sendWhatsAppText logs but does not throw when the API responds with an error", async () => {
    const client = await loadClientWithFetchStub(async () => new Response("bad request", { status: 400 }));
    await expect(client.sendWhatsAppText("919999999999", "Hi")).resolves.toBeUndefined();
  });

  it("propagates a thrown network error rather than swallowing it silently", async () => {
    // sendWhatsAppText only guards against a resolved-but-non-ok response
    // (logs and returns); a genuine network failure (fetch itself rejects)
    // is not caught here — every caller (e.g.
    // orderService.notifyStudentOfStatus) wraps its own try/catch around
    // this specifically because of that. Documented via this test so a
    // future "let's add error handling here" change doesn't silently
    // change that contract without updating the callers that rely on it.
    const client = await loadClientWithFetchStub(async () => {
      throw new Error("network down");
    });
    await expect(client.sendWhatsAppText("919999999999", "Hi")).rejects.toThrow("network down");
  });

  it("sendWhatsAppButtons caps titles at 20 characters and sends at most 3 buttons", async () => {
    let capturedBody: any;
    const client = await loadClientWithFetchStub(async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response("{}", { status: 200 });
    });

    await client.sendWhatsAppButtons("919999999999", "Choose one", [
      { id: "a", title: "This title is definitely longer than twenty characters" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
      { id: "d", title: "D — should be dropped, only 3 allowed" },
    ]);

    expect(capturedBody.interactive.action.buttons).toHaveLength(3);
    expect(capturedBody.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });

  it("sendWhatsAppList caps rows at 10 and truncates title/description to WhatsApp's limits", async () => {
    let capturedBody: any;
    const client = await loadClientWithFetchStub(async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response("{}", { status: 200 });
    });

    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `row-${i}`,
      title: `Row title number ${i} that is quite long indeed`,
      description: "D".repeat(100),
    }));
    await client.sendWhatsAppList("919999999999", "Pick one", "Choose", rows);

    const sentRows = capturedBody.interactive.action.sections[0].rows;
    expect(sentRows).toHaveLength(10);
    expect(sentRows[0].title.length).toBeLessThanOrEqual(24);
    expect(sentRows[0].description.length).toBeLessThanOrEqual(72);
  });

  it("sendWhatsAppList omits the description field entirely when none is given", async () => {
    let capturedBody: any;
    const client = await loadClientWithFetchStub(async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response("{}", { status: 200 });
    });

    await client.sendWhatsAppList("919999999999", "Pick one", "Choose", [{ id: "x", title: "No description here" }]);
    expect(capturedBody.interactive.action.sections[0].rows[0]).not.toHaveProperty("description");
  });
});
