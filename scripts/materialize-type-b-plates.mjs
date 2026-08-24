#!/usr/bin/env node
/**
 * Type B plates materializer — 2026-08-24
 * Exact bytes from Grok producer. No re-encode. No Drive/SharePoint required.
 *
 * From repo root:
 *   node scripts/materialize-type-b-plates.mjs
 *
 * Writes the six Type B plates into apps/web/public/plates/
 * (leaves plate-01-office-01.jpg and plate-04-board-01.jpg untouched)
 *
 * Source: Grok-Plates-Inbox real 4:4:4 JPEGs (quiet centre, under ~400 KB cap).
 * The .b64 sidecars live at scripts/plates-type-b-b64/ (committed on this branch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'apps/web/public/plates');
const B64_DIR = path.join(__dirname, 'plates-type-b-b64');

const FILES = [
  'plate-02a-floor-landscape-01.jpg',
  'plate-02b-floor-portrait-01.jpg',
  'plate-03-clinic-01.jpg',
  'plate-05-file-01.jpg',
  'plate-06-night-01.jpg',
  'plate-07-warm-ground-01.jpg',
];

if (!fs.existsSync(OUT)) {
  console.error('Missing apps/web/public/plates — run from repo root after clone/checkout');
  process.exit(1);
}
if (!fs.existsSync(B64_DIR)) {
  console.error('Missing scripts/plates-type-b-b64/ — ensure branch has the b64 sidecars');
  process.exit(1);
}

let ok = 0;
for (const name of FILES) {
  const b64path = path.join(B64_DIR, name + '.b64');
  if (!fs.existsSync(b64path)) {
    console.error('Missing b64 for', name, 'at', b64path);
    process.exit(1);
  }
  const b64 = fs.readFileSync(b64path, 'utf8').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  // sanity: JPEG SOI + EOI
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    console.error(name, 'not a JPEG after decode (bad SOI)');
    process.exit(1);
  }
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    console.error(name, 'missing EOI trailer');
    process.exit(1);
  }
  const outPath = path.join(OUT, name);
  fs.writeFileSync(outPath, buf);
  console.log('wrote', name, buf.length, 'bytes');
  ok++;
}
console.log('Done.', ok, 'Type B plates materialised with exact producer bytes.');
console.log('Next: run plateBinaries.test.ts then open PR.');
