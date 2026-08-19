#!/usr/bin/env node
/**
 * Decode Plate Set v1-g: writes JPGs from sibling .b64 files in public/plates.
 * Prefer: npm run plates:materialize  (same effect + magic-byte safety)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps/web/public/plates"
);
const names = [
  "plate-01-office-01.jpg",
  "plate-02a-floor-landscape-01.jpg",
  "plate-02b-floor-portrait-01.jpg",
  "plate-03-clinic-01.jpg",
  "plate-04-board-01.jpg",
  "plate-05-file-01.jpg",
  "plate-06-night-01.jpg",
  "plate-07-warm-ground-01.jpg",
];
let n = 0;
for (const name of names) {
  const b64path = path.join(dir, name + ".b64");
  if (!fs.existsSync(b64path)) {
    console.warn("skip missing", b64path);
    continue;
  }
  const raw = fs.readFileSync(b64path, "utf8").replace(/\s/g, "");
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    console.error("not jpeg", name);
    process.exit(1);
  }
  fs.writeFileSync(path.join(dir, name), buf);
  console.log("wrote", name, buf.length);
  n++;
}
console.log("decoded", n, "plates");
