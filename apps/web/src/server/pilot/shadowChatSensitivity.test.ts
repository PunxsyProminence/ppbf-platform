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
//   ANYTHING MAIN WITHHELD, THE CURRENT CODE MUST STILL WITHHOLD.
//
// Not "behaves identically". The whole point of the change is to flag MORE:
// a report typed with a phone's apostrophe. Omitted apostrophes and exotic
// separators were in scope once and are not now; they behave as on main.
// Becoming more sensitive is the feature. Becoming LESS sensitive, anywhere,
// for any character, is the regression, and it is invisible to a test written
// from phrases somebody imagined.
//
// The reference below is main's WITHHOLDING code at b4f58159 -- all seven
// withholding returns of validateShadowRequest plus classifyHighRiskTopic --
// frozen verbatim. It is deliberately a COPY and must not be refactored to import
// anything: its job is to keep saying what main said even after the real
// implementation has moved on. If it ever needs to change, that is a decision
// about dropping coverage and belongs in front of an owner.

import { normaliseForMatching, validateShadowRequest } from './shadowChat';

// ---------------------------------------------------------------------------
// FROZEN REFERENCE -- main's classifier, copied verbatim.
//
// SOURCE: b4f58159, apps/web/src/server/pilot/shadowChat.ts. The same file is
// byte-identical at c2c4df672e55c543a46abff8472b1e3750aebc99 (verified: both
// sha256 7c66a36491ae5e66ca3784691a1663a3), so the copy is current as of that
// commit too.
//
// ALL SEVEN of main's withholding returns are here: prescription-or-weight-cut,
// urgent-symptom, personal-health, diagnosis, clearance, medication, and the
// isHighRisk fallback. An earlier version of this file froze TWO of the seven
// and still claimed "anything main withheld, we still withhold" -- a claim
// about a third of main's withholding code, stated as if it covered all of it.
// The architect review found a defect on one of the five unfrozen paths, which
// this harness could not have seen however many code points it swept.
//
// classifyHighRiskTopic is included because the isHighRisk fallback depends on
// it, and because the fold changes the text its topic patterns see -- so it is
// the return this PR can move most broadly. Its `examples` table is the one
// thing dropped: it is returned for presentation and no withholding decision
// reads it.
//
// IT IS A SNAPSHOT AND MUST NOT BE UPDATED TO FOLLOW MAIN. Its entire job is
// to keep saying what main said at that commit, so that "we are never less
// sensitive than main was" has a fixed referent. If main's classifier changes
// deliberately, that is a decision to re-baseline, and it belongs in front of
// an owner, not in a test edit. DELETE THIS BLOCK when the behaviour it
// guards has been re-established some better way; do not quietly re-sync it.
//
// EXTRACTED MECHANICALLY, not hand-copied: 220 lines of regex transcribed by
// hand is exactly where this would go wrong, and the value of the reference
// is that it is exact.
// ---------------------------------------------------------------------------
function mainClassify(userMessage: string): { topic: string; isHighRisk: boolean; educationalApproach: boolean } {
  const msg = userMessage.toLowerCase();

  const topics: Array<[string, RegExp]> = [
    ['concussion', /concuss/i],
    ['head_trauma', /(head|brain)\s+(trauma|injury)/i],
    ['loss_of_consciousness', /(loss|loss\s+of|lack)\s+of\s+consciousness|unconscious|passed\s+out|knocked\s+out|\bko['’]?d\b|blacked\s+out/i],
    ['dizziness', /dizzy|dizziness|vertigo/i],
    ['dehydration', /dehydrat|(?:extreme|excessive)\s+thirst|unable\s+to\s+keep\s+fluids?\s+down/i],
    ['weight_cutting', /(weight.*cut|cut\s+weight|rapid\s+weight|make\s+weight)/i],
    ['rapid_weight_loss', /rapid.*weight|fast\s+weight|lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week/i],
    ['chest_pain', /(chest|heart)\s+pain|cardiac/i],
    ['fainting', /faint|syncope/i],
    ['medication', /(take|taking|took)\s+(medicine|medication|drug|pill)/i],
    ['prescription', /prescrip|prescription|prescribed|Rx/i],
    ['surgery', /surgery|surgical|underwent\s+an?\s+operation|operation\s+on\s+(?:me|my|the)|operated\s+on/i],
    ['injection', /inject|needle|vaccine|medical\s+shot|cortisone\s+shot|steroid\s+shot/i],
    ['return_to_play', /(return.*play|cleared.*play|cleared\s+to)/i],
    ['medical_clearance', /(medical|doctor)\s+clear|cleared|clearance/i],
    ['youth_safety', /(minor|child|kid|young)\s+(safety|harm)/i],
    ['urgent_symptom', /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i],
  ];

  let classifiedTopic = 'none';
  for (const [topic, pattern] of topics) {
    if (pattern.test(msg)) {
      classifiedTopic = topic;
      break;
    }
  }

  const hasEducationalFraming = /\bwhat\s+(is|are|causes?|can|could|does)\b|research|understand|learn|educational|context|background|how\s+(is|are|does|do)\s+(an?|the|athletes?|coaches?|organizations?)/i.test(msg);
  const hasPersonalFraming = /\b(i|me|my|mine|we|our)\b/i.test(msg)
    || /\b(now|currently|today|just happened|during training|after sparring)\b/i.test(msg);
  const isEducationalQuery = hasEducationalFraming && !hasPersonalFraming;

  return {
    topic: classifiedTopic,
    isHighRisk: classifiedTopic !== 'none',
    educationalApproach: isEducationalQuery,
  };
}

function mainValidate(
  message: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userRole: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _organizationId: string,
): { valid: boolean; error?: string; highRisk?: boolean; topic?: string; classification?: string } {
  const classification = mainClassify(message);
  const normalizedMessage = message.toLowerCase();

  const hasPrescriptionLanguage = /\b(prescribe|prescribed|prescribing|prescription|rx)\b/i.test(message)
    || /should\s+i\s+take/i.test(message)
    || /should\s+you\s+take/i.test(message)
    || /take\s+(?:this\s+)?(?:medication|medicine|drug|pill)/i.test(message);

  const hasRapidWeightCutLanguage = /how\s+do\s+i\s+cut\s+weight/i.test(message)
    || normalizedMessage.includes('lose weight quickly')
    || normalizedMessage.includes('cut weight for my weight class')
    || /\b(?:i\s+(?:need|have)\s+to|help\s+me|how\s+(?:can|do)\s+i)\b.{0,35}\bmake\s+weight\b/i.test(message)
    || /\b(?:i\s+(?:need|want|have)\s+to\s+)?lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week\b/i.test(message);

  const hasPersonalContext = /\b(i|me|my|mine|we|our)\b/i.test(message)
    || /\b(now|currently|today|just happened|during training|after sparring|after (?:a|that|the) hit)\b/i.test(message);
  const hasUrgentSymptom = /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i.test(message);
  const hasAcuteImpactConcern = /(?:after|from).{0,30}(?:hit|blow|punch|fall).{0,60}(?:pain|numb|weak|tingl|blur|bleed|dizz|confus|vomit|can(?:not|'t))/i.test(message);
  const hasPersonalHealthConcern = /\b(hurt|hurts|hurting|pain|painful|sore|soreness|swollen|swelling|injured|injury|sprain(?:ed|ing)?|strain(?:ed|ing)?|bruised|bruising|numb|numbness|tingling|stiff|stiffness)\b/i.test(message);

  // Direct prescription or weight-cutting directives are blocked even when phrased as questions.
  if (hasPrescriptionLanguage || hasRapidWeightCutLanguage) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require prescription authority and professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Educational queries are allowed
  if (classification.educationalApproach) {
    return {
      valid: true,
      highRisk: classification.isHighRisk,
      topic: classification.topic,
      classification: classification.isHighRisk ? classification.topic : undefined,
    };
  }

  if (hasPersonalContext && (hasUrgentSymptom || hasAcuteImpactConcern)) {
    return {
      valid: false,
      error: 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.',
      highRisk: true,
      topic: classification.topic === 'none' ? 'urgent_symptom' : classification.topic,
      classification: 'urgent_personal_symptom',
    };
  }

  if (hasPersonalContext && hasPersonalHealthConcern) {
    return {
      valid: false,
      error: 'Personal pain, injury, and treatment questions require evaluation by a qualified medical professional. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: 'personal_health_concern',
    };
  }

  // Check for diagnosis claims
  if (/(do|does|did|am|is|have)\s+(i|you)\s+(have|have a|get|got|experience).*(concussion|fracture|injury|condition|disease|syndrome|disorder)/i.test(message)) {
    return {
      valid: false,
      error: 'Diagnosis and personal health assessment require professional medical evaluation.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for clearance claims
  if (
    /\bmedical\s+clear(?:ed|ance)?\b/i.test(message)
    || /\bclear(?:ed|ance)?\b.{0,40}\b(play|train|training|compete|competition|return|contact|spar|sparring)\b/i.test(message)
    || /\b(play|train|training|compete|competition|return|contact|spar|sparring)\b.{0,40}\bclear(?:ed|ance)?\b/i.test(message)
  ) {
    return {
      valid: false,
      error: 'Medical clearance decisions require professional medical authority.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for prescription claims
  if (/(should|do|can|need)\s+(i|you)\s+(take|use|try|get).*(medicine|medication|drug|pill|injection)/i.test(message)) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  if (classification.isHighRisk) {
    const emergencyTopic = (
      classification.topic === 'chest_pain'
      || classification.topic === 'fainting'
      || classification.topic === 'loss_of_consciousness'
    );
    return {
      valid: false,
      error: emergencyTopic
        ? 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.'
        : 'Personal high-risk health and safety concerns require immediate human evaluation. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: classification.topic,
    };
  }

  return { valid: true, highRisk: false, topic: 'none' };
}
/** True when main withheld the message on ANY of its seven returns. */
function mainWithheld(message: string): boolean {
  return mainValidate(message, 'athlete', 'org-123').valid === false;
}

/** The current implementation's answer to the same question. */
function nowWithholds(message: string): boolean {
  return validateShadowRequest(message, 'athlete', 'org-123').valid === false;
}

//
// WHAT THIS FILE DOES NOT COVER: ANYTHING ASTRAL.
//
// Every code point the three folds can produce is in the BMP, and both the
// sweep and the four properties iterate the BMP only. So an astral
// apostrophe or quote look-alike -- a styled mathematical form pasted from
// social media, for instance -- is NOT folded and NOT tested. It behaves as
// it does on main, which is the standard this hotfix is held to, so it is a
// gap in coverage rather than a regression. Closing it means deciding which
// astral characters are apostrophes, which is a judgement, and judgements of
// that kind belong in #1036 with the rest of the look-alike work rather than
// in a hotfix.
//
// Stated here rather than discovered later: a reader should not have to infer
// the limit from the loop bounds.
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
//   U+2000-U+206F   General Punctuation. Every exotic space and dash (none
//                   of which the fold touches any more), the curly quotes
//                   and primes it does, U+200B-U+200D, U+2028, U+2029, and
//                   the invisible format characters.
//   U+FEFF          The one that actually bit.
//   U+02B9-U+02BC, U+FF02, U+FF07, U+FF40   the fold's own targets that the
//                   ranges above miss; see the note on them below.
//   U+1680 U+180E U+3000 U+FFF9-U+FFFB   stragglers outside those ranges.
//
// SKIPPED, SAID OUT LOUD: U+0100-U+167F, U+1681-U+1FFF, U+2070-U+2FFF,
// U+3001-U+FEFE and U+FF00-U+FFFF, EXCEPT WHERE NAMED ABOVE -- and what is
// named above now includes every code point the fold rewrites. Those ranges are
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
  // THE FOLD'S OWN TARGETS, WHICH THIS LIST DID NOT COVER.
  //
  // Six of the nineteen code points normaliseForMatching rewrites fell in
  // the skipped ranges above: U+02B9, U+02BB, U+02BC (modifier letters) and
  // U+FF02, U+FF07, U+FF40 (full-width forms). The skip rationale said those
  // ranges are "overwhelmingly letters and symbols" that cannot act as
  // separators -- true in general, and false for exactly the characters this
  // fold acts on. The guard was not sweeping the characters it exists to
  // guard, and the comment claimed otherwise.
  //
  // Measured before adding them: no behaviour was lost through any of the
  // six, but they were 54 real comparisons the sweep was not making.
  [0x02b9, 0x02bc],
  [0xff02, 0xff02],
  [0xff07, 0xff07],
  [0xff40, 0xff40],
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
const CARRIERS: ReadonlyArray<readonly [string, string, number]> = [
  // THE BOUNDARY UNDER TEST IS THE ONLY EVIDENCE -- the position class the
  // sweep missed THIRD, raised by the architect review.
  //
  // "my|shoulder hurts" takes the personal-health path on main through
  // `\b(i|me|my|mine|we|our)\b` AND `\b(hurt|hurts|...)\b`. Insert a deleted
  // character and the fold produces "myshoulder hurts": `\bmy\b` fails,
  // hasPersonalContext goes false, and the refusal is lost.
  //
  // The sweep could not see it because the carrier that came closest --
  // "I|have a headache after sparring" -- contains "after sparring", which
  // satisfies hasPersonalContext on its own. Destroying the boundary at the
  // insertion point changed nothing there. A carrier whose ONLY evidence is
  // the boundary being tested is the one that catches it.
  ['boundary is the only evidence', 'my|shoulder hurts', 280],
  ['boundary is the only evidence, 2', 'I|hurt my wrist', 280],
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
  ['bounded window, vision', 'my vision is|really blurry', 330],
  ['bounded window, bleeding', 'my lip is bleeding pretty badly|and will not stop', 330],
  // BEFORE the match -- the position class the sweep missed FIRST.
  ['before contraction', "I got hit|can't breathe", 330],
  ['before cannot', 'I got hit|cannot breathe', 330],
  ['before symptom phrase', 'After that punch I had a|headache', 330],
  ['contraction gap', "I can't|breathe after that hit", 20],
  // SUBSTITUTED, not inserted. The first version of this carrier inserted a
  // code point BETWEEN "can" and "'t", which main's `can(?:not|'t)` can never
  // match for any character -- so it contributed nothing and swept nothing.
  // Caught by the per-carrier floor below, which is the whole reason that
  // floor exists. Replacing the apostrophe itself is the real question: main
  // matched only the ASCII one, and whatever the new code does, it must still
  // withhold that.
  // MINIMUM 1, AND THAT IS THE HONEST NUMBER. Main matched exactly one
  // substitution here -- the ASCII apostrophe -- so one is full coverage
  // for this carrier, not a collapsed one. A floor of 1 still catches the
  // only failure available to it: dropping to 0, which is what a typo in
  // the carrier or a drift in the reference would produce.
  ['apostrophe substituted', 'I can|t breathe after that hit', 1],
  ['cannot gap', 'I cannot|breathe after that hit', 20],
  ['two-word symptom', 'I have seeing|stars after sparring', 20],
  ['impact gap', 'My neck is numb after that|hit', 330],
  ['leading word gap', 'I|have a headache after sparring', 330],
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
        if (!mainWithheld(message)) continue;
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

  // THE PER-CARRIER FLOOR, WITH A MEASURED MINIMUM EACH.
  //
  // "At least one comparison" was not a floor. One carrier legitimately
  // contributes a single comparison -- the apostrophe-substitution one, where
  // main matched only the ASCII apostrophe -- and the others contribute
  // hundreds, so a carrier could fall from 375 to 1 and still pass. Coverage
  // could collapse by 99.7% without the suite noticing, which is the same
  // "a floor nothing can fail" problem the total had.
  //
  // So each carrier declares the minimum it must contribute, measured, with
  // headroom. If a carrier stops matching -- a typo in it, a drift in the
  // frozen reference, a fold that changes what main sees -- it fails here and
  // names itself, rather than quietly sweeping nothing.
  //
  // These numbers are measured, not chosen. Raising one to silence a failure
  // is how this guard stops working; find out why the count dropped instead.
  test('every carrier still contributes its measured minimum', () => {
    const points = sweptCodePoints();
    const shortfalls: string[] = [];

    for (const [name, carrier, minimum] of CARRIERS) {
      const [head, tail] = carrier.split('|');
      const got = points.filter(
        (cp) => mainWithheld(head + String.fromCodePoint(cp) + tail),
      ).length;
      if (got < minimum) shortfalls.push(`${name}: ${got} < ${minimum}`);
    }

    expect(shortfalls).toEqual([]);
  });

  // The one that bit, called out by name so it can never be quietly dropped
  // from the sweep set without a test going red.
  test('U+FEFF specifically, which main treated as whitespace', () => {
    const message = "I can't﻿breathe after that hit";
    expect(mainWithheld(message)).toBe(true);
    expect(nowWithholds(message)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE FOLD IS ALLOWED TO DO, PINNED THREE WAYS
//
// Carriers and code points are enumeration: they test the positions and
// characters somebody thought of, and three times that enumeration had a hole
// the code did not. The tests in this block do not depend on anyone thinking
// of a phrase.
//
//   THE EXACT MAP. Every UTF-16 code unit folds to itself, except nineteen
//   named ones, each to its named output. This is the proof of what the fold
//   does to one character; it is written out as data a second time so that a
//   change to the fold has to be made in two places to go unnoticed.
//
//   THE FOUR CLASS PROPERTIES. Length, word class, whitespace class and
//   line-terminator class are preserved. With the exact map in place these
//   are CONSEQUENCES of it, not independent evidence: nineteen non-word
//   characters each become one non-word character. They stay because they
//   say WHY the map is safe -- the day someone adds a twentieth entry, the
//   map test will be edited to match, and these are what tell them whether
//   the new entry breaks a pattern.
//
//   ONE CHARACTER AT A TIME. The fold of a string is the fold of each of its
//   code units, in order. That is what makes a statement about single
//   characters a statement about messages.
//
// The class properties exist because the patterns in shadowChat.ts do four
// things a fold can silently break: they COUNT CHARACTERS
// (`vision.{0,12}blurr`, `bleeding.{0,20}`, `after.{0,30}hit.{0,60}`), they
// ASSERT WORD BOUNDARIES (`\b(i|me|my|mine|we|our)\b`, which every urgent
// branch depends on), they TEST WHITESPACE (`\s+`), and they let `.` STOP AT
// A LINE TERMINATOR. Each class property pins one of those.
//
// Six regressions were caused by violating them, each one a message main
// WITHHELD that the fold then allowed through to the model with nobody told:
// NFKC expanded (property 1), NFKC created word characters (property 2),
// deleting U+200B-U+200D and U+00AD merged adjacent words (properties 1 and
// 2), whitespace collapsing shortened text (property 1), and an earlier
// version DELETED U+FEFF where main treated it as whitespace (property 3).
// ---------------------------------------------------------------------------
describe('the fold preserves what the patterns depend on', () => {
  const BMP = 0x10000;
  const WORD = /[A-Za-z0-9_]/;
  const SPACE = /\s/;

  /** Every BMP code point that is a real character someone could type. */
  function codePoints(): string[] {
    const out: string[] = [];
    for (let cp = 0; cp < BMP; cp += 1) {
      // Lone surrogates are not characters; skip rather than assert on
      // malformed input.
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      out.push(String.fromCodePoint(cp));
    }
    return out;
  }

  function label(ch: string): string {
    return 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  }

  // PROPERTY 1 -- LENGTH IS PRESERVED EXACTLY.
  //
  // Stronger than "never lengthens", which was the earlier form and was not
  // enough: whitespace collapsing and deletion both SHORTEN, and shortening
  // moves a counted window just as surely. Exactly equal is the only form
  // that cannot be worked around.
  test('every code point folds to exactly one character', () => {
    const offenders = codePoints()
      .filter((ch) => normaliseForMatching('a' + ch + 'b').length !== 3)
      .map((ch) => label(ch) + ' -> ' + JSON.stringify(normaliseForMatching('a' + ch + 'b')));
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // PROPERTY 2 -- THE WORD CLASS OF EVERY POSITION IS PRESERVED.
  //
  // A word character must stay one and a non-word character must stay one.
  // NFKC turned U+2122 into "TM" (non-word to word); deleting U+200B turned
  // "my<ZWSP>shoulder" into "myshoulder", which destroys the boundary a
  // different way. Both are caught here.
  test('no code point changes the word class of its position', () => {
    const offenders = codePoints()
      .filter((ch) => {
        const folded = normaliseForMatching('a' + ch + 'b');
        if (folded.length !== 3) return false; // property 1 reports that
        return WORD.test(ch) !== WORD.test(folded[1]);
      })
      .map((ch) => label(ch) + ' -> ' + JSON.stringify(normaliseForMatching('a' + ch + 'b')[1]));
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // PROPERTY 3 -- THE WHITESPACE CLASS OF EVERY POSITION IS PRESERVED.
  //
  // The patterns use `\s+` between words. A fold that makes a non-space into
  // a space creates matches main did not have; one that makes a space into a
  // non-space destroys matches main did.
  //
  // NO EXCEPTION IS NEEDED, which is tighter than the instruction asked for.
  // The one fold that changes a character into a space is U+FEFF -> ' ', and
  // ECMAScript `\s` ALREADY counts U+FEFF as whitespace, so the class is
  // preserved rather than excepted. That is also exactly why deleting it was
  // a regression: main had been matching on it all along.
  test('no code point changes the whitespace class of its position', () => {
    const offenders = codePoints()
      .filter((ch) => {
        const folded = normaliseForMatching('a' + ch + 'b');
        if (folded.length !== 3) return false;
        return SPACE.test(ch) !== SPACE.test(folded[1]);
      })
      .map((ch) => label(ch) + ' -> ' + JSON.stringify(normaliseForMatching('a' + ch + 'b')[1]));
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // PROPERTY 4 -- THE LINE-TERMINATOR CLASS OF EVERY POSITION IS PRESERVED.
  //
  // Distinct from property 3, and not implied by it. Every line terminator is
  // whitespace, so a fold turning U+2028 into a space would satisfy property 3
  // while changing what `.` matches: no pattern in shadowChat.ts carries the
  // /s flag, so `.` stops at a line terminator and does not stop at a space.
  // The unbounded gaps -- `weight.*cut`, `return.*play`, the diagnosis `.*` --
  // and every bounded `.{0,N}` window are bounded by exactly that.
  //
  // This already bit once. Collapsing all whitespace folded newlines away and
  // two ordinary two-line messages were withheld. It was fixed by excluding
  // the terminators from the collapse, then the collapse was removed
  // altogether -- so nothing in the current fold can violate this. The
  // property is here so that nothing added later can either, and U+FEFF to a
  // space is exactly the shape of fold that would.
  test('no code point changes the line-terminator class of its position', () => {
    const TERMINATOR = /[\n\r\u2028\u2029]/;
    const offenders = codePoints()
      .filter((ch) => {
        const folded = normaliseForMatching('a' + ch + 'b');
        if (folded.length !== 3) return false;
        return TERMINATOR.test(ch) !== TERMINATOR.test(folded[1]);
      })
      .map((ch) => label(ch) + ' -> ' + JSON.stringify(normaliseForMatching('a' + ch + 'b')[1]));
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE EXACT MAP -- answers "the properties do not constrain identity".
  //
  // The four class properties above are satisfied by a fold that rewrites one
  // letter into another letter of the same class: U+00E9 into U+00E8, say.
  // Nothing in them says WHICH character a position ends up holding, and the
  // patterns match on which character it is.
  //
  // So the whole of the fold is written out here as data, and every one of
  // the 65,536 UTF-16 code units is checked against it -- lone surrogate
  // units included, because the fold works on code units and a unit it
  // altered would be half of somebody's emoji.
  // -------------------------------------------------------------------------
  const APOSTROPHE_TARGETS: readonly number[] = [
    0x0060, // GRAVE ACCENT (the ASCII backtick)
    0x00b4, // ACUTE ACCENT
    0x02b9, // MODIFIER LETTER PRIME
    0x02bb, // MODIFIER LETTER TURNED COMMA
    0x02bc, // MODIFIER LETTER APOSTROPHE
    0x2018, // LEFT SINGLE QUOTATION MARK
    0x2019, // RIGHT SINGLE QUOTATION MARK -- the phone default, and the defect
    0x201a, // SINGLE LOW-9 QUOTATION MARK
    0x201b, // SINGLE HIGH-REVERSED-9 QUOTATION MARK
    0x2032, // PRIME
    0xff07, // FULLWIDTH APOSTROPHE
    0xff40, // FULLWIDTH GRAVE ACCENT
  ];
  const QUOTE_TARGETS: readonly number[] = [
    0x201c, // LEFT DOUBLE QUOTATION MARK
    0x201d, // RIGHT DOUBLE QUOTATION MARK
    0x201e, // DOUBLE LOW-9 QUOTATION MARK
    0x201f, // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
    0x2033, // DOUBLE PRIME
    0xff02, // FULLWIDTH QUOTATION MARK
  ];
  const EXPECTED_FOLD: ReadonlyMap<number, string> = new Map<number, string>([
    ...APOSTROPHE_TARGETS.map((unit) => [unit, "'"] as [number, string]),
    ...QUOTE_TARGETS.map((unit) => [unit, '"'] as [number, string]),
    [0xfeff, ' '],
  ]);
  const UNITS = 0x10000;

  function unitLabel(unit: number): string {
    return 'U+' + unit.toString(16).toUpperCase().padStart(4, '0');
  }

  test('the map names nineteen code units: twelve apostrophes, six quotes, U+FEFF', () => {
    expect(APOSTROPHE_TARGETS.length).toBe(12);
    expect(QUOTE_TARGETS.length).toBe(6);
    // A Map silently keeps the last of two equal keys, so a unit listed twice
    // would shrink it and the two counts above would not notice.
    expect(EXPECTED_FOLD.size).toBe(19);
  });

  test('every code unit folds to itself, except the nineteen named ones, each to its named output', () => {
    const offenders: string[] = [];
    let rewritten = 0;

    for (let unit = 0; unit < UNITS; unit += 1) {
      const ch = String.fromCharCode(unit);
      const expected = EXPECTED_FOLD.get(unit) ?? ch;
      if (expected !== ch) rewritten += 1;

      // Alone AND between two letters: the same answer in both places is
      // what lets the later tests treat the fold of one unit as a fact about
      // that unit rather than about where it was standing.
      const alone = normaliseForMatching(ch);
      const between = normaliseForMatching('a' + ch + 'b');
      if (alone !== expected || between !== 'a' + expected + 'b') {
        offenders.push(
          `${unitLabel(unit)}: expected ${JSON.stringify(expected)}, `
          + `got ${JSON.stringify(alone)} alone and ${JSON.stringify(between)} between letters`,
        );
      }
    }

    // The loop above cannot pass by the table being empty.
    expect(rewritten).toBe(19);
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ONE CHARACTER AT A TIME -- answers "the properties test one code point in
  // one fixed context".
  //
  // Everything above feeds the fold a single unit. A rule that fires on MORE
  // than one character -- "..." into an ellipsis, two apostrophes into a
  // quote, a trim, a run of spaces collapsed, an apostrophe folded only
  // before a "t" -- is invisible to all of it. Whitespace collapsing, in this
  // fix's own history, was exactly that shape.
  //
  // The property that rules the shape out: the fold of a string is the fold
  // of each of its code units, concatenated. fold(xy) = fold(x) + fold(y).
  //
  // WHAT A TEST ADDS HERE, HONESTLY. Today this is true by construction:
  // normaliseForMatching is three global replaces, each of a single-unit
  // character class with a fixed one-unit string, and reading it proves more
  // than running it. The tests below are for the next edit. They are what
  // goes red when someone adds a fourth line that is not of that form.
  //
  // WHAT THEY DO NOT PROVE. "For every string" is not something a test can
  // finish. What is run is: every code unit with every member of a named
  // 161-character context set immediately before and after it; every code
  // unit first and last in a message; every string of one, two or three ASCII
  // characters; and twenty thousand seeded random strings weighted toward
  // the fold's own targets. A rule keyed on two or more adjacent characters
  // that are all outside the context set, or on an ASCII sequence longer than
  // three, or on something more than one character away, would be seen only
  // by the random strings, if at all.
  // -------------------------------------------------------------------------
  describe('the fold of a string is the fold of each of its characters', () => {
    // What the fold does to each unit alone. Pinned to the named map by the
    // test above, so this is not the fold marking its own homework.
    const UNIT_CHARS: string[] = [];
    const UNIT_FOLD: string[] = [];
    for (let unit = 0; unit < UNITS; unit += 1) {
      UNIT_CHARS.push(String.fromCharCode(unit));
      UNIT_FOLD.push(normaliseForMatching(UNIT_CHARS[unit]));
    }

    function unitwise(text: string): string {
      const out: string[] = new Array(text.length);
      for (let i = 0; i < text.length; i += 1) out[i] = UNIT_FOLD[text.charCodeAt(i)];
      return out.join('');
    }

    function show(text: string): string {
      return Array.from({ length: text.length }, (_, i) => unitLabel(text.charCodeAt(i))).join(' ');
    }

    // The neighbours worth standing beside: all of ASCII (every character the
    // patterns are written in, every ASCII space and control), everything the
    // fold reads or writes, and the characters behind each earlier defect.
    const CONTEXT_UNITS: readonly number[] = [
      ...Array.from({ length: 0x80 }, (_, unit) => unit),
      ...EXPECTED_FOLD.keys(),
      0x0085, // NEL
      0x00a0, // NBSP
      0x00ad, // SOFT HYPHEN
      0x00e9, // a non-ASCII letter
      0x0301, // COMBINING ACUTE ACCENT
      0x200b, 0x200c, 0x200d, // zero-width space, non-joiner, joiner
      0x2026, // HORIZONTAL ELLIPSIS, which NFKC expanded
      0x2028, 0x2029, // the two non-ASCII line terminators
      0x2122, // TRADE MARK SIGN, which NFKC turned into letters
      0x3000, // IDEOGRAPHIC SPACE
      0xd83e, 0xdd4a, // the two halves of U+1F94A
    ].filter((unit, index, all) => all.indexOf(unit) === index);

    // One string per context character c: "c x0 c x1 c x2 ... c" over all
    // 65,536 units, so every unit stands with c immediately before it AND
    // immediately after it. 161 strings rather than 21 million two-character
    // ones, which is the same adjacencies in about a hundredth of the time
    // (the pairwise form was measured at 83 seconds on this suite).
    test('every code unit with every context character on both sides of it', () => {
      const offenders: string[] = [];

      for (const context of CONTEXT_UNITS) {
        const c = String.fromCharCode(context);
        const foldedC = UNIT_FOLD[context];
        const parts: string[] = [c];
        const expectedParts: string[] = [foldedC];
        for (let unit = 0; unit < UNITS; unit += 1) {
          parts.push(UNIT_CHARS[unit], c);
          expectedParts.push(UNIT_FOLD[unit], foldedC);
        }
        const text = parts.join('');

        const folded = normaliseForMatching(text);
        const expected = expectedParts.join('');
        if (folded === expected) continue;

        // Name the first place they part company, with a little either side.
        let at = 0;
        while (at < folded.length && at < expected.length && folded[at] === expected[at]) at += 1;
        offenders.push(
          `context ${unitLabel(context)}: differs at index ${at} `
          + `(lengths ${folded.length} vs ${expected.length}), near ${show(text.slice(Math.max(0, at - 2), at + 3))}`,
        );
      }

      expect(offenders.slice(0, 40)).toEqual([]);
      // Stated so the number in the pull request is the number that ran.
      expect(CONTEXT_UNITS.length).toBe(161);
    });

    // The interleaved strings above put nothing but c at either END, so a
    // rule anchored to the start or end of the message -- a trim, a `^`, a
    // `$` -- needs its own look. Every unit first and last, beside a letter,
    // a space and an apostrophe.
    test('every code unit at the start and at the end of a message', () => {
      const offenders: string[] = [];
      let compared = 0;

      for (const c of ['a', ' ', "'"]) {
        for (let unit = 0; unit < UNITS && offenders.length < 40; unit += 1) {
          const x = String.fromCharCode(unit);
          for (const text of [x + c, c + x]) {
            compared += 1;
            if (normaliseForMatching(text) !== unitwise(text)) offenders.push(show(text));
          }
        }
      }

      expect(offenders).toEqual([]);
      expect(compared).toBe(3 * UNITS * 2);
    });

    test('every ASCII string of one, two or three characters', () => {
      const offenders: string[] = [];
      let compared = 0;
      const ascii = Array.from({ length: 0x80 }, (_, unit) => String.fromCharCode(unit));

      for (const a of ascii) {
        compared += 1;
        if (normaliseForMatching(a) !== unitwise(a)) offenders.push(show(a));
        for (const b of ascii) {
          compared += 1;
          if (normaliseForMatching(a + b) !== unitwise(a + b)) offenders.push(show(a + b));
          for (const c of ascii) {
            compared += 1;
            const text = a + b + c;
            if (normaliseForMatching(text) !== unitwise(text)) offenders.push(show(text));
          }
        }
        if (offenders.length >= 40) break;
      }

      expect(offenders.slice(0, 40)).toEqual([]);
      expect(compared).toBe(128 + 128 * 128 + 128 * 128 * 128);
    });

    test('twenty thousand seeded random strings, weighted toward the fold\'s own targets', () => {
      // mulberry32. Seeded, so a failure is the same failure on every machine.
      let state = 0x1049;
      const random = (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const targets = [...EXPECTED_FOLD.keys()];
      const pick = (): number => {
        const roll = random();
        if (roll < 0.4) return targets[Math.floor(random() * targets.length)];
        if (roll < 0.7) return Math.floor(random() * 0x80);
        return Math.floor(random() * UNITS);
      };

      const offenders: string[] = [];
      let touched = 0;
      for (let n = 0; n < 20000 && offenders.length < 40; n += 1) {
        const length = 1 + Math.floor(random() * 64);
        let text = '';
        for (let i = 0; i < length; i += 1) text += String.fromCharCode(pick());
        const folded = normaliseForMatching(text);
        if (folded !== text) touched += 1;
        if (folded !== unitwise(text)) offenders.push(show(text));
      }

      expect(offenders).toEqual([]);
      // If the generator stopped producing targets this would compare
      // unchanged strings with unchanged strings and prove nothing.
      expect(touched).toBeGreaterThan(19000);
    });

    // SURROGATE PAIRS, STATED RATHER THAN ASSUMED.
    //
    // The fold has no `u` flag and works on UTF-16 code units. Every unit it
    // rewrites is outside U+D800-U+DFFF and so is everything it writes, so it
    // can neither split a pair nor alter half of one; the exact-map test
    // covers each surrogate unit alone, and this covers a whole astral
    // character standing directly against each of the nineteen targets.
    //
    // This is NOT astral coverage of the classifier. U+E0027 below is TAG
    // APOSTROPHE, an astral apostrophe look-alike, and it is deliberately
    // asserted as NOT folded: astral look-alikes behave as they do on main.
    test.each(['\u{1F94A}', '\u{E0027}'])('an astral character against each target is neither split nor altered: %j', (astral) => {
      expect(astral.length).toBe(2);
      for (const [unit, output] of EXPECTED_FOLD) {
        const target = String.fromCharCode(unit);
        expect(normaliseForMatching(astral + target + astral)).toBe(astral + output + astral);
        expect(normaliseForMatching(target + astral + target)).toBe(output + astral + output);
      }
    });
  });

  // The floor: if normaliseForMatching became the identity function, the
  // four class properties above would pass trivially and the fix would be
  // gone. (The exact-map test would fail too; this one says so in a line.)
  test('the fold still folds', () => {
    expect(normaliseForMatching('can\u2019t')).toBe("can't");
    expect(normaliseForMatching('can\u00B4t')).toBe("can't");
    expect(normaliseForMatching('a\uFEFFb')).toBe('a b');
    // And it leaves alone everything it no longer touches.
    expect(normaliseForMatching('a\u200Bb')).toBe('a\u200Bb');
    expect(normaliseForMatching('a\u00ADb')).toBe('a\u00ADb');
    expect(normaliseForMatching('a  b')).toBe('a  b');
    expect(normaliseForMatching(' a ')).toBe(' a ');
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

// ---------------------------------------------------------------------------
// THE ONE MEASURED DIFFERENCE THAT IS NOT A SENSITIVITY CHANGE
//
// Found by a differential reviewer sweeping ~439 million comparisons. It was
// the ONLY both-withhold divergence in the whole sweep, and it is pinned here
// rather than left in a pull-request body, because a persisted safety record
// changes shape and nothing else in the diff says so.
//
// Folding U+FEFF to a space makes `normalizedMessage.includes('cut weight for
// my weight class')` match where main did not -- main saw the BOM, not a
// space, missed the literal, and fell through to the isHighRisk fallback,
// which sets `classification: 'weight_cutting'`. The current code takes the
// earlier rapid-weight-cut return instead, and that return sets no
// `classification` field at all.
//
// WHAT CHANGES, EXACTLY: both versions WITHHOLD, and the review row's severity
// is 'high' on both sides, because 'weight_cutting' is not in the critical
// list. What differs is the row's `validationClassification`, which goes from
// 'weight_cutting' to null. A reviewer opening that row loses the category.
//
// WHY IT IS NOT FIXED HERE: the fix is to add a classification to main's
// rapid-weight-cut return, which means editing a branch this PR has committed
// to leaving byte-identical to main, for a metadata field on a path that still
// withholds. It belongs in #1036, which already rewrites that branch.
// ---------------------------------------------------------------------------
describe('a known, measured divergence in review metadata', () => {
  const BOM = '﻿';
  const message = `cut weight${BOM}for my weight class`;

  test('both versions still withhold; only the recorded category differs', () => {
    expect(mainWithheld(message)).toBe(true);
    expect(nowWithholds(message)).toBe(true);

    // The difference, asserted so it cannot change unnoticed.
    expect(mainValidate(message, 'athlete', 'org-123').classification).toBe('weight_cutting');
    expect(validateShadowRequest(message, 'athlete', 'org-123').classification).toBeUndefined();
  });

  test('the ASCII-space form is unaffected on both sides', () => {
    const plain = 'cut weight for my weight class';
    expect(mainValidate(plain, 'athlete', 'org-123').classification).toBeUndefined();
    expect(validateShadowRequest(plain, 'athlete', 'org-123').classification).toBeUndefined();
  });
});
