#!/usr/bin/env node
/** node scripts/decode-plates.mjs — writes JPGs from sibling .b64 files in public/plates */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const plates = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps/web/public/plates");
for (const f of fs.readdirSync(plates).filter((x) => x.endsWith(".jpg.b64"))) {
  const name = f.replace(/\.b64$/, "");
  const buf = Buffer.from(fs.readFileSync(path.join(plates, f), "utf8"), "base64");
  fs.writeFileSync(path.join(plates, name), buf);
  console.log("wrote", name, buf.length);
}
