#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps/web/public/plates");
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
for (const name of names) {
  const b64path = path.join(dir, name + ".b64");
  if (!fs.existsSync(b64path)) {
    console.warn("skip missing", b64path);
    continue;
  }
  const buf = Buffer.from(fs.readFileSync(b64path, "utf8").replace(/\s/g, ""), "base64");
  fs.writeFileSync(path.join(dir, name), buf);
  console.log("wrote", name, buf.length);
}
