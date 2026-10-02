#!/usr/bin/env node
/*
 * MAKE A BACKGROUND PLATE, FROM THIS GYM.
 * ---------------------------------------------------------------------------
 * Owner instructions, 2026-09-26: "work with the connectors to make one", then
 * "let's shift to making and filling the plate library", then — asked who owns
 * plate production now — "anyone that makes a good one".
 *
 * THIS SCRIPT DEFINES NOTHING. It reads three authorities and obeys them:
 *
 *   docs/REAL-GYM-REFERENCE-LOCK.md   what this gym looks like
 *   docs/ROOM-MAP.md                  which rooms exist, and which train
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
 * EVERY PLATE NAMES ITS ROOM (--room). The lock's ring-and-bags DNA applies to
 * training rooms only; every other room follows the room map (OD-2026-09-28-009
 * item 5, lock section 2 "Scope"). Before the flag existed every prompt carried
 * the whole DNA table, so a front-desk or clinic plate was asked for a boxing
 * ring — plate-14 (front desk) shows the ring, the bags and a lettered banner.
 * The flag is required, not defaulted, because forgetting it is exactly how a
 * non-training plate picks the ring back up.
 *
 * THE REFERENCES MATTER AS MUCH AS THE PROMPT. The image model copies what it
 * sees in the reference photographs, so a non-training plate made from the ring
 * photo gets the ring whatever the prompt says. For a non-training room, pass
 * frames without the ring or the bag frames; a --ref whose filename names a ring,
 * a bag or a mat prints a warning. Frames 04, 05 and 06, opened 2026-09-29
 * (OBSERVED), show no ring, but none is free of training kit: 06 is plank wall,
 * flag and a wood-framed mirror with a reflex bag and glove shelving at the
 * edge; 04 is grey block wall, certificates and posters over the treadmills and
 * elliptical, with a speed bag far back; 05 is the locker room. The other seven
 * frames were not opened for this.
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
 *     --room front-desk \
 *     --ref 06-flag-and-mirror-wall.jpg --ref 04-cardio-and-certificates.jpg \
 *     --subject "the front desk, seen from the door" \
 *     [--portrait] [--force] [--dry-run]
 *
 * --room is a room from docs/ROOM-MAP.md, as a slug: lower case, a leading
 * "The" dropped, apostrophes dropped, spaces as hyphens (THE FLOOR -> floor,
 * COACH'S OFFICE -> coachs-office). An unknown or missing room prints the list.
 * --dry-run prints the prompt, the room and the DNA rows kept and left out, and
 * makes no network call.
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
const ROOM_MAP = path.join(ROOT, 'docs', 'ROOM-MAP.md');
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
    rows,
    forbidden: forbidden.length ? `Not any of these: ${forbidden.join('; ')}.` : '',
  };
}

/* ---- the rooms, read from the room map ----------------------------------- */

/**
 * Every room in docs/ROOM-MAP.md's "The building, as a path through it", with
 * whether it stands on "The training side". A room is a bold heading followed
 * by an em dash (`**THE FLOOR** — today`, `**CLINIC** (10) — clearance`); its
 * side is the `###` heading above it. The script keeps no list of its own, so
 * a room the map adds or moves is picked up here without an edit.
 */
function readRooms() {
  const doc = readFileSync(ROOM_MAP, 'utf8');
  const start = doc.indexOf('## The building, as a path through it');
  if (start === -1) {
    throw new Error(`${ROOM_MAP}: section "The building, as a path through it" not found — the room map's shape changed`);
  }
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);

  const rooms = [];
  let side = '';
  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      side = heading[1];
      continue;
    }
    const room = line.match(/^\*\*([^*]+)\*\*(?:\s*\(\d+\))?\s+—/);
    if (!room) continue;
    const name = room[1].trim();
    const slug = name
      .toLowerCase()
      .replace(/^the\s+/, '')
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    rooms.push({ slug, name, training: /^the training side\b/i.test(side) });
  }

  const slugs = rooms.map((r) => r.slug);
  const repeated = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (rooms.length < 10 || repeated.length) {
    throw new Error(
      `${ROOM_MAP}: parsed ${rooms.length} rooms${repeated.length ? `, repeated: ${repeated.join(', ')}` : ''} — the room list's shape changed`,
    );
  }
  if (!rooms.some((r) => r.training)) {
    throw new Error(`${ROOM_MAP}: no room sits under "The training side" — the room map's shape changed`);
  }
  return rooms;
}

/* What a plate for a room off the training side is given from the lock's DNA.

   OD-2026-09-28-009 item 5 says only that the "ring and bags in every plate"
   DNA applies to training rooms and that other rooms follow docs/ROOM-MAP.md.
   The room map states what a room off the training floor keeps for ONE room,
   the Workshop (ROOM-MAP.md:134-140, owner 2026-09-26: "do what makes sense but
   doesn't clash"): it "keeps the building's materials and drops its subject.
   Same timber, same plank, same chalk, same practical fluorescent light ... No
   ring, no bags, no mats." Applying that to every non-training room is this
   script's generalisation (INFERRED), not something the map states; it is an
   open owner question in docs/current/ACTIVE_WORK.md. The map gives family and
   signed-out surfaces a different rule, T7 (see T7_ROOMS below).

   So a non-training prompt keeps the lock's materials, light and atmosphere
   rows and nothing else. The rows are named rather than matched on their
   words: Extras names no ring and no bag, yet it is the gym's subject (glove
   shelving, treadmills, lockers, fight posters, a banner, whiteboards), and its
   posters, banner and whiteboards contradict the zero-lettering line. A row the
   lock adds later stays out of a non-training prompt until it is named here,
   and --dry-run lists it as left out. */
const BUILDING_ROWS = Object.freeze(['Ceiling', 'Walls', 'Light', 'Atmosphere']);

/* The words that mark the training floor, in a kept row or a reference
   photograph's filename. */
const TRAINING_FLOOR_WORDS = /\b(ring|rings|bags?|mats?)\b/i;

/* T7 (apps/web/public/plates/README.md, enforced by
   apps/web/components/familyPlateGround.test.ts): a family or signed-out
   surface takes the warm ground (plate-07) or no plate. The room map puts the
   Family Room under it (ROOM-MAP.md:68-71); The Window's Public Page is /public
   (apps/web/components/buildingMap.ts:280), one of the route trees that test
   holds to T7. So a plate made for either room is not one those surfaces may
   show today. Printed, not refused: whether this script should refuse them is
   an open owner question. */
const T7_ROOMS = new Set(['family-room', 'window']);

/* Composition and lettering are Mode A rules. Lettering is stated three ways
   because one phrasing gets ignored, and text inside a plate competes with the
   UI text drawn over it. One exception, owner 2026-09-28 ("no i like that you
   can leave it", OD-2026-09-28-013, lock Mode A item 4): the IRON CITY
   lettering on the ring canvas stays when the ring is in frame. The real canvas
   reads IRON CITY BREWERY (lock section 1), so the prompt spells that out
   rather than invite the model to drop a word. Everything else stays forbidden.

   THIS GENERATOR IS DELIBERATELY STRICTER THAN THE PLATE RULE, and the gap is
   on purpose. Since 2026-10-02 (OD-2026-10-02-001) a plate MAY carry a real
   mark on real equipment -- a maker's name on a bag or a glove. This prompt
   still asks for none, because a generator cannot produce a REAL mark: asked
   for a brand it renders an approximation, and an approximation of a real
   brand is precisely the garbled lettering the owner's rule still forbids.
   Asking is what produced HAYABUS on a pad and 3EL IN?RY GIYSE on a banner.
   So the permission applies to marks genuinely present in the room; it is not a
   licence to request them here. Owner, 2026-10-02, asked exactly this:
   "No no made up text, if I give text thats different". The ONE exception is
   text HE supplies -- given exact words, they are not made up and may be asked
   for; nobody supplies them on his behalf. Widening these strings otherwise
   reintroduces the defect the rule was drawn around. */
const COMPOSITION = 'Composition: the centre of the frame is QUIET and uncluttered because interface text is laid over it, and all visual interest sits in the outer thirds. No people.';
const NO_TEXT = 'The only lettering allowed is the sponsor lettering printed on the boxing ring canvas itself, which reads IRON CITY BREWERY at the centre of the canvas and ALT NATION, and only when the ring canvas is in frame. ABSOLUTELY NO OTHER TEXT anywhere in the frame: no other writing, no other letters, no numbers, no words, no signage, no posters, no banners, no readable chalkboards or whiteboards, no labels, no other logos, no other brand marks.';

/* THE LOCK ASKS FOR WRITING AND THE LETTERING RULE FORBIDS IT. Both are
   right, and for a training room the prompt used to carry the two of them
   side by side and let the model choose. It chose the lock, every time.

   The Walls row asks for blackboard-paint walls "written on directly,
   including a black painted band at chest height carrying chalked combination
   numbers". Extras goes further and names lettered artefacts outright: a "3rd
   Infantry Division banner", "fight posters (De La Hoya vs Mayweather)",
   "framed coaching certificates", "whiteboards of handwritten sessions".
   Then NO_TEXT says no readable text. The first drill-cabinet portrait came
   back with chalk over every wall and an invented crest reading EIR D
   LIFANTEE; it passed the byte gate, which checks geometry, not whether the
   walls can be read.

   A COUNTER-INSTRUCTION IS NOT ENOUGH, and that was tried first: a sentence
   saying the surfaces appear blank. The next plate came back with a banner
   reading 33D INF/ANTRY DIVISION and DE LA HOY. Naming an artefact draws it;
   a later sentence saying it is blank loses to the earlier, more concrete
   instruction. So the clause has to leave the prompt rather than be argued
   with afterwards -- which is what the non-training path already does by
   dropping Extras wholesale (BUILDING_ROWS above).

   Dropping whole rows would cost a training room its subject, so this drops
   CLAUSES: each row is split on its own punctuation and any clause naming a
   lettered artefact is left out, with the lock's other words untouched. The
   list below is a rule, not a re-description of the gym -- a clause the lock
   adds later is caught by the same words, and --dry-run prints every clause
   dropped so the omission is visible rather than silent. */
const LETTERED = /\b(banner|poster|posters|certificate|certificates|whiteboard|whiteboards|chalked|written|writing|handwritten|label|labels|signage|logo|logos|lettering|numbers)\b/i;

function stripLettered(text) {
  const clauses = text.split(/\s*;\s*|\s*,\s+/);
  const kept = clauses.filter((c) => !LETTERED.test(c));
  const dropped = clauses.filter((c) => LETTERED.test(c));
  return { text: kept.join(', '), dropped };
}

const SURFACES_BLANK = 'Every surface in this gym that could carry writing is blank: the chalkboard walls are freshly wiped and completely bare, and nothing in the frame carries a readable mark.';

/* A non-training room has no ring in frame, so the IRON CITY exception cannot
   apply there and this prompt asks for zero lettering. Unchanged by
   OD-2026-10-02-001: see the note above on why the GENERATOR stays stricter
   than the plate rule it serves. The room sentence is the room map's own
   wording for the Workshop. */
const NOT_THE_FLOOR = 'This room is not the training floor: no boxing ring, no punching bags, no training mats.';
const NO_TEXT_AT_ALL = 'ABSOLUTELY NO TEXT anywhere in the frame: no writing, no letters, no numbers, no words, no signage, no posters, no banners, no readable chalkboards or whiteboards, no labels, no logos, no brand marks.';

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
const roomSlug = arg('room');
const orientation = flag('portrait') ? 'portrait' : 'landscape';

if (!out || refs.length === 0 || !subject) {
  console.error('need --out, --room, --ref (2-4 times) and --subject; see the header of this file');
  process.exit(2);
}

const ROOMS = readRooms();
const room = ROOMS.find((r) => r.slug === roomSlug);
if (!room) {
  const list = (training) => ROOMS.filter((r) => r.training === training).map((r) => r.slug).join(', ');
  console.error(
    `${roomSlug ? `unknown --room ${roomSlug}` : 'need --room'}; the rooms in docs/ROOM-MAP.md are:\n`
    + `  training rooms: ${list(true)}\n`
    + `  other rooms: ${list(false)}`,
  );
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

const gym = readGymDna();

/* The building rows must still be in the lock, and must still describe the
   building. Either failing means the lock changed under this list, and what a
   non-training plate is given is then a decision, not something to guess. */
for (const name of BUILDING_ROWS) {
  const row = gym.rows.find(([el]) => el === name);
  if (!row) {
    throw new Error(`${LOCK}: no "${name}" row in the DNA table — BUILDING_ROWS in this script needs a decision`);
  }
  if (TRAINING_FLOOR_WORDS.test(row[1])) {
    throw new Error(`${LOCK}: the "${name}" row now names the ring, a bag or a mat — decide whether a non-training plate keeps it`);
  }
}

const keptRows = room.training
  ? gym.rows
  : gym.rows.filter(([el]) => BUILDING_ROWS.includes(el));
const leftOut = gym.rows.filter((row) => !keptRows.includes(row)).map(([el]) => el);

/* Warnings, not refusals: the operator may want a ring photograph for its
   timber alone. They print on dry runs and real runs alike. */
const warnings = [];
if (!room.training) {
  for (const p of refPaths) {
    if (TRAINING_FLOOR_WORDS.test(path.basename(p, path.extname(p)))) {
      warnings.push(
        `WARNING: --ref ${path.basename(p)} is named for a ring, a bag or a mat, and ${room.slug} is not a training room. `
        + 'The image model copies what is in its references, whatever the prompt says.',
      );
    }
  }
}
if (T7_ROOMS.has(room.slug)) {
  warnings.push(
    `NOTE: ${room.slug} falls under T7 — family and signed-out surfaces take the warm ground (plate-07) or no plate `
    + '(apps/web/public/plates/README.md; apps/web/components/familyPlateGround.test.ts), so no surface may show this plate today.',
  );
}
for (const line of warnings) console.error(line);
const strippedRows = keptRows.map(([el, text]) => {
  const { text: clean, dropped } = stripLettered(text);
  return [el, clean, dropped];
});
const droppedClauses = strippedRows.flatMap(([el, , dropped]) => dropped.map((d) => `${el}: ${d}`));
const dna = strippedRows.map(([el, text]) => `${el}: ${text}.`).join(' ');
/* A training room's prompt is exactly what every plate got before --room
   existed. */
const PROMPT = room.training
  ? `${subject}. ${dna} ${gym.forbidden} ${NO_TEXT} ${SURFACES_BLANK} ${COMPOSITION}`
  : `${subject}. ${NOT_THE_FLOOR} ${dna} ${gym.forbidden} ${NO_TEXT_AT_ALL} ${SURFACES_BLANK} ${COMPOSITION}`;

if (flag('dry-run')) {
  console.log(`room: ${room.slug} (${room.name}), ${room.training ? 'a training room' : 'not a training room'} in docs/ROOM-MAP.md`);
  console.log(`DNA rows read from the lock: ${gym.rows.length}`);
  console.log(
    `DNA rows in this prompt: ${keptRows.length}`
    + (leftOut.length ? ` (left out, not a training room: ${leftOut.join(', ')})` : '')
    + `; lettered clauses dropped: ${droppedClauses.length}`
    + (droppedClauses.length ? `\n  - ${droppedClauses.join('\n  - ')}` : ''),
  );
  console.log(`references (${refPaths.length}):\n  ${refPaths.join('\n  ')}`);
  if (warnings.length) console.log(`warnings: ${warnings.length} (printed above, on stderr)`);
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
  console.log(`room: ${room.slug}${room.training ? '' : ` (not a training room: only the building rows, ${keptRows.map(([el]) => el).join(', ')})`}`);

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
