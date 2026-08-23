import path from 'node:path';
import { readDesignSystemCss } from '../../src/design/readDesignSystemCss';

/**
 * LAW 6 GIVES THE APP TWO GROUNDS. A VOICE THAT ANSWERS ONLY ONE IS A BUG.
 *
 * Every type voice in ppbf.css pins an ink tuned for dark leather -- bone and
 * brass rungs that sit at 1.05:1 to 2.01:1 on a light ground. The sheet answers
 * that for `.on-canvas`, the warm family ground, one voice at a time.
 *
 * `.mat-paper` is a light ground too -- paper on hide rather than canvas -- and
 * its restatement was built incrementally, four voices at a time, as somebody
 * happened to put a voice on paper and notice. That is not a rule, it is a
 * backlog: the voices nobody had put on paper yet were broken and silent.
 *
 * #514 made the office a paper room -- .mat-paper on eight /admin/* routes --
 * which turned that backlog into live surfaces. `.alert--*` was the one that
 * mattered: its four rules pin --bone-100 and `.on-canvas` was their only
 * restatement, so a warning inside a paper panel printed near-white on cream.
 *
 * This test is the rule the incremental fixes never had. It does not pin a list
 * of voices -- a pinned list is a second backlog. It reads which voices the
 * sheet restates for `.on-canvas` and requires `.mat-paper` to answer the same
 * question, so the next light-ground override added for canvas cannot forget
 * paper.
 *
 * Scoped to the simple `.on-canvas .x` form deliberately. The compound
 * selectors -- `.on-canvas :is(.mat-leather, ...) .t-body`, `.on-canvas.corner-
 * scope[data-corner]` -- are answering a different question (a dark panel
 * standing ON canvas, a corner tint), and they do not describe a voice that
 * needs a paper reading.
 */

const CSS = path.join(__dirname, '../../../../design-system/ppbf.css');
const sheet = readDesignSystemCss(CSS).replace(/\/\*[\s\S]*?\*\//g, '');

/** Selectors of the form `.ground .voice`, one entry per voice named. */
function voicesRestatedFor(ground: string): Set<string> {
  const found = new Set<string>();
  const escaped = ground.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* A rule's selector list is everything between the previous `}` and the `{`,
     which `[^{}]*` already expresses -- anchoring it on a literal `}` is wrong
     under /g, because the previous match consumes that `}` and every second
     rule is then skipped. This file shipped that bug for exactly one commit and
     it silently halved the set being compared. */
  for (const rule of sheet.matchAll(/([^{}]*)\{/g)) {
    for (const selector of rule[1].split(',')) {
      const match = selector.trim().match(new RegExp(`^${escaped}\\s+\\.([a-z][a-z0-9-]*)$`));
      if (match) found.add(match[1]);
    }
  }
  return found;
}

/**
 * Not every canvas restatement is owed by paper, and the difference is not
 * contrast -- it is which room the thing belongs to. A value here is the reason
 * a voice is exempt, in the same shape as UNPAINTED in buildingMapRooms.test.ts:
 * the list records decisions, and anything not on it is owed an answer.
 *
 * OPEN, deliberately not resolved here: the five controls below are a design
 * question, not a contrast bug, and this file's author is not the one to settle
 * it. `.input`/`.select`/`.textarea` pin --bone-100 on #17110D -- a dark inset
 * field, perfectly legible in itself, which on a paper panel reads as a hole
 * punched through the form. `.on-canvas` restates all three, so the sheet's own
 * judgement is that a light ground wants a light field; whether the office's
 * paper forms want the same is for the design system to say. Recorded rather
 * than silently fixed or silently skipped.
 */
const NOT_OWED_BY_PAPER: Record<string, string> = {
  wallwords: 'GYM FLOOR -- WordsOnTheWall is brick-wall chrome; the floor room forbids paper',
  'wallwords-line': 'GYM FLOOR -- part of WordsOnTheWall',
  'wallwords-by': 'GYM FLOOR -- part of WordsOnTheWall',
  'wallwords-aside': 'GYM FLOOR -- part of WordsOnTheWall',
  fightcard: 'PROGRAMME -- the fight card is its own printed object with its own ground',
  'fightcard-name': 'PROGRAMME -- part of the fight card',
  'fightcard-ring': 'PROGRAMME -- part of the fight card',
  'fightcard-corner': 'PROGRAMME -- part of the fight card',
  'fightcard-programme': 'PROGRAMME -- part of the fight card',
  input: 'OPEN DESIGN QUESTION -- see the note above; dark inset field on a paper form',
  select: 'OPEN DESIGN QUESTION -- see the note above',
  textarea: 'OPEN DESIGN QUESTION -- see the note above',
  badge: 'OPEN DESIGN QUESTION -- chips carry safety colour (Law 2); a paper reading is not a recolour',
  'btn--ghost': 'OPEN DESIGN QUESTION -- ppbf.css documents ghost-on-light as grey-on-grey, and #514 '
    + 'answered it at the call sites by using .btn--lever on paper instead. Whether the sheet should '
    + 'answer it centrally is a decision, not a fix',
};

/* The two grounds are not required to use the same INK -- paper is a different
   colour from canvas and .t-command carries a different text-shadow on each.
   What is required is that both have an answer, or a recorded reason not to. */
describe('the light grounds answer the same voices', () => {
  const canvas = voicesRestatedFor('.on-canvas');
  const paper = voicesRestatedFor('.mat-paper');
  const owed = [...canvas].filter((voice) => !(voice in NOT_OWED_BY_PAPER)).sort();

  it('reads a non-trivial set of voices off the sheet, or it is proving nothing', () => {
    expect(canvas.size).toBeGreaterThan(8);
    expect(paper.size).toBeGreaterThan(8);
    expect(owed.length).toBeGreaterThan(4);
  });

  it.each(owed)('.mat-paper restates .%s, which .on-canvas restates', (voice) => {
    expect(paper.has(voice)).toBe(true);
  });

  /* An exemption for a voice canvas no longer restates is a stale decision, and
     a stale decision reads as a considered one. */
  it('carries no exemption for a voice that is not in the canvas set', () => {
    expect(Object.keys(NOT_OWED_BY_PAPER).filter((voice) => !canvas.has(voice))).toEqual([]);
  });

  /* The alert panels are the reason this file exists, and they are four
     separate rules -- a partial restatement would leave one severity unreadable
     while the other three looked fine. */
  it.each(['alert--info', 'alert--warning', 'alert--critical', 'alert--success'])(
    'restates .%s for paper, not just for canvas',
    (severity) => {
      expect(paper.has(severity)).toBe(true);
      expect(canvas.has(severity)).toBe(true);
    },
  );

  /* Not a colour test -- cornerColor.test.ts owns contrast maths. This is the
     narrower claim that no paper restatement silently reintroduces a bone or
     brass rung tuned for leather, which is the exact mistake being fixed.

     The first version of this test scoped itself with a comment delimiter
     (/* ===== ) against a sheet it had already stripped comments from, so it
     matched nothing, read an empty string, and passed on every mutation put to
     it. It is written against the parsed rules now. A vacuous guard is worse
     than no guard: it reports the property is held. */
  const INK_RUNG = /var\(--(bone-[1-4]00|brass-[234]00)\)/;

  /** Every `.mat-paper …` rule as [selectorList, body]. */
  function paperRules(): Array<[string, string]> {
    const rules: Array<[string, string]> = [];
    for (const rule of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = rule[1].trim();
      if (/(^|,|\s)\.mat-paper\b/.test(selectors)) rules.push([selectors, rule[2]]);
    }
    return rules;
  }

  it('parses a real set of paper rules, so the checks below are not vacuous', () => {
    expect(paperRules().length).toBeGreaterThan(5);
  });

  it('never answers a paper voice with an ink-ground rung', () => {
    const offenders = paperRules()
      .filter(([, body]) => INK_RUNG.test(body.match(/color:\s*([^;]*)/)?.[1] ?? ''))
      .map(([selectors]) => selectors);
    expect(offenders).toEqual([]);
  });
});
