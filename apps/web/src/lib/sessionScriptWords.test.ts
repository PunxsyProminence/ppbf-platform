import { FROM_TEMPLATE, authoringStateWords, explainLine, templateSectionWords } from './sessionScriptWords';

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
