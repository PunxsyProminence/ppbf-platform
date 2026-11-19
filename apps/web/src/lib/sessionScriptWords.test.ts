import {
  FROM_TEMPLATE,
  authoringStateWords,
  blockCoachingLines,
  blockNeedsDrillText,
  explainLine,
  templateSectionWords,
  type LinkedDrillText,
} from './sessionScriptWords';

// Plain words for a session script's stored codes (audit finding F-078).

describe('authoringStateWords', () => {
  it.each([
    ['draft', 'Draft'],
    ['coach_reviewed', 'Coach reviewed'],
    ['in_use', 'In use'],
    ['retired', 'Retired'],
    ['some_new_state', 'Some new state'],
  ])('%s reads as %s', (state, words) => {
    expect(authoringStateWords(state)).toBe(words);
  });
});

describe('templateSectionWords', () => {
  it.each([
    ['warmup', 'Warm-up'],
    ['warm-up', 'Warm-up'],
    ['warm_up', 'Warm-up'],
    [' Warm Up ', 'Warm-up'],
    ['cooldown', 'Cool-down'],
    ['technical', 'Technical'],
    ['skill_work', 'Skill work'],
    ['bag-work', 'Bag-work'],
  ])('%s reads as %s', (section, words) => {
    expect(templateSectionWords(section)).toBe(words);
  });
});

describe('explainLine', () => {
  it('labels a line the template step wrote as the template\'s, under both wordings', () => {
    expect(explainLine(`${FROM_TEMPLATE}Warm-up, 3 reps`)).toEqual({ label: 'From the template', value: 'Warm-up, 3 reps' });
    expect(explainLine('From workout template: Friday plan')).toEqual({ label: 'From the template', value: 'Friday plan' });
  });

  it('shows a bare section code stored before F-078 in words, with or without its reps', () => {
    expect(explainLine('warmup')).toEqual({ label: 'Explain', value: 'Warm-up' });
    expect(explainLine('skill_work - 8 reps')).toEqual({ label: 'Explain', value: 'Skill work, 8 reps' });
    expect(explainLine('warm-up - 3 reps')).toEqual({ label: 'Explain', value: 'Warm-up, 3 reps' });
  });

  it("leaves a coach's own explanation exactly as written", () => {
    for (const text of ['Keep the chin down and turn the hip.', 'Footwork first', 'Slip, then counter - 3 reps max', 'keep your chin down', 'jab - 3 reps then slip']) {
      expect(explainLine(text)).toEqual({ label: 'Explain', value: text });
    }
  });
});

// Lane U2-6e (Overwatch option A and Q2 = A, 2026-11-19): a plan line left empty shows the
// linked drill's text, labelled "From the drill", with the drill field's draft state.
describe('blockCoachingLines', () => {
  const EMPTY = { what_to_say: null, what_to_explain: null, what_to_watch: null, what_to_fix: null };
  const DRILL: LinkedDrillText = {
    state: 'loaded',
    cues: ['Eyes up', 'Snap it back'],
    good: 'Hand comes straight back.\nChin stays down.',
    bad: 'Reaching.',
    corrections: 'Elbow in before the next one.',
    drafts: { cues: true, good: false, bad: null, corrections: true },
  };
  const words = (lines: ReturnType<typeof blockCoachingLines>) => lines.map((line) => `${line.label}: ${line.value}`);

  it('falls back to the drill on every empty line: cues, good then bad as a second line, corrections', () => {
    expect(words(blockCoachingLines(EMPTY, DRILL))).toEqual([
      'Say (From the drill): Eyes up · Snap it back',
      'Explain: Not written yet',
      'Watch (From the drill): Hand comes straight back. · Chin stays down.',
      'What to avoid (From the drill): Reaching.',
      'Fix (From the drill): Elbow in before the next one.',
    ]);
  });

  it("carries each drill field's own draft state, and only on drill lines", () => {
    const lines = blockCoachingLines(EMPTY, DRILL);
    expect(lines.map((line) => [line.fromDrill, line.draft])).toEqual([
      [true, true],
      [false, undefined],
      [true, false],
      [true, null],
      [true, true],
    ]);
  });

  it("a line the plan wrote is shown as written, never the drill's text", () => {
    const own = { what_to_say: 'Breathe out on the punch.', what_to_explain: null, what_to_watch: 'Feet set.', what_to_fix: 'Turn the hip.' };
    const lines = blockCoachingLines(own, DRILL);
    expect(words(lines)).toEqual([
      'Say: Breathe out on the punch.',
      'Explain: Not written yet',
      'Watch: Feet set.',
      'Fix: Turn the hip.',
    ]);
    expect(lines.every((line) => !line.fromDrill)).toBe(true);
  });

  it('a block with no linked drill says "Not written yet" on each empty line, as before', () => {
    expect(words(blockCoachingLines(EMPTY, null))).toEqual([
      'Say: Not written yet',
      'Explain: Not written yet',
      'Watch: Not written yet',
      'Fix: Not written yet',
    ]);
  });

  it("while the drill loads, and when it could not be read, the empty lines say so -- never blank", () => {
    expect(words(blockCoachingLines(EMPTY, { state: 'loading' }))).toEqual([
      "Say: Loading the drill's text...",
      'Explain: Not written yet',
      "Watch: Loading the drill's text...",
      "Fix: Loading the drill's text...",
    ]);
    expect(words(blockCoachingLines(EMPTY, { state: 'failed' }))).toEqual([
      "Say: Not written yet. The drill's text could not be loaded.",
      'Explain: Not written yet',
      "Watch: Not written yet. The drill's text could not be loaded.",
      "Fix: Not written yet. The drill's text could not be loaded.",
    ]);
  });

  it('a drill field that is empty too says "Not written yet"; with no bad text there is no second Watch line', () => {
    const bare: LinkedDrillText = { ...DRILL, cues: [' '], good: '', bad: '', corrections: '  ' };
    expect(words(blockCoachingLines(EMPTY, bare))).toEqual([
      'Say: Not written yet',
      'Explain: Not written yet',
      'Watch: Not written yet',
      'Fix: Not written yet',
    ]);
    const badOnly: LinkedDrillText = { ...DRILL, good: '' };
    expect(words(blockCoachingLines({ ...EMPTY, what_to_say: 'x', what_to_fix: 'y' }, badOnly))).toEqual([
      'Say: x',
      'Explain: Not written yet',
      'Watch: Not written yet',
      'What to avoid (From the drill): Reaching.',
      'Fix: y',
    ]);
  });

  it('the Explain line is unchanged: the template wording still reads as the template\'s', () => {
    const lines = blockCoachingLines({ ...EMPTY, what_to_explain: `${FROM_TEMPLATE}Warm-up, 3 reps` }, DRILL);
    expect(lines[1]).toEqual({ label: 'From the template', value: 'Warm-up, 3 reps', fromDrill: false });
  });
});

describe('blockNeedsDrillText', () => {
  it('reads the drill only for a linked block with an empty Say, Watch or Fix line', () => {
    const filled = { what_to_say: 'a', what_to_explain: null, what_to_watch: 'b', what_to_fix: 'c', drill_id: 'drl-1' };
    expect(blockNeedsDrillText(filled)).toBe(false);
    expect(blockNeedsDrillText({ ...filled, what_to_fix: ' ' })).toBe(true);
    expect(blockNeedsDrillText({ ...filled, what_to_say: null })).toBe(true);
    expect(blockNeedsDrillText({ ...filled, what_to_watch: null, drill_id: null })).toBe(false);
  });
});
