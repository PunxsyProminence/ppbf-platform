import {
  DEFAULT_STEP_MINUTES,
  SessionScriptAuthoringError,
  blocksFromTemplateSteps,
  contactStructure,
  contactStructureAfter,
  renderingFromBlocks,
  runningOrderAfter,
} from './sessionScriptAuthoring';

// The pure half of making a script from a template. The writes, and what an
// edit does to a delivered script, are in sessionScriptAuthoring.pg.test.ts.

const step = (overrides: Partial<Parameters<typeof blocksFromTemplateSteps>[1][number]> = {}) => ({
  block: 'technical',
  drill_id: 'drl-1',
  free_text_drill: null,
  drill_name: 'Jab Drill',
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
      step({ drill_id: null, drill_name: null, free_text_drill: 'Rope', block: ' ' }),
      step({ drill_id: null, drill_name: null, free_text_drill: '  ', block: '' }),
    ]);

    // In words, and said to be the template's (F-078), never a bare section code under "Explain".
    expect(named).toMatchObject({ block_label: 'Jab Drill', what_to_say: 'Chin down.', what_to_explain: 'From the template: Technical, 8 reps', block_kind: 'drill_round' });
    expect(typed).toMatchObject({ block_label: 'Rope', what_to_say: null, what_to_explain: 'From the template: Friday plan', block_kind: 'instruction' });
    expect(bare.block_label).toBe('Step 3');
  });

  it('titles a block with the name of the drill version it links, not a newer version renamed since (audit 2026-10-17 item 4)', () => {
    // The template detail read carries both names; the step still links v1.
    const [block] = blocksFromTemplateSteps('T', [
      { ...step({ drill_id: 'drill-v1', drill_name: 'Original drill' }), head_drill_name: 'Renamed drill v2' } as never,
    ]);

    expect(block).toMatchObject({ drill_id: 'drill-v1', block_label: 'Original drill' });
  });
});

describe('renderingFromBlocks', () => {
  const block = (overrides: Partial<Parameters<typeof renderingFromBlocks>[1][number]> = {}) => ({
    start_offset_min: 0,
    end_offset_min: 6,
    block_label: 'Jab Drill',
    what_to_say: null,
    what_to_explain: null,
    what_to_watch: null,
    what_to_fix: null,
    ...overrides,
  });

  it('writes the plan name, then each block in order with its minutes, title and the lines its author filled', () => {
    expect(
      renderingFromBlocks('Friday plan', [
        block({ what_to_say: ' Hands up. ', what_to_explain: 'From the template: Warm-up', what_to_watch: 'Elbows', what_to_fix: '  ' }),
        block({ start_offset_min: 6, end_offset_min: 16, block_label: 'Partner mirror', what_to_explain: 'Why the feet lead' }),
      ]),
    ).toBe(
      [
        'Friday plan',
        '',
        '0-6 min  Jab Drill',
        '  Say: Hands up.',
        '  From the template: Warm-up',
        '  Watch: Elbows',
        '  Fix: Not written yet',
        '',
        '6-16 min  Partner mirror',
        '  Say: Not written yet',
        '  Explain: Why the feet lead',
        '  Watch: Not written yet',
        '  Fix: Not written yet',
      ].join('\n'),
    );
  });

  it('says "Not written yet" for every line a block left empty, never dropping one', () => {
    expect(renderingFromBlocks('Empty plan', [block({ what_to_say: '   ' })])).toBe(
      [
        'Empty plan',
        '',
        '0-6 min  Jab Drill',
        '  Say: Not written yet',
        '  Explain: Not written yet',
        '  Watch: Not written yet',
        '  Fix: Not written yet',
      ].join('\n'),
    );
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

// Lane W4-5, SP-1a: the running order an edit leaves, and the contact label read from it.
describe('runningOrderAfter', () => {
  const STORED = ['b1', 'b2', 'b3'];
  const none = { edited: [], remove: [], refs: [] };
  const refusal = (change: Parameters<typeof runningOrderAfter>[1]) => {
    try {
      runningOrderAfter(STORED, change);
    } catch (error) {
      expect(error).toBeInstanceOf(SessionScriptAuthoringError);
      expect((error as SessionScriptAuthoringError).status).toBe(422);
      return (error as SessionScriptAuthoringError).message;
    }
    throw new Error('not refused');
  };

  it('without an order, keeps the stored order and puts new blocks last, in the order given', () => {
    expect(runningOrderAfter(STORED, none)).toEqual(STORED);
    expect(runningOrderAfter(STORED, { ...none, remove: ['b2'], refs: ['n1', 'n2'] })).toEqual(['b1', 'b3', 'n1', 'n2']);
  });

  it('with an order, takes it as given when it names every kept and new block once', () => {
    expect(runningOrderAfter(STORED, { ...none, order: ['b3', 'b1', 'b2'] })).toEqual(['b3', 'b1', 'b2']);
    expect(runningOrderAfter(STORED, { ...none, remove: ['b1'], refs: ['n1'], order: ['n1', 'b3', 'b2'] })).toEqual(['n1', 'b3', 'b2']);
  });

  it('refuses an order that leaves a block out, names one twice, names a removed one or an unknown one', () => {
    expect(refusal({ ...none, order: ['b1', 'b2'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
    expect(refusal({ ...none, order: ['b1', 'b2', 'b3', 'b3'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
    expect(refusal({ ...none, order: ['b1', 'b2', 'b2'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
    expect(refusal({ ...none, remove: ['b1'], order: ['b1', 'b2', 'b3'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
    expect(refusal({ ...none, order: ['b1', 'b2', 'b3', 'x'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
    expect(refusal({ ...none, refs: ['n1'], order: ['b1', 'b2', 'b3'] })).toBe('SESSION_SCRIPT_ORDER_INVALID');
  });

  it('refuses removing a block not in the plan, the same block twice, or one the same edit retitles', () => {
    expect(refusal({ ...none, remove: ['x'] })).toBe('SESSION_SCRIPT_BLOCK_NOT_IN_SCRIPT');
    expect(refusal({ ...none, remove: ['b1', 'b1'] })).toBe('SESSION_SCRIPT_BLOCK_REPEATED');
    expect(refusal({ ...none, edited: ['b2'], remove: ['b2'] })).toBe('SESSION_SCRIPT_BLOCK_REPEATED');
  });

  it("refuses a new block's ref that is blank, repeated, or the id of a stored block", () => {
    expect(refusal({ ...none, refs: [' '] })).toBe('SESSION_SCRIPT_BLOCK_REF_INVALID');
    expect(refusal({ ...none, refs: ['n1', 'n1'] })).toBe('SESSION_SCRIPT_BLOCK_REF_INVALID');
    expect(refusal({ ...none, refs: ['b2'] })).toBe('SESSION_SCRIPT_BLOCK_REF_INVALID');
  });

  it('allows an edit that leaves the plan with no blocks: an empty plan is kept and shown, and not started', () => {
    expect(runningOrderAfter(STORED, { ...none, remove: STORED })).toEqual([]);
    expect(runningOrderAfter([], { ...none, refs: ['n1'] })).toEqual(['n1']);
  });
});

describe('contactStructureAfter', () => {
  const blocks = (...levels: string[]) => levels.map((contact_level) => ({ contact_level }));

  it('raises the label when the blocks carry more contact than it says', () => {
    expect(contactStructureAfter('non_contact', blocks('none', 'controlled_sparring'))).toBe('split_non_contact_then_contact');
    expect(contactStructureAfter('split_non_contact_then_contact', blocks('controlled_sparring', 'none'))).toBe('contact');
    expect(contactStructureAfter('observation_only', blocks('controlled_sparring'))).toBe('contact');
  });

  it('never lowers it: an imported label over blank (none) blocks, and a label whose contact block was removed', () => {
    expect(contactStructureAfter('contact', blocks('none', 'none'))).toBe('contact');
    expect(contactStructureAfter('contact', blocks('none', 'controlled_sparring'))).toBe('contact');
    expect(contactStructureAfter('split_non_contact_then_contact', blocks('none'))).toBe('split_non_contact_then_contact');
    expect(contactStructureAfter('contact', [])).toBe('contact');
  });

  it("keeps an author's observation_only while no block has contact", () => {
    expect(contactStructureAfter('observation_only', blocks('none', 'none'))).toBe('observation_only');
    expect(contactStructureAfter('non_contact', blocks('none'))).toBe('non_contact');
  });
});
