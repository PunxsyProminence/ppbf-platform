import { DEFAULT_STEP_MINUTES, blocksFromTemplateSteps, contactStructure } from './sessionScriptAuthoring';

// The pure half of making a script from a template. The writes, and what an
// edit does to a delivered script, are in sessionScriptAuthoring.pg.test.ts.

const step = (overrides: Partial<Parameters<typeof blocksFromTemplateSteps>[1][number]> = {}) => ({
  block: 'technical',
  drill_id: 'drl-1',
  free_text_drill: null,
  head_drill_name: 'Jab Drill',
  scale_level: null,
  duration_minutes: 4,
  rep_count: null,
  contact_level: 'none' as const,
  coach_note: null,
  ...overrides,
});

describe('blocksFromTemplateSteps', () => {
  it('runs each block on from the one before, in the order given', () => {
    const blocks = blocksFromTemplateSteps('T', [
      step({ duration_minutes: 4 }),
      step({ duration_minutes: null }),
      step({ duration_minutes: 12 }),
    ]);

    expect(blocks.map((block) => [block.block_order, block.start_offset_min, block.end_offset_min])).toEqual([
      [1, 0, 4],
      [2, 4, 4 + DEFAULT_STEP_MINUTES],
      [3, 4 + DEFAULT_STEP_MINUTES, 16 + DEFAULT_STEP_MINUTES],
    ]);
  });

  it('always gives a block a title and some text, which the table requires of both', () => {
    const [named, typed, bare] = blocksFromTemplateSteps('Friday plan', [
      step({ coach_note: ' Chin down. ', rep_count: 8 }),
      step({ drill_id: null, head_drill_name: null, free_text_drill: 'Rope', block: ' ' }),
      step({ drill_id: null, head_drill_name: null, free_text_drill: '  ', block: '' }),
    ]);

    // In words, and said to be the template's (F-078), never a bare section code under "Explain".
    expect(named).toMatchObject({ block_label: 'Jab Drill', what_to_say: 'Chin down.', what_to_explain: 'From the template: Technical, 8 reps', block_kind: 'drill_round' });
    expect(typed).toMatchObject({ block_label: 'Rope', what_to_say: null, what_to_explain: 'From the template: Friday plan', block_kind: 'instruction' });
    expect(bare.block_label).toBe('Step 3');
  });
});

describe('contactStructure', () => {
  const of = (...levels: string[]) => contactStructure(levels.map((contact_level) => ({ contact_level })) as never);

  it('reads the session label off the steps, and never calls a session with contact non-contact', () => {
    expect(of('none', 'none')).toBe('non_contact');
    expect(of('light_technical', 'open_sparring')).toBe('contact');
    expect(of('none', 'none', 'conditioned')).toBe('split_non_contact_then_contact');
    expect(of('conditioned', 'none')).toBe('contact');
    expect(of('none', 'conditioned', 'none')).toBe('contact');
  });
});
