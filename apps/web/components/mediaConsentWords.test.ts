// HF9-1 (lane HF8-9): what the two consent screens say about where photos and
// video go. The words are the owner's (Q3 = A, "A: full wording", on #2083);
// they are written out here a second time, by hand, so a change of one word in
// mediaConsentWords.ts fails until someone decides it on purpose.
//
// The last test is a tripwire, not a proof. It lists the shipped files under
// apps/web that call analyzeFramesWithVision, the one function that sends still
// frames to the Azure AI service, and expects exactly the three callers the
// words describe. A new caller fails here with a message that points at the
// words. It reads code, not comments. It does NOT catch a new direct fetch that
// sends images some other way.

import fs from 'node:fs';
import path from 'node:path';

import { ADULT_MEDIA_FRAMES_WORDS, GUARDIAN_MEDIA_WORDS } from './mediaConsentWords';

const GUARDIAN_WORDS_AS_RULED =
  'Photos and video are used inside the gym: coaches review them, and a clip the gym publishes goes in its clip '
  + 'library, which coaches and athletes signed in at this gym can browse. Nothing is posted publicly on this consent. '
  + "Still frames from videos are also sent to Microsoft's Azure AI service, which the gym's app uses to check new "
  + 'videos for safety and, when a coach or the gym administrator asks, to describe the technique in one athlete\'s '
  + 'video. Your choice here covers videos your child is filed under or tagged in: with photos only, or no consent, '
  + 'frames from those are not sent. A video your child is in but not tagged in, such as a team video with no one '
  + "tagged, a teaching video, or another athlete's video, can be sent whatever you choose here.";

const ADULT_WORDS_AS_RULED =
  "Still frames from videos are also sent to Microsoft's Azure AI service, which the gym's app uses to check new "
  + 'videos for safety and, when a coach or the gym administrator asks, to describe the technique in one athlete\'s '
  + 'video. Your choice here covers videos you are filed under or tagged in. A video you are in but not tagged in, '
  + "such as a team video with no one tagged, a teaching video, or another athlete's video, can be sent whatever you "
  + 'choose here.';

test('the guardian consent page says, word for word, what the owner chose (Q3 = A)', () => {
  expect(GUARDIAN_MEDIA_WORDS).toBe(GUARDIAN_WORDS_AS_RULED);
});

test('the adult athlete panel says, word for word, what the owner chose (Q3 = A)', () => {
  expect(ADULT_MEDIA_FRAMES_WORDS).toBe(ADULT_WORDS_AS_RULED);
});

test('the guardian words no longer say photos and video stay inside the gym', () => {
  expect(GUARDIAN_MEDIA_WORDS).not.toMatch(/stays? inside the gym/i);
});

const WEB_DIR = path.resolve(__dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'public', 'e2e', 'seed-data']);
const SENDER_MODULE = 'src/server/pilot/shadowFilmStudy.ts';
const SENDER = /\banalyzeFramesWithVision\b/g;

function shippedSourceUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...shippedSourceUnder(full));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name)) found.push(full);
  }
  return found;
}

const relative = (file: string) => path.relative(WEB_DIR, file).split(path.sep).join('/');

// Code only: a comment that names the function (as mediaConsentWords.ts does)
// is not a caller. Block comments go first, then line comments that do not
// follow a colon or a quote, so a URL in a string keeps the rest of its line.
const codeOf = (file: string) => fs.readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('frames go to the AI service from exactly the callers these words describe', () => {
  const callers = shippedSourceUnder(WEB_DIR)
    .filter((file) => relative(file) !== SENDER_MODULE)
    .filter((file) => (codeOf(file).match(SENDER) ?? []).length > 0)
    .map(relative)
    .sort();

  const reason = 'A new caller of analyzeFramesWithVision sends still frames to the Azure AI service. Check that '
    + 'GUARDIAN_MEDIA_WORDS and ADULT_MEDIA_FRAMES_WORDS in components/mediaConsentWords.ts still tell families '
    + 'the truth, and ask the owner before changing them (HF9-1, Q3 on #2083). Then update this list.';
  expect({ reason, callers }).toEqual({
    reason,
    callers: [
      // Admin diagnostic: a clip it makes itself, no member footage.
      'app/api/pilot/shadow/film-study/diagnostic/route.ts',
      // Film Study, when a coach or the gym administrator asks.
      'src/server/pilot/shadowJobProcessor.ts',
      // The upload safety scan.
      'src/server/pilot/videoScan.ts',
    ],
  });

  // The module that sends names the function once, where it is declared, so a
  // second call added inside it trips here too.
  const inSender = codeOf(path.join(WEB_DIR, SENDER_MODULE)).match(SENDER) ?? [];
  expect({ reason, namesInSender: inSender.length }).toEqual({ reason, namesInSender: 1 });
});
