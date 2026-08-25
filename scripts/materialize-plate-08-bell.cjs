#!/usr/bin/env node
/**
 * Materialize plate-08 Bell gym wall plates.
 * Grok 2026-08-25. Sources (first match wins):
 *   1) scripts/<name>.b64 (full)
 *   2) scripts/chunks/{landscape|portrait}.part* (joined)
 * Output: apps/web/public/plates/<name>
 * Byte gate: plateBinaries.test.ts
 */
const fs = require("fs");
const path = require("path");

const scriptsDir = __dirname;
const platesDir = path.join(__dirname, "..", "apps", "web", "public", "plates");
const chunksDir = path.join(scriptsDir, "chunks");
fs.mkdirSync(platesDir, { recursive: true });

const specs = [
  { name: "plate-08-bell-gym-landscape-01.jpg", prefix: "landscape" },
  { name: "plate-08-bell-gym-portrait-01.jpg", prefix: "portrait" },
];

function loadB64(spec) {
  const full = path.join(scriptsDir, spec.name + ".b64");
  if (fs.existsSync(full)) return fs.readFileSync(full, "utf8").trim();
  if (!fs.existsSync(chunksDir)) throw new Error("no b64 for " + spec.name);
  const parts = fs.readdirSync(chunksDir).filter((f) => f.startsWith(spec.prefix + ".part")).sort();
  if (!parts.length) throw new Error("no chunks for " + spec.prefix);
  return parts.map((p) => fs.readFileSync(path.join(chunksDir, p), "utf8").trim()).join("");
}

for (const spec of specs) {
  const b64 = loadB64(spec);
  const buf = Buffer.from(b64, "base64");
  const dest = path.join(platesDir, spec.name);
  fs.writeFileSync(dest, buf);
  const soi = buf[0] === 0xff && buf[1] === 0xd8;
  const eoi = buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  console.log(spec.name, buf.length, "SOI=" + soi, "EOI=" + eoi);
}
