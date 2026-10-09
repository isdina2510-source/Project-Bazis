const { parentPort } = require("worker_threads");
const { parseAttachments } = require("./attachments");

parentPort.once("message", async ({ list, limit }) => {
  try {
    const attachments = await parseAttachments(list, { limit });
    parentPort.postMessage({ ok: true, attachments });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
});
