"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "tmp", "klinvekt-mobile-server");
const publicOutput = path.join(output, "public");
const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(publicOutput, { recursive: true });
fs.cpSync(path.join(root, "mobile-pilot"), publicOutput, { recursive: true });
fs.copyFileSync(path.join(root, "mobile-server", "server.cjs"), path.join(output, "server.cjs"));
fs.copyFileSync(
  path.join(root, "desktop", "services", "mobile-publication-service.cjs"),
  path.join(output, "mobile-publication-service.cjs"),
);
fs.writeFileSync(path.join(output, "package.json"), `${JSON.stringify({
  name: "klinvekt-mobile-server",
  version: appVersion,
  private: true,
  engines: { node: ">=22" },
  scripts: { start: "node server.cjs" },
}, null, 2)}\n`, "utf8");

process.stdout.write(`${output}\n`);
