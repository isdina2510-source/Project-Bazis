import { describe, expect, test, vi } from "vitest";

const submitPublicOrder = vi.fn();
vi.mock("../lib/orders-db.js", () => ({
  newOrderId: () => "ord_11111111-2222-3333-4444-555555555555",
  submitPublicOrder: (...args) => submitPublicOrder(...args),
}));

const { createChatLeadSession, sendChatLead } = await import("./handoff-lead.js");
const { flushLeadOutbox, OUTBOX_TTL_MS } = await import("./lead-outbox.js");

const OUTBOX_KEY = "bazis_chat_lead_outbox";
const HISTORY = [
  { role: "user", text: "Нужен сайт для салона, мой номер +7 701 123 45 67" },
  { role: "assistant", text: "Подскажу по сайту." },
];

function apiError(code, status) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  return err;
}

const outbox = () => JSON.parse(localStorage.getItem(OUTBOX_KEY) || "{}");

describe("MED-13: заявка из ИИ-чата не теряется", () => {
  test("отправка не удалась — заявка остаётся в localStorage и досылается при следующем визите с тем же id", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    submitPublicOrder.mockReset().mockRejectedValue(apiError("network"));
    const session = createChatLeadSession();
    const sending = sendChatLead(session, { history: HISTORY, channel: "whatsapp", direction: "infrastructure" });
    await vi.advanceTimersByTimeAsync(6000);
    await sending;
    vi.useRealTimers();

    expect(session.sent).toBe(false);
    const saved = outbox()[session.id];
    expect(saved.body.id).toBe(session.id);
    expect(saved.body.channel).toBe("chat");
    expect(saved.body).not.toHaveProperty("proof");

    // Следующий визит: сервер доступен.
    submitPublicOrder.mockReset().mockResolvedValue({ id: session.id, duplicate: true });
    await flushLeadOutbox();
    expect(submitPublicOrder).toHaveBeenCalledTimes(1);
    expect(submitPublicOrder.mock.calls[0][0].id).toBe(session.id);
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  test("страницу закрыли до ответа сервера — заявка уже лежит в localStorage", () => {
    submitPublicOrder.mockReset().mockReturnValue(new Promise(() => {}));
    const session = createChatLeadSession();
    sendChatLead(session, { history: HISTORY, channel: "telegram" });
    expect(outbox()[session.id].body.handoff).toBe("telegram");
  });

  test("успешная отправка — в localStorage ничего не остаётся", async () => {
    submitPublicOrder.mockReset().mockResolvedValue({ id: "x" });
    const session = createChatLeadSession();
    await sendChatLead(session, { history: HISTORY, channel: "whatsapp" });
    expect(session.sent).toBe(true);
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  test("заявки старше 7 дней удаляются без отправки", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    submitPublicOrder.mockReset();
    const now = Date.now();
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify({
        old: { body: { id: "old" }, savedAt: now - OUTBOX_TTL_MS - 1000 },
        fresh: { body: { id: "fresh" }, savedAt: now - OUTBOX_TTL_MS + 60000 },
      })
    );
    submitPublicOrder.mockResolvedValue({});
    await flushLeadOutbox({ now });
    expect(submitPublicOrder.mock.calls.map(([body]) => body.id)).toEqual(["fresh"]);
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  test("лимит или сбой сети — заявка ждёт следующего визита; отказ по существу (400) — удаляется", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    localStorage.setItem(
      OUTBOX_KEY,
      JSON.stringify({
        limited: { body: { id: "limited" }, savedAt: now },
        rejected: { body: { id: "rejected" }, savedAt: now },
      })
    );
    submitPublicOrder.mockReset().mockImplementation(async (body) => {
      throw body.id === "limited" ? apiError("rate_limited", 429) : apiError("message_required", 400);
    });
    await flushLeadOutbox({ now });
    expect(Object.keys(outbox())).toEqual(["limited"]);
  });
});
