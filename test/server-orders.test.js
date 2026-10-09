const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox, startServer, ADMIN_PASSWORD } = require("./server-sandbox");

const LEAD = { customerName: "Тест Админ", customerPhone: "+7 701 000 00 02", channel: "site", lead: { direction: "", comment: "" } };

let sandbox;
let server;
test.before(async () => {
  sandbox = createSandbox();
  server = await startServer(sandbox);
});
test.after(async () => {
  if (server) await server.stop();
  sandbox.cleanup();
});

function postOrder(headers = {}) {
  return fetch(server.url + "/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(LEAD),
  });
}

test("MED-02: верный пароль админки не освобождает POST /api/orders от антиспам-токена", async () => {
  const res = await postOrder({ "X-Admin-Password": ADMIN_PASSWORD });
  const body = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.error, "challenge_required");
});

test("MED-02: ответ не зависит от пароля — по нему нельзя подбирать пароль", async () => {
  const right = await postOrder({ "X-Admin-Password": ADMIN_PASSWORD });
  const wrong = await postOrder({ "X-Admin-Password": "wrong-password-123" });
  const none = await postOrder();
  const bodies = await Promise.all([right, wrong, none].map((res) => res.json()));
  assert.deepEqual([right.status, wrong.status, none.status], [403, 403, 403]);
  assert.deepEqual(bodies.map((body) => body.error), ["challenge_required", "challenge_required", "challenge_required"]);
});
