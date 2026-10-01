// DIFFERENTIAL SENSITIVITY GUARD for the SHADOW safety classifier.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT MORE EXAMPLES.
//
// The curly-apostrophe hotfix went through three rounds of the same defect,
// each one found by someone thinking of a phrase nobody had thought of before:
//
//   round 1  no word boundary      -> "significant", "vacant" fired the emergency path
//   round 2  leading boundary only -> "cantilever", "cantina" still fired
//   round 3  boundaries both sides -> "signifi-cant", soft-hyphenated and accented forms STILL fired
//
// and separately, the worst one, in the other direction:
//
//   stripping U+FEFF as "zero-width" ALLOWED THROUGH a message main withheld.
//   U+FEFF is whitespace to the ECMAScript engine, so main's
//   `can(?:not|'t)\s+breathe` already matched "I can't<FEFF>breathe after that
//   hit". Deleting it joined the words, matched nothing, and sent the message
//   to the model with nobody told -- reintroducing the exact production defect
//   the branch existed to close, through a different character.
//
// That last one was found by sweeping every code point against main, not by
// anyone being clever. Three rounds of example-chasing is the evidence that
// examples are the wrong instrument, so the sweep is committed here as a
// permanent guard rather than left as a one-off that found something once.
//
// THE PROPERTY, and it is a one-way one:
//
//   ANYTHING MAIN FLAGGED AS URGENT, THE CURRENT CODE MUST STILL FLAG.
//
// Not "behaves identically". The whole point of the change is to flag MORE --
// phone apostrophes, omitted apostrophes, exotic separators. Becoming more
// sensitive is the feature. Becoming LESS sensitive, anywhere, for any
// character, is the regression, and it is invisible to a test written from
// phrases somebody imagined.
//
// The reference below is main's urgent-path predicates at b4f58159, frozen
// verbatim. It is deliberately a COPY and must not be refactored to import
// anything: its job is to keep saying what main said even after the real
// implementation has moved on. If it ever needs to change, that is a decision
// about dropping coverage and belongs in front of an owner.

import { normaliseForMatching, validateShadowRequest } from './shadowChat';

// ---------------------------------------------------------------------------
// FROZEN REFERENCE -- main @ b4f58159, apps/web/src/server/pilot/shadowChat.ts
// lines 280-283. Copied character for character. Do not "tidy" these.
// ---------------------------------------------------------------------------
function mainFlaggedUrgent(message: string): boolean {
  const hasPersonalContext = /\b(i|me|my|mine|we|our)\b/i.test(message)
    || /\b(now|currently|today|just happened|during training|after sparring|after (?:a|that|the) hit)\b/i.test(message);
  const hasUrgentSymptom = /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i.test(message);
  const hasAcuteImpactConcern = /(?:after|from).{0,30}(?:hit|blow|punch|fall).{0,60}(?:pain|numb|weak|tingl|blur|bleed|dizz|confus|vomit|can(?:not|'t))/i.test(message);
  return hasPersonalContext && (hasUrgentSymptom || hasAcuteImpactConcern);
}

/** The current implementation's answer to the same question. */
function nowWithholds(message: string): boolean {
  return validateShadowRequest(message, 'athlete', 'org-123').valid === false;
}

// ---------------------------------------------------------------------------
// THE SWEEP SET, stated explicitly because a cap nobody can see is a lie.
//
// Not the whole BMP: that is ~65k code points x 6 phrases x every gap, which
// would dominate the suite's runtime for coverage that is almost entirely
// ordinary letters. What is swept is every range that can plausibly behave as
// a separator or vanish:
//
//   U+0000-U+00FF   Latin-1. Carries U+00A0 NBSP, U+00AD SOFT HYPHEN,
//                   U+00B4 ACUTE, U+0085 NEL, and every ASCII control.
//   U+2000-U+206F   General Punctuation. Every exotic space, every dash and
//                   quote the fold table touches, U+200B-U+200D, U+2028,
//                   U+2029, and the invisible format characters.
//   U+FEFF          The one that actually bit.
//   U+1680 U+180E U+3000 U+FFF9-U+FFFB   stragglers outside those ranges.
//
// SKIPPED, SAID OUT LOUD: U+0100-U+167F, U+1681-U+1FFF, U+2070-U+2FFF,
// U+3001-U+FEFE and U+FF00-U+FFFF, except where named above. Those are
// overwhelmingly letters and symbols; a letter inserted mid-word does not
// create a separator, it creates a different word. If a regression is ever
// found in one of those ranges, widen this list rather than adding the one
// character.
// ---------------------------------------------------------------------------
const SWEPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x00ff],
  [0x2000, 0x206f],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];

function sweptCodePoints(): number[] {
  const out: number[] = [];
  for (const [lo, hi] of SWEPT_RANGES) {
    for (let cp = lo; cp <= hi; cp += 1) out.push(cp);
  }
  return out;
}

// Phrases main's patterns DO flag, each with the positions where a separator
// character can be inserted. `|` marks an insertion point.
//
// THE POSITION BEFORE THE MATCH WAS MISSING, AND IT WAS THE ONE THAT MATTERED.
//
// The first version of this file carried six carriers and every one of them
// inserted AT or AFTER the contraction. None inserted immediately BEFORE it.
// A reviewer added one -- "I got hit|can't breathe" -- and it found 328
// regressions on code this sweep had just passed 19/19.
//
// That is the same mistake this file exists to prevent, made inside the file
// that prevents it: six positions were enumerated and the class ("every
// position a separator can occupy relative to the match") was not. A guard
// written by enumeration inherits the blind spot of whoever enumerated.
//
// So the carriers below now cover, for each phrase: before the match, inside
// it, and after it. If a future reader adds a pattern with a new shape, the
// question to ask is not "which characters" but "which positions".
const CARRIERS: ReadonlyArray<readonly [string, string]> = [
  // NEXT TO A BOUNDED WINDOW -- the position class the sweep missed SECOND.
  //
  // Several patterns count characters: `vision.{0,12}blurr`,
  // `bleeding.{0,20}`, `after.{0,30}hit.{0,60}`. A fold that turns one
  // character into several pushes a real report out of its window. Every
  // earlier carrier sat on an unbounded gap or well inside a roomy window,
  // so a sweep of 2,500 code points passed 19/19 while `.normalize('NFKC')`
  // was silently expanding an ellipsis into three periods and losing
  // "my vision is<U+2026> really blurry" -- a message main withheld.
  //
  // These two sit one character inside their limits, so anything that grows
  // shows up immediately.
  ['bounded window, vision', 'my vision is|really blurry'],
  ['bounded window, bleeding', 'my lip is bleeding pretty badly|and will not stop'],
  // BEFORE the match -- the position class the sweep missed FIRST.
  ['before contraction', "I got hit|can't breathe"],
  ['before cannot', 'I got hit|cannot breathe'],
  ['before symptom phrase', 'After that punch I had a|headache'],
  ['contraction gap', "I can't|breathe after that hit"],
  // SUBSTITUTED, not inserted. The first version of this carrier inserted a
  // code point BETWEEN "can" and "'t", which main's `can(?:not|'t)` can never
  // match for any character -- so it contributed nothing and swept nothing.
  // Caught by the per-carrier floor below, which is the whole reason that
  // floor exists. Replacing the apostrophe itself is the real question: main
  // matched only the ASCII one, and whatever the new code does, it must still
  // withhold that.
  ['apostrophe substituted', 'I can|t breathe after that hit'],
  ['cannot gap', 'I cannot|breathe after that hit'],
  ['two-word symptom', 'I have seeing|stars after sparring'],
  ['impact gap', 'My neck is numb after that|hit'],
  ['leading word gap', 'I|have a headache after sparring'],
];

describe('the classifier is never LESS sensitive than main was', () => {
  // One assertion over the whole sweep rather than one per code point: 2,500
  // jest cases would bury the signal, and the failure message below names
  // every offender with its code point, which is what a reader needs.
  test('no swept code point makes an urgent message slip through', () => {
    const codePoints = sweptCodePoints();
    const regressions: string[] = [];
    let compared = 0;

    for (const [label, carrier] of CARRIERS) {
      const [head, tail] = carrier.split('|');
      for (const cp of codePoints) {
        const message = head + String.fromCodePoint(cp) + tail;
        if (!mainFlaggedUrgent(message)) continue;
        compared += 1;
        if (!nowWithholds(message)) {
          regressions.push(
            `${label}: U+${cp.toString(16).toUpperCase().padStart(4, '0')} `
            + `-- main withheld this, the current code does not`,
          );
        }
      }
    }

    // A floor, so the sweep cannot pass by comparing nothing. If the carriers
    // or main's reference ever stop matching, this fails loudly instead of
    // reporting a vacuous success.
    expect(compared).toBeGreaterThan(200);
    expect(regressions).toEqual([]);
  });

  // The one that bit, called out by name so it can never be quietly dropped
  // from the sweep set without a test going red.
  test('U+FEFF specifically, which main treated as whitespace', () => {
    const message = "I can't﻿breathe after that hit";
    expect(mainFlaggedUrgent(message)).toBe(true);
    expect(nowWithholds(message)).toBe(true);
  });

  // THE PER-CARRIER FLOOR. The sweep's single total is not enough on its own:
  // one carrier could stop contributing entirely -- a typo in it, or main's
  // reference drifting -- and the total would still clear 200 on the strength
  // of the others, so a whole insertion position would go unswept in silence.
  //
  // My first version of this check substituted a space into each carrier and
  // asserted main matched the result. That was wrong, and usefully so: it is
  // not true for the apostrophe-slot carrier, where a space gives "I can 't
  // breathe" and main correctly does NOT match. Counting what each carrier
  // actually contributes to the sweep tests the thing that matters instead of
  // a proxy for it.
  test('every carrier contributes to the sweep', () => {
    const codePoints = sweptCodePoints();
    const perCarrier = CARRIERS.map(([label, carrier]) => {
      const [head, tail] = carrier.split('|');
      const flagged = codePoints.filter(
        (cp) => mainFlaggedUrgent(head + String.fromCodePoint(cp) + tail),
      ).length;
      return [label, flagged > 0] as const;
    });

    expect(perCarrier.filter(([, contributed]) => !contributed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE TWO PROPERTIES OF THE FOLD
//
// Carriers and code points are still enumeration: they test the positions and
// characters somebody thought of. These two tests are the class itself, over
// the whole BMP, and between them they make the entire family of fold defects
// unrepresentable rather than merely unobserved.
//
// Both were violated by `.normalize('NFKC')`, which is why it is no longer in
// the fold. Each had already shipped a regression before anyone noticed the
// shared cause.
// ---------------------------------------------------------------------------
describe('the fold preserves what the patterns depend on', () => {
  const BMP = 0x10000;

  // PROPERTY 1 -- IT NEVER LENGTHENS.
  //
  // The patterns count characters. `vision.{0,12}blurr` allows twelve. NFKC
  // turned U+2026 into three periods, so a message main withheld grew past
  // the limit and was allowed through to the model with nobody told. 476
  // code points did that on one carrier alone.
  test('no code point makes the folded text longer', () => {
    const offenders: string[] = [];
    for (let cp = 0; cp < BMP; cp += 1) {
      // Lone surrogates are not characters anyone can type; skip them rather
      // than assert on malformed input.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const folded = normaliseForMatching('a' + ch + 'b');
      if (folded.length > 3) {
        offenders.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} -> ${JSON.stringify(folded)}`);
      }
    }
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // PROPERTY 2 -- IT NEVER CREATES A WORD CHARACTER.
  //
  // The patterns assert boundaries. `\b(i|me|my|mine|we|our)\b` is what every
  // urgent branch hangs off. NFKC turned U+2122 into "TM", so "<U+2122>my
  // shoulder hurts" became "TMmy shoulder hurts", "my" stopped being a whole
  // word, and the request was allowed. 1,168 code points do something of
  // this kind.
  //
  // A fold may DELETE a non-word character (U+200B) or turn it into a space.
  // It may not turn one into [A-Za-z0-9_].
  test('no non-word code point folds into a word character', () => {
    const WORD = /[A-Za-z0-9_]/;
    const offenders: string[] = [];
    for (let cp = 0; cp < BMP; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (WORD.test(ch)) continue;
      const folded = normaliseForMatching('a' + ch + 'b');
      const middle = folded.slice(1, folded.length - 1);
      if (middle && WORD.test(middle)) {
        offenders.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} -> ${JSON.stringify(middle)}`);
      }
    }
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // The floor: if normaliseForMatching ever became the identity function,
  // both properties above would pass trivially and the fold would be gone.
  test('the fold still folds', () => {
    expect(normaliseForMatching('can\u2019t')).toBe("can't");
    expect(normaliseForMatching('a\uFEFFb')).toBe('a b');
    expect(normaliseForMatching('a\u200Bb')).toBe('ab');
  });
});

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION. More sensitive is the feature; indiscriminate is not.
// Every entry here is a benign training sentence that an earlier round of this
// fix answered with "stop participation and contact local emergency services"
// and a critical human-review row.
// ---------------------------------------------------------------------------
const BENIGN_CANT_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['significant', 'I felt great after the punch drill and my footwork showed significant improvement'],
  ['vacant', 'I moved from the fall bag over to the vacant station after that punch drill'],
  ['scant', 'After that punch combo my notes were scant'],
  ['cantilever', 'I moved from the fall bag over to the cantilever station after that punch drill'],
  ['cantina', 'After that punch we all went to the cantina down the road'],
  ['canto', 'After that punch I heard my coach canto along with the radio'],
  ['canto accented', 'After that punch I heard my coach cantó along with the radio'],
  ['recant', 'After that punch I had to recant what I said about the referee'],
  ['decant', 'After that punch I watched him decant the water bottle'],
  ['incantation', 'After that punch the corner was muttering like an incantation'],
  ['scanty', 'After that punch the lighting in the gym was scanty'],
  ['hyphenated', 'After that punch my footwork showed signifi-cant improvement'],
  ['soft hyphen', 'After that punch my footwork showed signifi­cant improvement'],
  ['en dash', 'After that punch my footwork showed signifi–cant improvement'],
  ['applicant', 'After that punch I added the new applicant to the intake list'],
];

describe('a word merely containing "cant" is not an emergency', () => {
  test.each(BENIGN_CANT_CORPUS)('%s', (_label, message) => {
    expect(nowWithholds(message)).toBe(false);
  });

  // NO EXCEPTION ANY MORE, because the thing that needed one is gone.
  //
  // While this PR widened the contraction, a quoted mention of the word
  // "cant" matched, and that had to be accepted as a trade: narrowing it
  // would also have stopped "'I can't breathe'" matching when an athlete
  // quotes themselves. The widening has been removed, so neither problem
  // exists here -- "cant" is not a pattern at all now.
  //
  // Both rows stay, because #1036 inherits this corpus and will reintroduce
  // the contraction family. Whoever does that makes the quoted mention match
  // again and has to decide the same trade deliberately. These two lines are
  // where they will notice.
  test('a quoted mention is not matched, now that "cant" is not a pattern', () => {
    expect(nowWithholds("After that punch the coach used the word 'cant' about my stance")).toBe(false);
    // The quoted REAL report, which must keep matching whatever happens to
    // the contraction family. It does, on main's own pattern, with no
    // boundary of any kind involved.
    expect(nowWithholds("I told him 'I can't breathe' right after that hit")).toBe(true);
  });
});
