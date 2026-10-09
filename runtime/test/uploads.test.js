const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUploadRemover } = require("../uploads");

function setup(fsImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bazis-uploads-"));
  const uploadsDir = path.join(root, "images", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const warns = [];
  const remove = createUploadRemover({ root, uploadsDir, log: { warn: (line) => warns.push(line) }, fsImpl });
  return { root, uploadsDir, warns, remove, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("LOW-01: файл не удалился (занят антивирусом) — console.warn с путём и кодом ошибки", () => {
  const busy = {
    ...fs,
    unlinkSync: () => {
      const err = new Error("resource busy or locked");
      err.code = "EBUSY";
      throw err;
    },
  };
  const ctx = setup(busy);
  try {
    const file = path.join(ctx.uploadsDir, "img_a.jpg");
    fs.writeFileSync(file, "x");
    ctx.remove("images/uploads/img_a.jpg");
    assert.equal(ctx.warns.length, 1);
    assert.ok(ctx.warns[0].includes(file), ctx.warns[0]);
    assert.match(ctx.warns[0], /EBUSY/);
  } finally {
    ctx.cleanup();
  }
});

test("LOW-01: обычное удаление — файл удалён, предупреждений нет; чужие пути не трогаются", () => {
  const ctx = setup(fs);
  try {
    const file = path.join(ctx.uploadsDir, "img_b.jpg");
    fs.writeFileSync(file, "x");
    ctx.remove("images/uploads/img_b.jpg");
    assert.equal(fs.existsSync(file), false);

    const outside = path.join(ctx.root, "images", "logo.jpg");
    fs.writeFileSync(outside, "x");
    ctx.remove("images/uploads/../logo.jpg");
    ctx.remove("images/logo.jpg");
    ctx.remove("images/uploads/missing.jpg");
    assert.ok(fs.existsSync(outside));
    assert.deepEqual(ctx.warns, []);
  } finally {
    ctx.cleanup();
  }
});
