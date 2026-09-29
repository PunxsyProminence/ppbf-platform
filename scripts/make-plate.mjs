#!/usr/bin/env node
/*
 * MAKE A BACKGROUND PLATE, FROM THIS GYM.
 * ---------------------------------------------------------------------------
 * Owner instructions, 2026-09-26: "work with the connectors to make one", then
 * "let's shift to making and filling the plate library", then — asked who owns
 * plate production now — "anyone that makes a good one".
 *
 * THIS SCRIPT DEFINES NOTHING. It reads two authorities and obeys them:
 *
 *   docs/REAL-GYM-REFERENCE-LOCK.md   what this gym looks like
 *   design-system/plate-contract.json what a valid plate is
 *
 * That is deliberate, and it is the correction of a real fault. The first
 * version embedded its own description of the gym, taken from photographs, while
 * the lock still carried older facts — so the repository would have held two
 * different descriptions of the same building and the newer one would have been
 * buried in a generator. ChatGPT's standards review of PR #982 called that
 * authority drift and was right. The same review found the byte rules had been
 * copied here and had ALREADY diverged: the gate accepted four geometries, this
 * script knew two, while calling itself a restatement. Both copies are gone.
 *
 * REFERENCE-GUIDED, NEVER INVENTED. The lock's Mode A requires 2-4 of the
 * owner's reference photographs per generation. They live outside the repository
 * on purpose — faces and minors — at the folder the lock names, overridable with
 * PPBF_GYM_REFERENCE. A plate generated from another generated plate is a copy of
 * a copy, and that is how a homemade timber bag frame became ceiling chains and
 * pale plank walls became dark ones.
 *
 * NOTHING IS WRITTEN INTO THE PLATE LIBRARY UNTIL IT HAS PASSED. Generation goes
 * to a temporary file, the contract is checked there, and only a passing plate is
 * promoted. --force governs that promotion and can no longer destroy a committed
 * plate with a failed one.
 *
 * USAGE
 *   AZ_AI_KEY=$(az cognitiveservices account keys list -n shadow-ai \
 *     -g ppbf-shadow-rg --query key1 -o tsv) \
 *   node scripts/make-plate.mjs \
 *     --out plate-14-frontdesk-landscape-01.jpg \
 *     --ref 07-the-ring-red-floor.jpg --ref 08-blue-mat-room.jpg \
 *     --subject "the front desk, seen from the door" \
 *     [--portrait] [--force] [--dry-run]
 *
 * The key is read from the environment and is never logged.
 */

import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/* Resolved from this file, not from process.cwd(): the script used to target
   whatever directory it happened to be run from, which silently pointed the
   library somewhere else when invoked from a subdirectory. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATES = path.join(ROOT, 'apps', 'web', 'public', 'plates');
const LOCK = path.join(ROOT, 'docs', 'REAL-GYM-REFERENCE-LOCK.md');
const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'design-system', 'plate-contract.json'), 'utf8'));

/* The owner's photographs. Named in the lock; overridable for another machine.
   A reference must live here or in the plate library — a --ref that accepted any
   absolute path would base64 whatever it was pointed at and post it to an
   external endpoint. */
const GYM_REFERENCE = process.env.PPBF_GYM_REFERENCE
  || path.join(process.env.USERPROFILE || process.env.HOME || '', 'PPBF-Gym-Reference');
const APPROVED_REF_DIRS = [GYM_REFERENCE, PLATES];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

const ENDPOINT = 'https://shadow-ai.cognitiveservices.azure.com/';
const DEPLOYMENT = 'flux-kontext-plates';
const REQUEST_TIMEOUT_MS = 180_000;

/* ---- the gym, read from the lock ---------------------------------------- */

/**
 * Builds the gym description out of the lock's own DNA table, so there is one
 * description of this building and it is the approved one. Provenance tags
 * (`[PHOTO 2026-09-26]`, `[CONFIRMED ...]`) are stripped: they are there for a
 * reader deciding whether to trust a row, not for an image model.
 */
function readGymDna() {
  const doc = readFileSync(LOCK, 'utf8');
  const start = doc.indexOf('## 2. Locked visual DNA');
  if (start === -1) {
    throw new Error(`${LOCK}: section "2. Locked visual DNA" not found — the lock's shape changed`);
  }
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);

  const rows = [...section.matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map(([, element, text]) => [
      element,
      text
        .replace(/`\[[^\]]*\]`/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/[;.\s]+$/, ''),
    ]);
  if (rows.length < 5) {
    throw new Error(`${LOCK}: parsed only ${rows.length} DNA rows — the table's shape changed`);
  }

  const forbidden = [...section.matchAll(/^-\s+(.+)$/gm)].map((m) => m[1].trim());

  return {
    dna: rows.map(([el, text]) => `${el}: ${text}.`).join(' '),
    forbidden: forbidden.length ? `Not any of these: ${forbidden.join('; ')}.` : '',
    rowCount: rows.length,
  };
}

/* Composition and lettering are Mode A rules. Lettering is stated three ways
   because one phrasing gets ignored, and text inside a plate competes with the
   UI text drawn over it. One exception, owner 2026-09-28 ("no i like that you
   can leave it", OD-2026-09-28-013, lock Mode A item 4): the IRON CITY
   lettering on the ring canvas stays when the ring is in frame. The real canvas
   reads IRON CITY BREWERY (lock section 1), so the prompt spells that out
   rather than invite the model to drop a word. Everything else stays forbidden. */
const COMPOSITION = 'Composition: the centre of the frame is QUIET and uncluttered because interface text is laid over it, and all visual interest sits in the outer thirds. No people.';
const NO_TEXT = 'The only lettering allowed is the lettering printed on the boxing ring canvas itself, which reads IRON CITY BREWERY, and only when the ring is in frame. ABSOLUTELY NO OTHER TEXT anywhere in the frame: no other writing, no other letters, no numbers, no words, no signage, no posters, no banners, no readable chalkboards or whiteboards, no labels, no other logos, no other brand marks.';

/* ---- arguments ----------------------------------------------------------- */

function argValues(name) {
  const values = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    /* A missing value used to swallow the next flag: `--subject --force` set the
       subject to "--force" and spent a paid call on it. */
    if (v === undefined || v.startsWith('--')) {
      console.error(`--${name} needs a value`);
      process.exit(2);
    }
    values.push(v);
  }
  return values;
}
const arg = (name) => argValues(name)[0] ?? null;
const flag = (name) => process.argv.includes(`--${name}`);

const out = arg('out');
const refs = argValues('ref');
const subject = arg('subject');
const orientation = flag('portrait') ? 'portrait' : 'landscape';

if (!out || refs.length === 0 || !subject) {
  console.error('need --out, --ref (2-4 times) and --subject; see the header of this file');
  process.exit(2);
}
if (!/^plate-[0-9a-z-]+\.jpg$/.test(out)) {
  console.error(`--out must be a plate-*.jpg filename, got ${out}`);
  process.exit(2);
}
/* Anchored to the end of the stem rather than searched for anywhere in it: a
   landscape plate for the Portrait Review surface is a legitimate filename. */
if (/-portrait(-\d+)?\.jpg$/.test(out) !== (orientation === 'portrait')) {
  console.error(`filename and orientation disagree: ${out} vs ${orientation}`);
  process.exit(2);
}

/* Mode A, docs/REAL-GYM-REFERENCE-LOCK.md: at least 2-4 owner reference photos
   per generation. The first version sent one, and chained three plates off
   earlier generated plates — a copy of a copy. */
if (refs.length < 2 || refs.length > 4) {
  console.error(`the reference lock's Mode A wants 2-4 reference photographs; got ${refs.length}`);
  process.exit(2);
}

function resolveRef(ref) {
  const absolute = path.isAbsolute(ref) ? path.resolve(ref) : null;
  const candidates = absolute ? [absolute] : APPROVED_REF_DIRS.map((d) => path.join(d, ref));
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    console.error(`reference not found: ${ref}\n  looked in: ${APPROVED_REF_DIRS.join('\n             ')}`);
    process.exit(2);
  }
  if (!IMAGE_EXT.has(path.extname(found).toLowerCase())) {
    console.error(`reference is not an image: ${found}`);
    process.exit(2);
  }
  const inApproved = APPROVED_REF_DIRS.some((d) => {
    const rel = path.relative(path.resolve(d), found);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!inApproved) {
    console.error(
      'reference is outside the approved locations, and this script posts its references to an external endpoint:\n'
      + `  ${found}\n  approved: ${APPROVED_REF_DIRS.join(', ')}`,
    );
    process.exit(2);
  }
  return found;
}
const refPaths = refs.map(resolveRef);

const { dna, forbidden, rowCount } = readGymDna();
const PROMPT = `${subject}. ${dna} ${forbidden} ${NO_TEXT} ${COMPOSITION}`;

if (flag('dry-run')) {
  console.log(`DNA rows read from the lock: ${rowCount}`);
  console.log(`references (${refPaths.length}):\n  ${refPaths.join('\n  ')}`);
  console.log('\nPROMPT:\n' + PROMPT);
  process.exit(0);
}

const KEY = process.env.AZ_AI_KEY;
if (!KEY) {
  console.error('AZ_AI_KEY is not set. See the usage note at the top of this file.');
  process.exit(2);
}

const geometry = CONTRACT.producerOutputs[orientation];
if (!CONTRACT.geometries.includes(geometry)) {
  console.error(`producer output ${geometry} is not one of the contract's geometries`);
  process.exit(2);
}
const [w, h] = geometry.split('x').map(Number);

/* The model returns its own near-enough size; the exact shape is cut below. */
const askFor = orientation === 'portrait' ? '752x1392' : '1392x752';

/* Downscaled before encoding: a phone photograph is 3-5MB and base64 inflates it
   by a third inside a single JSON body. */
async function encodeRef(file) {
  const buf = await sharp(file)
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return buf.toString('base64');
}
const encoded = await Promise.all(refPaths.map(encodeRef));

const body = {
  prompt: PROMPT,
  n: 1,
  size: askFor,
  output_format: 'png',
  image: encoded.length === 1 ? encoded[0] : encoded,
};

const res = await fetch(
  `${ENDPOINT}openai/deployments/${DEPLOYMENT}/images/generations?api-version=2025-04-01-preview`,
  {
    method: 'POST',
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  },
);
if (!res.ok) {
  console.error(`generation failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const json = await res.json();
const b64 = json?.data?.[0]?.b64_json;
const url = json?.data?.[0]?.url;
/* Neither field used to be checked, so a response carrying no image at all — a
   content filter, a shape change — reached fetch(undefined) and threw an
   unhandled TypeError after the call had been paid for. */
if (!b64 && !url) {
  console.error(`generation returned no image payload: ${JSON.stringify(json).slice(0, 400)}`);
  process.exit(1);
}
let raw;
if (b64) {
  raw = Buffer.from(b64, 'base64');
} else {
  const img = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!img.ok) {
    console.error(`image download failed: ${img.status}`);
    process.exit(1);
  }
  raw = Buffer.from(await img.arrayBuffer());
}

/* STAGED, NOT WRITTEN IN PLACE. The plate library is a committed asset location
   and a shipped plate is evidence. The first version wrote the candidate straight
   into it and validated afterwards, so a failed generation left a bad plate where
   it could be committed, and --force destroyed a good committed plate before
   knowing whether its replacement passed. */
const stage = mkdtempSync(path.join(tmpdir(), 'ppbf-plate-'));
const candidate = path.join(stage, out);
let promoted = false;
try {
  await sharp(raw)
    .resize(w, h, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
    .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
    .toFile(candidate);

  const bytes = statSync(candidate).size;
  const buf = readFileSync(candidate);
  const meta = await sharp(candidate).metadata();

  const faults = [];
  if (`${meta.width}x${meta.height}` !== geometry) faults.push(`geometry ${meta.width}x${meta.height}, wanted ${geometry}`);
  if (meta.chromaSubsampling !== CONTRACT.chromaSubsampling) faults.push(`chroma ${meta.chromaSubsampling}, wanted ${CONTRACT.chromaSubsampling}`);
  if (bytes <= CONTRACT.minBytes || bytes > CONTRACT.maxBytes) faults.push(`${bytes} bytes, outside ${CONTRACT.minBytes}-${CONTRACT.maxBytes}`);
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) faults.push('no SOI marker');
  if (!(buf[bytes - 2] === 0xff && buf[bytes - 1] === 0xd9)) faults.push('no EOI marker');

  console.log(`${out}  ${meta.width}x${meta.height}  ${meta.chromaSubsampling}  ${bytes} bytes`);
  console.log(`references: ${refPaths.map((p) => path.basename(p)).join(', ')}`);

  if (faults.length) {
    console.error(`REJECTED, nothing written to the library:\n  ${faults.join('\n  ')}`);
    process.exit(1);
  }

  const destination = path.join(PLATES, out);
  if (existsSync(destination) && !flag('force')) {
    console.error(
      `${out} passed the contract, but it already exists in the library and a shipped plate is evidence.\n`
      + '  pass --force to replace the committed one',
    );
    process.exit(2);
  }
  renameSync(candidate, destination);
  promoted = true;
  console.log(`promoted to ${path.relative(ROOT, destination)}`);
  console.log('LOOK AT IT before committing. The contract checks bytes, not whether the room is this gym.');
} finally {
  rmSync(stage, { recursive: true, force: true });
  if (!promoted) console.error('the plate library was not modified.');
}
