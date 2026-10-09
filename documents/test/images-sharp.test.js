/** MED-04: sharp не загружается (сломанная установка). Отдельный файл — node --test запускает его в своём процессе. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "sharp") throw new Error("simulated: sharp binary is missing");
  return originalLoad.call(this, request, ...rest);
};
const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => consoleErrors.push(args.join(" "));
test.after(() => {
  Module._load = originalLoad;
  console.error = originalError;
});

const { createImageLoader, sharpStatus } = require("../images");

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

test("MED-04: сбой загрузки sharp — одна ошибка в журнале с причиной и статус для check:prod", () => {
  const status = sharpStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /simulated/);
  sharpStatus();
  const sharpErrors = consoleErrors.filter((line) => /sharp/.test(line));
  assert.equal(sharpErrors.length, 1, consoleErrors.join("\n"));
  assert.match(sharpErrors[0], /simulated/);
});

test("MED-04: без sharp WebP пропускается с предупреждением о формате, JPEG/PNG вставляются", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-img-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const warns = [];
  const loader = createImageLoader({ rootDir: cacheDir, cacheDir, log: { warn: (msg) => warns.push(String(msg)) } });

  assert.equal(await loader.load("data:image/webp;base64," + WEBP.toString("base64")), null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /image\/webp не поддерживается без sharp/);

  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  assert.match(await loader.load(png), /^data:image\/png;base64,/);
  assert.equal(warns.length, 1);
});
