// HF9-1 (lane HF8-9): what the two consent screens say about where photos and
// video go. The words are the owner's (Q3 = A, "A: full wording", on #2083);
// they are written out here a second time, by hand, so a change of one word in
// mediaConsentWords.ts fails until someone decides it on purpose.
//
// The last test is a tripwire, not a proof. It counts, file by file, where the
// shipped code under apps/web names analyzeFramesWithVision, the one function
// that sends still frames to the Azure AI service, and expects exactly the
// three callers the words describe, each with one call. A new caller, or a new
// call in an old one, fails here with a message that points at the words. It
// reads the TypeScript syntax tree, so comments do not count. It does NOT
// catch a new direct fetch that sends images some other way, nor the name
// built from pieces at run time.

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  ADULT_MEDIA_FRAMES_WORDS,
  GUARDIAN_MEDIA_WORDS,
  GUARDIAN_PAGE_INTRO_WORDS,
  guardianMediaWords,
} from './mediaConsentWords';

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

// Overwatch on #2083 (comment 7085637440), the owner's "go with your
// recomendation": on a card whose own consent on file allows public use, only
// the sentence "Nothing is posted publicly on this consent." is left out.
const GUARDIAN_WORDS_WITH_PUBLIC_USE_ON_FILE =
  'Photos and video are used inside the gym: coaches review them, and a clip the gym publishes goes in its clip '
  + 'library, which coaches and athletes signed in at this gym can browse. '
  + "Still frames from videos are also sent to Microsoft's Azure AI service, which the gym's app uses to check new "
  + 'videos for safety and, when a coach or the gym administrator asks, to describe the technique in one athlete\'s '
  + 'video. Your choice here covers videos your child is filed under or tagged in: with photos only, or no consent, '
  + 'frames from those are not sent. A video your child is in but not tagged in, such as a team video with no one '
  + "tagged, a teaching video, or another athlete's video, can be sent whatever you choose here.";

// The same answer, header = A: the page header no longer says the choice
// "controls one thing", and says it also decides playback and the frames,
// in the ruled passages' own words where they have them.
const GUARDIAN_PAGE_INTRO_AS_ANSWERED =
  'Nothing here blocks your child from training. It decides whether photos or videos of your child may be used in '
  + 'gym publications. For videos your child is filed under or tagged in, it also decides whether they can be played '
  + "back in the gym's app and whether still frames from them are sent to Microsoft's Azure AI service. You can grant "
  + 'or withdraw consent at any time. If your child has more than one guardian, every guardian must consent before '
  + 'anything is published.';

test('a card with no public use on file gets the whole guardian passage', () => {
  expect(guardianMediaWords(false)).toBe(GUARDIAN_WORDS_AS_RULED);
});

test('a card whose own consent on file allows public use gets the passage less that one sentence, and only that', () => {
  expect(guardianMediaWords(true)).toBe(GUARDIAN_WORDS_WITH_PUBLIC_USE_ON_FILE);
  expect(guardianMediaWords(true)).not.toContain('Nothing is posted publicly');
  expect(GUARDIAN_WORDS_AS_RULED.replace('Nothing is posted publicly on this consent. ', '')).toBe(
    GUARDIAN_WORDS_WITH_PUBLIC_USE_ON_FILE,
  );
});

test('the page header says what the choice decides, as answered, and no longer "controls one thing"', () => {
  expect(GUARDIAN_PAGE_INTRO_WORDS).toBe(GUARDIAN_PAGE_INTRO_AS_ANSWERED);
  expect(GUARDIAN_PAGE_INTRO_WORDS).not.toMatch(/one thing/i);
});

const WEB_DIR = path.resolve(__dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'public', 'e2e', 'seed-data']);
const SENDER_NAME = 'analyzeFramesWithVision';

function shippedSourceUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...shippedSourceUnder(full));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name)) found.push(full);
  }
  return found;
}

const relative = (file: string) => path.relative(WEB_DIR, file).split(path.sep).join('/');

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * How many times a file's code names the sender: as an identifier (an import,
 * a call, `module.analyzeFramesWithVision`, a declaration) or as a string
 * (`module['analyzeFramesWithVision']`). Read from the TypeScript syntax tree,
 * so a comment that names it (mediaConsentWords.ts does) is not counted, and a
 * `//` or `/*` inside a string cannot hide a real use.
 */
function namesOfSender(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(SENDER_NAME)) return 0;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  let count = 0;
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === SENDER_NAME) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

test('frames go to the AI service from exactly the callers these words describe', () => {
  const uses = Object.fromEntries(
    shippedSourceUnder(WEB_DIR)
      .map((file) => [relative(file), namesOfSender(file)] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  const reason = 'A new use of analyzeFramesWithVision sends still frames to the Azure AI service. Check that '
    + 'GUARDIAN_MEDIA_WORDS and ADULT_MEDIA_FRAMES_WORDS in components/mediaConsentWords.ts still tell families '
    + 'the truth, and ask the owner before changing them (HF9-1, Q3 on #2083). Then update this list.';
  expect({ reason, uses }).toEqual({
    reason,
    uses: {
      // Admin diagnostic, a clip it makes itself, no member footage: the import and one call.
      'app/api/pilot/shadow/film-study/diagnostic/route.ts': 2,
      // Film Study, when a coach or the gym administrator asks: the import and one call. A second call
      // here (a new job type, say) is a new way out for frames, and fails.
      'src/server/pilot/shadowJobProcessor.ts': 2,
      // The sender itself: its declaration only.
      'src/server/pilot/shadowFilmStudy.ts': 1,
      // The upload safety scan: the import and one call.
      'src/server/pilot/videoScan.ts': 2,
    },
  });
});
