#!/usr/bin/env node
/*
 * MAKE A BACKGROUND PLATE, FROM THIS GYM.
 * ---------------------------------------------------------------------------
 * Owner instruction 2026-09-26: "work with the connectors to make one", then
 * "let's shift to making and filling the plate library".
 *
 * WHY A SCRIPT AND NOT A CHAT TRANSCRIPT. A plate is a committed binary that
 * `src/design/plateBinaries.test.ts` gates on its bytes, and the library needs
 * roughly twenty of them. Generating each one by hand loses the part that
 * matters -- which reference went in, what was asked for, and what the byte gate
 * demands -- so the next person regenerates a plate and gets a different gym.
 * The method lives here instead.
 *
 * REFERENCE-GUIDED, NEVER INVENTED. docs/REAL-GYM-REFERENCE-LOCK.md, Mode A:
 * pass real reference frames in, name the DNA in the prompt, keep the centre
 * quiet, put the interest in the outer thirds, and no lettering at all. Every
 * call here sends an already-committed plate as the visual reference, so a new
 * plate is another corner of the SAME building rather than a stock gym
 * assembled from a sentence. Passing no reference is possible and is a mistake;
 * it is what produces the generic brick wall this library already has two of.
 *
 * WHAT IT WILL NOT DO. It will not overwrite an existing plate unless --force is
 * given: a plate that has shipped is evidence, and a silent regeneration means
 * the room changed and nothing recorded it.
 *
 * USAGE
 *   AZ_AI_KEY=$(az cognitiveservices account keys list -n shadow-ai \
 *     -g ppbf-shadow-rg --query key1 -o tsv) \
 *   node scripts/make-plate.mjs \
 *     --out plate-10-floor-landscape-01.jpg \
 *     --ref plate-02b-floor-portrait-ring-01.jpg \
 *     --subject "the ring and the bags, seen from the floor" \
 *     [--portrait] [--force] [--dry-run]
 *
 * The key is read from the environment and is never logged.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ENDPOINT = 'https://shadow-ai.cognitiveservices.azure.com/';
const DEPLOYMENT = 'flux-kontext-plates';
const PLATES = path.join(process.cwd(), 'apps', 'web', 'public', 'plates');

/* The byte gate, restated from src/design/plateBinaries.test.ts so a plate is
   rejected here rather than in CI. Landscape and portrait are the only two
   shapes the sheet asks for. */
const SHAPE = { landscape: [1280, 720], portrait: [810, 1440] };
const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 400 * 1024;

/* The DNA every plate carries, from the reference lock. Stated once, sent every
   time, because a plate that drops it is the drift the lock exists to stop. */
const DNA = [
  /* THESE ARE DIGITAL ROOMS, NOT PHOTOGRAPHS OF THE GYM. Owner, 2026-09-26:
     "you can clean them up and alter to something related, these should be new
     digital rooms". So a plate is DERIVED from the building -- its materials,
     colours, light and habits -- and then tidied: the clutter thinned, the
     surfaces sound, the composition built for interface to sit on. Chasing exact
     reproduction of a photograph is the wrong target and was costing generations.
     Recognisably this gym, not a survey of it.

     WRITTEN FROM THE OWNER'S OWN PHOTOGRAPHS, supplied 2026-09-26 in two
     batches. Everything before this was inferred from AI-rendered plates, and
     nearly all of it was wrong: the walls are honey-coloured wood plank, not
     dark block; the ceilings are low white-painted plank and coffered drop
     ceiling, not exposed timber trusses; the floors are PAINTED and change
     colour room to room; and the ring is teal with a brewery roundel on it,
     which docs/REAL-GYM-REFERENCE-LOCK.md said all along and I doubted. */
  'A real nonprofit boxing gym in a converted low-ceilinged building. Cluttered,',
  'homemade, cared for. Every surface has been painted or built by hand.',
  'CEILINGS are LOW and PALE: white-painted plank, or a white coffered drop ceiling',
  'with square recessed light panels, with bare fluorescent battens surface-mounted',
  'below. Rough sawn timber posts and beams show where the structure does.',
  'WALLS are mostly HONEY-COLOURED RECLAIMED WOOD PLANK, warm and knotty. Others',
  'are finished in BLACKBOARD PAINT -- matt near-black chalkboard surfaces that are',
  'the wall itself, not boards hung on it, so coaches write combinations and notes',
  'straight onto them. Red-painted trim posts and window surrounds; one area is pale',
  'grey painted block. Old shuttered windows.',
  'THE FLOORS ARE PAINTED AND ZONED, and this is the most distinctive thing about',
  'the place: a RED painted floor in the ring room, a BLUE painted floor marked out',
  'with pale tape grid lines in the mat room, a GREY painted floor with white',
  'markings in the cardio room, and green carpet in the locker area.',
  'THE RING: a pale TEAL / blue-green canvas with a large faded RED AND WHITE',
  'CIRCULAR BREWERY-STYLE ROUNDEL printed across it, a teal apron skirt, DARK ropes',
  'lashed to the posts with RED CORD, and CREAM CANVAS SANDBAG-STYLE corner pads',
  'hanging on dark steel corner posts. It sits low on the red floor.',
  'THE BAGS hang from things somebody built: a heavy pressure-treated timber',
  'post-and-beam frame standing on the floor, and black steel scaffold pipe rails',
  'braced to the wall with timber. The bags are a mixed set, not matching: black,',
  'one white canvas one, a navy blue one, black-and-red ones. Worn and taped.',
  'OTHER REAL FIXTURES: wire shelving racks crowded with mixed-colour gloves and',
  'headgear; wood-framed mirrors, some with small handwritten notes stuck to them;',
  'an American flag on the plank wall; a grey military unit banner; framed',
  'certificates; old fight posters; whiteboards and chalkboards; a water cooler with',
  'blue jugs; exercise balls and foam rollers stored on top of cabinets; treadmills',
  'and an elliptical; grey lockers with one bank of red ones; a big floor fan.',
  'THE LIGHT is flat and practical and slightly green: fluorescent doing all the',
  'work, a little daylight from the shuttered windows. Never cinematic, never the',
  'even flattering light of a commercial gym.',
].join(' ');

const COMPOSITION = [
  'Composition: the centre of the frame is QUIET and uncluttered -- plain wall, plain floor --',
  'because interface text is laid over it. All visual interest sits in the outer thirds.',
  'Natural available light. No people.',
].join(' ');

/* Stated three ways on purpose: one phrasing gets ignored, and lettering inside a
   plate competes with the UI text drawn on top of it. */
const NO_TEXT = [
  'ABSOLUTELY NO TEXT anywhere in the frame:',
  'no writing, no letters, no numbers, no words, no signage, no posters, no banners,',
  'no chalkboards, no whiteboards, no labels, no logos, no brand marks.',
].join(' ');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const out = arg('out');
const ref = arg('ref');
const subject = arg('subject');
const orientation = flag('portrait') ? 'portrait' : 'landscape';

if (!out || !ref || !subject) {
  console.error('need --out, --ref and --subject; see the header of this file');
  process.exit(2);
}
if (!/^plate-[0-9a-z-]+\.jpg$/.test(out)) {
  console.error(`--out must be a plate-*.jpg filename, got ${out}`);
  process.exit(2);
}
if (out.includes('portrait') !== (orientation === 'portrait')) {
  /* plateBinaries checks orientation against the filename, so a mismatch here is
     a red suite later. Catch it before the call is paid for. */
  console.error(`filename and orientation disagree: ${out} vs ${orientation}`);
  process.exit(2);
}

const outPath = path.join(PLATES, out);
if (existsSync(outPath) && !flag('force')) {
  console.error(`${out} already exists. A shipped plate is evidence; pass --force to replace it.`);
  process.exit(2);
}
/* A reference may be a plate already in the library OR an absolute path to one
   of the owner's own photographs. The second is better and should be preferred:
   on 2026-09-26 Jason supplied real photographs of the gym for the first time,
   and everything generated before that was a render of a render -- which is how
   a homemade timber bag frame became ceiling chains, and how pale painted block
   walls became dark ones. Chain off a real frame whenever one exists. */
const refPath = path.isAbsolute(ref) ? ref : path.join(PLATES, ref);
if (!existsSync(refPath)) {
  console.error(`reference not found: ${refPath}`);
  process.exit(2);
}

const PROMPT = `${subject}. ${DNA} ${NO_TEXT} ${COMPOSITION}`;

if (flag('dry-run')) {
  console.log('PROMPT:\n' + PROMPT);
  process.exit(0);
}

const KEY = process.env.AZ_AI_KEY;
if (!KEY) {
  console.error('AZ_AI_KEY is not set. See the usage note at the top of this file.');
  process.exit(2);
}

const [w, h] = SHAPE[orientation];
/* The model returns its own near-enough size; the exact shape is cut here, where
   the gate can be checked before anything lands in the repository. */
const askFor = orientation === 'portrait' ? '752x1392' : '1392x752';

const body = {
  prompt: PROMPT,
  n: 1,
  size: askFor,
  output_format: 'png',
  image: readFileSync(refPath).toString('base64'),
};

const res = await fetch(
  `${ENDPOINT}openai/deployments/${DEPLOYMENT}/images/generations?api-version=2025-04-01-preview`,
  { method: 'POST', headers: { 'api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
);
if (!res.ok) {
  console.error(`generation failed: ${res.status} ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const json = await res.json();
const b64 = json?.data?.[0]?.b64_json;
const url = json?.data?.[0]?.url;
const raw = b64
  ? Buffer.from(b64, 'base64')
  : Buffer.from(await (await fetch(url)).arrayBuffer());

await sharp(raw)
  .resize(w, h, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
  .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
  .toFile(outPath);

const bytes = statSync(outPath).size;
const buf = readFileSync(outPath);
const meta = await sharp(outPath).metadata();
const ok =
  meta.width === w && meta.height === h &&
  meta.chromaSubsampling === '4:4:4' &&
  bytes > MIN_BYTES && bytes <= MAX_BYTES &&
  buf[0] === 0xff && buf[1] === 0xd8 &&
  buf[bytes - 2] === 0xff && buf[bytes - 1] === 0xd9;

console.log(`${out}  ${meta.width}x${meta.height}  ${meta.chromaSubsampling}  ${bytes} bytes`);
console.log(`byte gate: ${ok ? 'PASS' : 'FAIL'}`);
console.log(`reference: ${ref}`);
console.log('LOOK AT IT before committing. The gate checks bytes, not whether the room is this gym.');
process.exit(ok ? 0 : 1);
