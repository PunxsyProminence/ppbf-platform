#!/usr/bin/env node
/**
 * Type B plates materializer — 2026-08-24
 * Exact bytes from Grok producer (b64 sidecars on this branch). No re-encode.
 *
 * Owner decision 2026-08-24: Grok owns real JPEG wall plates on its own feature branch.
 * This is the producer hand-off of exact bytes.
 *
 * From repo root:
 *   node scripts/materialize-type-b-plates.mjs
 *
 * Writes six JPEGs into apps/web/public/plates/
 * Leaves plate-01-office-01.jpg and plate-04-board-01.jpg untouched.
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
  console.error('Missing scripts/plates-type-b-b64/ — branch must have the b64 sidecars');
  process.exit(1);
}

let ok = 0;
for (const name of FILES) {
  const b64path = path.join(B64_DIR, name + '.b64');
  if (!fs.existsSync(b64path)) {
    console.error('Missing b64 for', name);
    process.exit(1);
  }
  const b64 = fs.readFileSync(b64path, 'utf8').replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    console.error(name, 'bad SOI after decode');
    process.exit(1);
  }
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    console.error(name, 'missing EOI');
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
  ok++;
}
console.log('Done.', ok, 'Type B plates materialised with exact Grok producer bytes.');
console.log('Next: plateBinaries.test.ts then stage the six .jpg if dirty.');
