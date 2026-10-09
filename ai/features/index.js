const fs = require("fs");
const path = require("path");

/** Все *.js в этой папке (кроме index.js) подключаются как фичи автоматически. */
function loadFeatures(dir = __dirname) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js") && file !== "index.js")
    .sort()
    .map((file) => require(path.join(dir, file)));
}

module.exports = { loadFeatures };
