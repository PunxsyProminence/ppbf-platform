import fs from 'node:fs';
import path from 'node:path';

import { buildGuidedSession } from './guidedSession';
import {
  CONTENT_AUTHORITY,
  MANUAL_DELIVERY_RULES,
  PF001_RING_CUTTER,
  VISUALIZATION_CONTENT_SOURCE,
} from './pf001Scenario';

/**
 * The authored content, the manual's delivery rules and the order are the
 * product here, so all three are pinned against the source document rather than
 * against themselves.
 *
 * THE ORDER IS SPELLED OUT AS A LITERAL BELOW. That is the point: if someone
 * reorders buildGuidedSession -- moves the debrief before Round 3, asks the
 * question before the opponent acts -- these tests fail, because the expectation
 * does not come from the code under test.
 *
 * VIZ-1 DELIVERS LEVEL 1 ONLY. The source document's Level 2 and Level 3 wording
 * is still pinned here, because the copy must stay faithful to the whole
 * document, but nothing builds a session from it and no test calls it
 * implemented.
 */

const SOURCE_EXCERPTS = {
  beforeTheBell:
    'Picture a patient ring-cutter in a orthodox stance. The physical relationship is similar height/reach, and the opponent prefers mid to close range. He gives up a little speed to step diagonally across your escape lane before he punches. Do not reveal the adjustment yet. Let the athlete discover the first version of the opponent.',
  firstKeyCue: 'Lead foot crossing your escape lane.',
  discoverPurpose: 'What am I fighting?',
  discoverCoachAsks: '“What changed first—the feet, the shoulders, the distance, or the pace?”',
  adaptLevel3:
    'Once you escape twice, he starts punching during the cut…  •  He comes again.  •  He may return to the old pattern.  •  Solve what is actually there.',
  firstDebriefQuestion:
    'What was the first reliable cue that helped you identify this primary problem: Recognize the difference between being followed and being cut off.',
  beatRule:
    'See the cue before the answer: allow a brief beat after describing the opponent’s action so the athlete can create the picture.',
  optionsRule:
    'At Level 1, each round includes potential athlete responses. These are coaching resources, not a multiple-choice test and not a list the coach must read aloud. Offer options only when a beginner cannot yet generate a decision independently. If the athlete proposes a different technically sound response that fits the imagined distance and position, accept it.',
} as const;

describe('PF-001 content is the authored scenario, copied not rewritten', () => {
  test('its identity and source are the ones the coach can read on screen', () => {
    expect(PF001_RING_CUTTER.id).toBe('PF-001');
    expect(PF001_RING_CUTTER.title).toBe('The Ring-Cutter');
    expect(PF001_RING_CUTTER.difficulty).toBe('Foundation');
    expect(PF001_RING_CUTTER.opponentFamily).toBe('Pressure Fighter');
    expect(PF001_RING_CUTTER.positionInFamily).toBe('1 OF 17');
    expect(VISUALIZATION_CONTENT_SOURCE.document).toBe(
      'Adaptive_Amateur_Boxing_Visualization_Curriculum_100_Scenarios.docx',
    );
    expect(VISUALIZATION_CONTENT_SOURCE.dated).toBe('2026-09-15');
    expect(VISUALIZATION_CONTENT_SOURCE.version).toContain('Content V4.1');
  });

  test('the authored wording is present verbatim, not paraphrased', () => {
    expect(PF001_RING_CUTTER.beforeTheBell).toContain(SOURCE_EXCERPTS.beforeTheBell);
    expect(PF001_RING_CUTTER.keyVisualCues[0]).toBe(SOURCE_EXCERPTS.firstKeyCue);
    expect(PF001_RING_CUTTER.rounds[0].purpose).toBe(SOURCE_EXCERPTS.discoverPurpose);
    expect(PF001_RING_CUTTER.rounds[0].level1.coachAsks).toBe(SOURCE_EXCERPTS.discoverCoachAsks);
    expect(PF001_RING_CUTTER.rounds[2].level3Cues).toBe(SOURCE_EXCERPTS.adaptLevel3);
    expect(PF001_RING_CUTTER.debriefQuestions[0]).toBe(SOURCE_EXCERPTS.firstDebriefQuestion);
  });

  test('the three-round arc is whole: purpose, options, cue levels, and a debrief', () => {
    expect(PF001_RING_CUTTER.rounds.map((round) => round.key)).toEqual(['discover', 'solve', 'adapt']);
    for (const round of PF001_RING_CUTTER.rounds) {
      expect(round.level1.options).toHaveLength(3);
      expect(round.level1.options.map((option) => option.slice(0, 2))).toEqual(['A.', 'B.', 'C.']);
      expect(round.level2Cues.length).toBeGreaterThan(0);
      expect(round.level3Cues.length).toBeGreaterThan(0);
    }
    expect(PF001_RING_CUTTER.debriefQuestions).toHaveLength(4);
    // Rounds 1 and 2 carry a corner note; Round 3 has none in the source, and
    // none was invented to make the shape regular.
    expect(PF001_RING_CUTTER.rounds.map((round) => round.cornerNote === null)).toEqual([false, false, true]);
  });

  test("the manual's own delivery rules are carried, not summarized", () => {
    expect(MANUAL_DELIVERY_RULES.visualizationRules).toHaveLength(6);
    expect(MANUAL_DELIVERY_RULES.visualizationRules).toContain(SOURCE_EXCERPTS.beatRule);
    expect(MANUAL_DELIVERY_RULES.deliveryLevels.map((row) => row.level)).toEqual([
      '1 — Guided',
      '2 — Decision',
      '3 — Adaptive / Scored',
    ]);
    expect(MANUAL_DELIVERY_RULES.deliveryLevels[0].coachGivesTiming).toContain('Untimed.');
    expect(MANUAL_DELIVERY_RULES.level1OptionsRule).toBe(SOURCE_EXCERPTS.optionsRule);
    expect(MANUAL_DELIVERY_RULES.level1OptionsBullets).toHaveLength(5);
    expect(MANUAL_DELIVERY_RULES.level1OptionsBullets[0]).toBe(
      'Describe the opponent action and give the athlete enough time to see it.',
    );
    expect(MANUAL_DELIVERY_RULES.level1OptionsBullets[1]).toBe('Ask the coach question before offering answers.');
    expect(MANUAL_DELIVERY_RULES.level3Note).toContain('not a command-response drill');
  });

  /**
   * R5. A word in an authored scenario is not a scoring system, and a word list
   * is not a contract. What must be true is structural: nothing this module
   * exports carries a score, rating, verdict or progression decision, and a
   * session produces prompts and nothing else.
   */
  test('the exported content has no field that could hold a judgement', () => {
    const JUDGEMENT = /score|rating|rate|mastery|grade|verdict|pass|fail|progress|promote|result|outcome|percent|points|rubric|assessment|evaluation/i;

    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(PF001_RING_CUTTER);
    walk(MANUAL_DELIVERY_RULES);
    walk(buildGuidedSession(PF001_RING_CUTTER));

    expect([...keys].filter((key) => JUDGEMENT.test(key))).toEqual([]);
    // And the values are prose, not measurements: no numbers are carried at all.
    const numbers: unknown[] = [];
    const walkValues = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walkValues);
      if (value && typeof value === 'object') return Object.values(value).forEach(walkValues);
      if (typeof value === 'number' || typeof value === 'boolean') numbers.push(value);
    };
    walkValues(PF001_RING_CUTTER);
    walkValues(MANUAL_DELIVERY_RULES);
    walkValues(buildGuidedSession(PF001_RING_CUTTER));
    expect(numbers).toEqual([]);
  });

  test('a session is a list of prompts: it computes nothing and returns no result', () => {
    const segments = buildGuidedSession(PF001_RING_CUTTER);
    for (const step of segments) {
      expect(Object.keys(step).sort()).toEqual([
        'body',
        'items',
        'key',
        'kind',
        'note',
        'onRequest',
        'phase',
        'title',
      ]);
    }
    // The last step is an end state, not a verdict: it carries no content of
    // its own to interpret.
    const last = segments[segments.length - 1];
    expect(last.kind).toBe('complete');
    expect(last.body).toEqual([]);
    expect(last.items).toEqual([]);
    expect(last.onRequest).toBeNull();
  });

  test('the module exports only content, its order and their types', () => {
    const lib = jest.requireActual<Record<string, unknown>>('./guidedSession');
    const content = jest.requireActual<Record<string, unknown>>('./pf001Scenario');
    expect(Object.keys(lib).sort()).toEqual(['buildGuidedSession']);
    expect(Object.keys(content).sort()).toEqual([
      'CONTENT_AUTHORITY',
      'MANUAL_DELIVERY_RULES',
      'PF001_RING_CUTTER',
      'VISUALIZATION_CONTENT_SOURCE',
    ]);
  });
});

/**
 * VIZ-1's product boundary, held in the model rather than only on the screen.
 *
 * The authorized user unit is ONE Level 1 Guided exposure. An earlier head built
 * all three delivery modes and offered them as runnable choices, which promised
 * two capabilities that do not exist -- and Level 3 the source defines as timed
 * and scored, with neither a timer nor a scorecard anywhere in this slice. These
 * tests fail if a session ever again contains a mode this product does not
 * deliver.
 */
describe('the session is a Level 1 Guided exposure, and only that', () => {
  test('the whole authored order, once, from the opponent picture to session complete', () => {
    expect(buildGuidedSession(PF001_RING_CUTTER).map((s) => s.key)).toEqual([
      'before-the-bell',
      'key-visual-cues',
      'common-mistakes',
      'discover-purpose',
      'discover-action',
      'discover-question',
      'discover-guidance',
      'discover-continue',
      'discover-corner',
      'solve-purpose',
      'solve-action',
      'solve-question',
      'solve-guidance',
      'solve-continue',
      'solve-corner',
      'adapt-purpose',
      'adapt-action',
      'adapt-question',
      'adapt-guidance',
      'adapt-continue',
      'debrief',
      'complete',
    ]);
  });

  test('every round is delivered the guided way, and no other way exists in the model', () => {
    const segments = buildGuidedSession(PF001_RING_CUTTER);
    const perRound = segments
      .map((step) => step.kind)
      .filter((kind) => !['opponent', 'cues', 'mistakes', 'round-purpose', 'corner', 'debrief', 'complete'].includes(kind));

    expect([...new Set(perRound)]).toEqual([
      'opponent-action',
      'coach-question',
      'coach-guidance',
      'continue',
    ]);

    // The Level 2 and Level 3 shapes are gone from the model, not merely
    // unreachable: no key, no kind, and none of their wording is delivered.
    expect(segments.map((step) => step.key).filter((key) => /reduced-cues|cue-only/.test(key))).toEqual([]);
    const delivered = segments.flatMap((step) => [...step.body, ...step.items, step.note ?? '']).join(' ');
    for (const round of PF001_RING_CUTTER.rounds) {
      expect(delivered).not.toContain(round.level2Cues);
      expect(delivered).not.toContain(round.level3Cues);
    }
    expect(delivered).not.toContain(MANUAL_DELIVERY_RULES.level3Note);
  });

  test('buildGuidedSession takes no mode to choose, so none can be half-built', () => {
    // Read from source, not from Function.length: a defaulted parameter
    // (`level: DeliveryLevel = 1`) reports length 1 too, so arity would have
    // passed with the whole level engine restored.
    const signature = fs.readFileSync(path.join(__dirname, 'guidedSession.ts'), 'utf8');
    expect(signature).toContain(
      'export function buildGuidedSession(scenario: VisualizationScenario): SessionSegment[]',
    );
    expect(signature).not.toMatch(/DeliveryLevel/);
  });

  test('every authored field delivered comes from the source, so no clock or tally can be introduced', () => {
    // Set membership, not a word search. Scanning authored prose for words like
    // "second" is brittle and wrong -- the manual says "On the second,
    // emphasize..." about a second pass, not about a stopwatch. What actually
    // matters is that the session invents no prose at all: if every delivered
    // string is an authored string, a timer or a scorecard cannot appear in one.
    const authored = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') return authored.add(value);
      if (Array.isArray(value)) return value.forEach(collect);
      if (value && typeof value === 'object') return Object.values(value).forEach(collect);
      return undefined;
    };
    collect(PF001_RING_CUTTER);
    collect(MANUAL_DELIVERY_RULES);

    for (const step of buildGuidedSession(PF001_RING_CUTTER)) {
      for (const paragraph of step.body) expect(authored).toContain(paragraph);
      for (const item of step.items) expect(authored).toContain(item);
      if (step.note !== null) expect(authored).toContain(step.note);
      if (step.onRequest) {
        expect(authored).toContain(step.onRequest.rule);
        for (const bullet of step.onRequest.ruleBullets) expect(authored).toContain(bullet);
        for (const option of step.onRequest.items) expect(authored).toContain(option);
      }
    }

    // `title` and `phase` are NOT authored -- they are the structural labels the
    // module writes, and `title` is what the page reads out as the prompt. So
    // they are held against an explicit list instead of against the source: a
    // new one cannot appear unnoticed, and the test does not pretend they came
    // from the manual.
    const STRUCTURAL = new Set([
      'Before the Bell — Build the Opponent',
      'Key visual cues',
      'Common athlete mistakes',
      'The opponent acts',
      'Ask the athlete',
      'Coach guidance',
      'Continue the fight',
      'Corner note',
      'Post-Fight Debrief',
      'Session complete',
      'Before the bell',
      'Round 1 of 3 — DISCOVER',
      'Round 2 of 3 — SOLVE',
      'Round 3 of 3 — ADAPT',
      'Debrief',
      'Offer the response options',
    ]);
    for (const step of buildGuidedSession(PF001_RING_CUTTER)) {
      expect(STRUCTURAL.has(step.phase)).toBe(true);
      // A round purpose is authored; every other title is structural.
      if (!STRUCTURAL.has(step.title)) expect(authored).toContain(step.title);
      if (step.onRequest) expect(STRUCTURAL.has(step.onRequest.label)).toBe(true);
    }
  });
});

/**
 * What the copied content claims about itself.
 *
 * The earlier wording called every string "the coach-approved wording", which
 * this repository cannot support: copying a document faithfully says nothing
 * about whether the programme has been validated with athletes. The claim is now
 * an exported value with limits in it, and the files may not quietly talk
 * themselves back up.
 *
 * TWO TESTS, TWO JOBS. The first pins CONTENT_AUTHORITY's wording, so the limits
 * cannot be quietly softened. The second is what stops the old overclaim coming
 * back into a comment -- the constant alone would not notice that. Do not delete
 * one believing the other covers it.
 */
describe('the content claims fidelity to the source, and nothing beyond it', () => {
  test('the authority record states the basis and the limits', () => {
    expect(CONTENT_AUTHORITY.basis).toBe(
      'Copied from the current source document, wording and order preserved.',
    );
    expect(CONTENT_AUTHORITY.fieldValidation).toBe('UNPROVEN');
    expect(CONTENT_AUTHORITY.codeDoesNotValidate).toContain('does not approve, validate or evaluate');
    expect(CONTENT_AUTHORITY.executableDeliveryModes).toEqual(['1 — Guided']);
    expect(CONTENT_AUTHORITY.sourceOnlyDeliveryModes).toEqual(['2 — Decision', '3 — Adaptive / Scored']);
  });

  test('no visualization file claims the content is approved, validated or proven', () => {
    const here = __dirname;
    const files = [
      path.join(here, 'pf001Scenario.ts'),
      path.join(here, 'guidedSession.ts'),
      path.join(here, '../../../app/coach/visualization/page.tsx'),
    ];

    // Narrow and explicit: these are authority claims, not prose style.
    //
    // Only POSITIVE claims are forbidden. An earlier form of this test banned
    // the word sequence "validated in the field", which the disclaimer in
    // pf001Scenario.ts has to use to deny it -- it passed only because a line
    // wrap happened to split the phrase, so reflowing a comment would have
    // reddened the sentence that exists to prevent the overclaim. Sentences
    // carrying a denial are dropped before the check.
    // TWO CLASSES, because one filter cannot serve both.
    //
    // ANYWHERE: words with no legitimate use in these files, not even to deny.
    // The disclaimers are written without them, so their presence is the defect
    // -- and this is the class the old "coach-approved wording" claim belonged
    // to. It must NOT be denial-filtered: that claim sat in a sentence reading
    // "THIS FILE IS SOURCE CONTENT, NOT AUTHORING: every string below is the
    // coach-approved wording, and nothing here may be rewritten", so a
    // sentence-level denial filter swallowed it and the guard went quiet.
    // Caught by re-running the mutation after hardening the other class.
    const CLAIMS_ANYWHERE = [
      /coach-approved/i,
      /coach approved/i,
      /clinically/i,
      /evidence-based/i,
      /peer-reviewed/i,
      /scientifically/i,
      /endorsed by/i,
    ];

    // POSITIVE FRAME ONLY: "validated" and "proven" are words the disclaimer
    // needs in order to refuse the claim, so only an affirmative use is a
    // defect. An earlier form banned the sequence "validated in the field" and
    // passed only because a line wrap split it -- reflowing a comment would
    // have reddened the sentence that exists to prevent the overclaim.
    const CLAIMS_POSITIVE = [
      /\b(?:is|was|are|were|has been|have been) proven\b/i,
      /\b(?:is|was|are|were|has been|have been) validated\b/i,
    ];
    const DENIAL = /\b(?:not|never|no|nothing|unproven|does not|do not|cannot|without)\b/i;

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8').replace(/^\s*\*\s?/gm, ' ');
      for (const claim of CLAIMS_ANYWHERE) {
        expect(text).not.toMatch(claim);
      }

      const affirmative = text
        .split(/(?<=[.:;])\s+/)
        .filter((sentence) => !DENIAL.test(sentence))
        .join(' ');
      for (const claim of CLAIMS_POSITIVE) {
        expect(affirmative).not.toMatch(claim);
      }
    }
  });
});

describe('the authored order inside a round', () => {
  const segments = buildGuidedSession(PF001_RING_CUTTER);
  const round = PF001_RING_CUTTER.rounds[0];

  test('the action comes before the question, with the beat rule attached to it', () => {
    const action = segments.find((s) => s.key === 'discover-action')!;
    const question = segments.find((s) => s.key === 'discover-question')!;
    expect(segments.indexOf(action)).toBeLessThan(segments.indexOf(question));
    expect(action.body).toEqual([round.level1.opponentAction]);
    expect(action.note).toBe(SOURCE_EXCERPTS.beatRule);
    expect(question.body).toEqual([round.level1.coachAsks]);
  });

  test("the options are offered on request, behind the manual's rule, never in the body", () => {
    const question = segments.find((s) => s.key === 'discover-question')!;
    expect(question.items).toEqual([]);
    expect(question.body.join(' ')).not.toContain(round.level1.options[0]);
    expect(question.onRequest).not.toBeNull();
    expect(question.onRequest!.items).toEqual(round.level1.options);
    expect(question.onRequest!.rule).toBe(SOURCE_EXCERPTS.optionsRule);
    expect(question.onRequest!.ruleBullets).toEqual(MANUAL_DELIVERY_RULES.level1OptionsBullets);
    // Every round's options are gated the same way, not just the first.
    for (const key of ['discover-question', 'solve-question', 'adapt-question']) {
      expect(segments.find((s) => s.key === key)!.onRequest).not.toBeNull();
    }
  });

  test('the picture is built before the first round, and the debrief is last', () => {
    expect(segments[0].title).toBe('Before the Bell — Build the Opponent');
    expect(segments.findIndex((s) => s.key === 'debrief')).toBe(segments.length - 2);
    expect(segments[segments.length - 1].kind).toBe('complete');
    expect(segments.findIndex((s) => s.key === 'common-mistakes')).toBeLessThan(
      segments.findIndex((s) => s.kind === 'round-purpose'),
    );
  });

  test('each round says which round it is, in order', () => {
    expect([...new Set(segments.map((s) => s.phase))]).toEqual([
      'Before the bell',
      'Round 1 of 3 — DISCOVER',
      'Round 2 of 3 — SOLVE',
      'Round 3 of 3 — ADAPT',
      'Debrief',
    ]);
  });

  test('every word delivered comes from the scenario, and nothing authored for this level is dropped', () => {
    const delivered = segments.flatMap((s) => [
      ...s.body,
      ...s.items,
      ...(s.onRequest ? s.onRequest.items : []),
    ]);
    const authored = new Set<string>([
      ...PF001_RING_CUTTER.beforeTheBell,
      ...PF001_RING_CUTTER.keyVisualCues,
      ...PF001_RING_CUTTER.commonMistakes,
      ...PF001_RING_CUTTER.debriefQuestions,
      ...PF001_RING_CUTTER.rounds.flatMap((r) => [
        ...r.setup,
        r.level1.opponentAction,
        r.level1.coachAsks,
        ...r.level1.options,
        r.level1.coachGuidance,
        r.level1.continueTheFight,
        ...(r.cornerNote ? [r.cornerNote] : []),
      ]),
    ]);
    for (const line of delivered) expect(authored.has(line)).toBe(true);
    for (const line of authored) expect(delivered).toContain(line);
  });
});

describe('the lane stays inside visualization', () => {
  const dir = __dirname;
  const sources = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));

  test('the content and its order import nothing from drills, goals, video or SHADOW', () => {
    for (const source of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/drill|goal|shadow|video|calibration|assignment|progression/i);
      }
    }
  });

  test('no write path and no persistence live here', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(source).not.toMatch(/\binsert into\b|\bupdate \b|\bdelete from\b/i);
    }
  });
});
