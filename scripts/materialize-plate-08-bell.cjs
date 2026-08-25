#!/usr/bin/env node
/**
 * Decode plate-08 Bell gym wall plates from adjacent .b64 sidecars.
 * Grok 2026-08-25. Run from repo root:
 *   node scripts/materialize-plate-08-bell.cjs
 * Then commit the two .jpg files under apps/web/public/plates/
 * Byte gate: plateBinaries.test.ts (SOI+EOI, >8KB, <=400KB, 4:4:4, geometry).
 */
const fs = require("fs");
const path = require("path");

const scriptsDir = __dirname;
const platesDir = path.join(__dirname, "..", "apps", "web", "public", "plates");
fs.mkdirSync(platesDir, { recursive: true });

const names = [
  "plate-08-bell-gym-landscape-01.jpg",
  "plate-08-bell-gym-portrait-01.jpg",
];

for (const name of names) {
  const b64Path = path.join(scriptsDir, name + ".b64");
  const outPath = path.join(platesDir, name);
  if (!fs.existsSync(b64Path)) {
    console.error("missing", b64Path);
    process.exit(1);
  }
  const buf = Buffer.from(fs.readFileSync(b64Path, "utf8").trim(), "base64");
  fs.writeFileSync(outPath, buf);
  const soi = buf[0] === 0xff && buf[1] === 0xd8;
  const eoi = buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  console.log(name, buf.length, "SOI=" + soi, "EOI=" + eoi);
}
