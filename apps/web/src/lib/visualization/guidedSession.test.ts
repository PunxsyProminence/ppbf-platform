import fs from 'node:fs';
import path from 'node:path';

import { buildGuidedSession, type DeliveryLevel } from './guidedSession';
import { MANUAL_DELIVERY_RULES, PF001_RING_CUTTER, VISUALIZATION_CONTENT_SOURCE } from './pf001Scenario';

/**
 * The authored content, the manual's delivery rules and the order are the
 * product here, so all three are pinned against the source document rather than
 * against themselves.
 *
 * THE ORDERS ARE SPELLED OUT AS LITERALS BELOW. That is the point: if someone
 * reorders buildGuidedSession -- moves the debrief before Round 3, asks the
 * question before the opponent acts, turns the three levels back into steps of
 * one exposure -- these tests fail, because the expectation does not come from
 * the code under test.
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

  test('no scoring vocabulary rides along in the content', () => {
    const everyString = JSON.stringify({ PF001_RING_CUTTER, MANUAL_DELIVERY_RULES }).toLowerCase();
    for (const word of ['scorecard', 'mastery', 'pass/fail', 'points', 'grade']) {
      expect(everyString).not.toContain(word);
    }
  });
});

describe('a level is a way to run the whole scenario, not a step inside one', () => {
  test('Level 1 — Guided: the opponent acts, then the question, and the options are not in the script', () => {
    expect(buildGuidedSession(PF001_RING_CUTTER, 1).map((s) => s.key)).toEqual([
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

  test('Level 2 — Decision: reduced cues only, no fed answer and no options anywhere', () => {
    const segments = buildGuidedSession(PF001_RING_CUTTER, 2);
    expect(segments.map((s) => s.key)).toEqual([
      'before-the-bell',
      'key-visual-cues',
      'common-mistakes',
      'discover-purpose',
      'discover-reduced-cues',
      'discover-corner',
      'solve-purpose',
      'solve-reduced-cues',
      'solve-corner',
      'adapt-purpose',
      'adapt-reduced-cues',
      'debrief',
      'complete',
    ]);
    expect(segments.some((s) => s.onRequest)).toBe(false);
    const delivered = segments.flatMap((s) => [...s.body, ...s.items]).join(' ');
    for (const round of PF001_RING_CUTTER.rounds) {
      for (const option of round.level1.options) {
        expect(delivered).not.toContain(option);
      }
      expect(delivered).not.toContain(round.level1.coachGuidance);
    }
  });

  test('Level 3 — Adaptive: cue-only, carrying the rule that a cue is not an instruction', () => {
    const segments = buildGuidedSession(PF001_RING_CUTTER, 3);
    expect(segments.map((s) => s.key)).toEqual([
      'before-the-bell',
      'key-visual-cues',
      'common-mistakes',
      'discover-purpose',
      'discover-cue-only',
      'discover-corner',
      'solve-purpose',
      'solve-cue-only',
      'solve-corner',
      'adapt-purpose',
      'adapt-cue-only',
      'debrief',
      'complete',
    ]);
    const cueOnly = segments.filter((s) => s.kind === 'cue-only');
    expect(cueOnly).toHaveLength(3);
    for (const step of cueOnly) {
      expect(step.note).toBe(MANUAL_DELIVERY_RULES.level3Note);
    }
    expect(segments.some((s) => s.onRequest)).toBe(false);
  });

  test('no level walks another level: one exposure is delivered one way', () => {
    for (const level of [1, 2, 3] as DeliveryLevel[]) {
      const kinds = buildGuidedSession(PF001_RING_CUTTER, level).map((s) => s.kind);
      const perRoundKinds = kinds.filter((kind) =>
        ['opponent-action', 'coach-question', 'coach-guidance', 'continue', 'reduced-cues', 'cue-only'].includes(kind),
      );
      const distinct = [...new Set(perRoundKinds)];
      if (level === 1) {
        expect(distinct).toEqual(['opponent-action', 'coach-question', 'coach-guidance', 'continue']);
      }
      if (level === 2) expect(distinct).toEqual(['reduced-cues']);
      if (level === 3) expect(distinct).toEqual(['cue-only']);
    }
  });
});

describe('the authored order inside a Level 1 round', () => {
  const segments = buildGuidedSession(PF001_RING_CUTTER, 1);
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
