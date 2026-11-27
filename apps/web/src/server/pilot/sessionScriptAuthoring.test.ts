import fs from 'node:fs';
import path from 'node:path';

import { readCsv } from './contentImport/csv';
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

// Each call is the next step: its own item id and ordinal, nested inside nothing.
let stepCount = 0;
const step = (overrides: Partial<Parameters<typeof blocksFromTemplateSteps>[1][number]> = {}) => ({
  item_id: `wti_${(stepCount += 1)}`,
  ordinal: stepCount,
  details: {},
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
  it('runs each block on from the one before, in ordinal order when no step sits inside another', () => {
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

// ---------------------------------------------------------------------------
// TL-ORD-2 (lane W4-8; App Overwatch on #2205, comment 7181958209). A plan made
// from a template runs its steps in the order a workout issued from it does
// (issueOrder): a step an owner placed inside another, in details.within_item_id,
// comes straight after it. With no minutes of its own it adds none and runs inside
// its parent's time (D-PK73-3: "no Long Road minutes change"); with its own whole
// minutes it keeps them, as today.
// ---------------------------------------------------------------------------

const windows = (blocks: ReturnType<typeof blocksFromTemplateSteps>) =>
  blocks.map((block) => [block.block_order, block.block_label, block.start_offset_min, block.end_offset_min]);

describe('a step an owner placed inside another (TL-ORD-2)', () => {
  it('comes straight after the step it sits inside and, stating no minutes, runs inside its minutes and adds none', () => {
    const blocks = blocksFromTemplateSteps('T', [
      step({ item_id: 'warm', ordinal: 1, drill_name: 'Warm-up', duration_minutes: 15 }),
      step({ item_id: 'main', ordinal: 2, drill_name: 'Main set', duration_minutes: null }),
      step({ item_id: 'cool', ordinal: 3, drill_name: 'Cool-down', duration_minutes: 8 }),
      step({ item_id: 'check', ordinal: 4, drill_name: 'Fresh check', duration_minutes: null, details: { within_item_id: 'warm' } }),
    ]);

    expect(windows(blocks)).toEqual([
      [1, 'Warm-up', 0, 15],
      [2, 'Fresh check', 0, 15],
      [3, 'Main set', 15, 15 + DEFAULT_STEP_MINUTES],
      [4, 'Cool-down', 15 + DEFAULT_STEP_MINUTES, 23 + DEFAULT_STEP_MINUTES],
    ]);
  });

  it('keeps its own minutes when it states them, and a step inside it with none runs inside those', () => {
    const blocks = blocksFromTemplateSteps('T', [
      step({ item_id: 'p', ordinal: 1, drill_name: 'Parent', duration_minutes: 10 }),
      step({ item_id: 'next', ordinal: 2, drill_name: 'Next', duration_minutes: 4 }),
      step({ item_id: 'own', ordinal: 3, drill_name: 'Own minutes', duration_minutes: 3, details: { within_item_id: 'p' } }),
      step({ item_id: 'none', ordinal: 4, drill_name: 'No minutes', duration_minutes: null, details: { within_item_id: 'p' } }),
      step({ item_id: 'deep', ordinal: 5, drill_name: 'Inside own', duration_minutes: null, details: { within_item_id: 'own' } }),
    ]);

    expect(windows(blocks)).toEqual([
      [1, 'Parent', 0, 10],
      [2, 'Own minutes', 10, 13],
      [3, 'Inside own', 10, 13],
      [4, 'No minutes', 0, 10],
      [5, 'Next', 13, 17],
    ]);
  });

  it('a link issueOrder does not follow leaves the step at its ordinal, timed as any step', () => {
    const blocks = blocksFromTemplateSteps('T', [
      step({ item_id: 'a', ordinal: 1, drill_name: 'A', duration_minutes: 4 }),
      step({ item_id: 'b', ordinal: 2, drill_name: 'Missing parent', duration_minutes: null, details: { within_item_id: 'wti_missing' } }),
      step({ item_id: 'c', ordinal: 3, drill_name: 'Itself', duration_minutes: null, details: { within_item_id: 'c' } }),
      step({ item_id: 'd', ordinal: 4, drill_name: 'Loop d', duration_minutes: null, details: { within_item_id: 'e' } }),
      step({ item_id: 'e', ordinal: 5, drill_name: 'Loop e', duration_minutes: null, details: { within_item_id: 'd' } }),
    ]);

    const D = DEFAULT_STEP_MINUTES;
    expect(windows(blocks)).toEqual([
      [1, 'A', 0, 4],
      [2, 'Missing parent', 4, 4 + D],
      [3, 'Itself', 4 + D, 4 + 2 * D],
      [4, 'Loop d', 4 + 2 * D, 4 + 3 * D],
      [5, 'Loop e', 4 + 3 * D, 4 + 4 * D],
    ]);
  });
});

const SEED_ITEMS = path.resolve(__dirname, '../../../seed-data/workout-templates/seed_workout_template_items.csv');
const CONDITIONING_A = 'wtp_01de3f48606d4c'; // Conditioning session A — SIT, 45 min

/** The committed template steps, read with the content import's own CSV reader. */
function committedSteps(): (Parameters<typeof blocksFromTemplateSteps>[1][number] & { template_id: string })[] {
  const table = readCsv(fs.readFileSync(SEED_ITEMS, 'utf8'));
  expect(table.problems).toEqual([]);
  const at = (name: string) => table.header.indexOf(name);
  const orNull = (cell: string) => (cell === '' ? null : cell);
  return table.records.map(({ cells }) => ({
    template_id: cells[at('template_id')],
    item_id: cells[at('item_id')],
    ordinal: Number(cells[at('ordinal')]),
    details: cells[at('details')] ? (JSON.parse(cells[at('details')]) as Record<string, unknown>) : {},
    block: cells[at('block')],
    drill_id: orNull(cells[at('drill_id')]),
    free_text_drill: orNull(cells[at('free_text_drill')]),
    drill_name: null,
    scale_level: orNull(cells[at('scale_level')]) as never,
    duration_minutes: cells[at('duration_minutes')] === '' ? null : Number(cells[at('duration_minutes')]),
    rep_count: cells[at('rep_count')] === '' ? null : Number(cells[at('rep_count')]),
    contact_level: cells[at('contact_level')] as never,
    coach_note: orNull(cells[at('coach_note')]),
  }));
}

describe('the committed templates as plans (TL-ORD-2)', () => {
  it("Conditioning session A lists the owner's checks where D-PK73-3 put them, inside their parents' minutes", () => {
    const steps = committedSteps().filter((row) => row.template_id === CONDITIONING_A);
    // The owner's placement, as the seed holds it: the fresh check inside the warm-up, the after check
    // inside the main set, neither with minutes of its own.
    const byOrdinal = new Map(steps.map((row) => [row.ordinal, row]));
    expect(byOrdinal.get(5)).toMatchObject({ duration_minutes: null, details: { within_item_id: byOrdinal.get(1)?.item_id } });
    expect(byOrdinal.get(6)).toMatchObject({ duration_minutes: null, details: { within_item_id: byOrdinal.get(2)?.item_id } });
    expect([1, 2, 3, 4].map((ordinal) => byOrdinal.get(ordinal)?.duration_minutes)).toEqual([15, null, 8, null]);

    const ordinalOf = new Map(steps.map((row) => [row.drill_id, row.ordinal]));
    const blocks = blocksFromTemplateSteps('Conditioning session A', steps);

    const D = DEFAULT_STEP_MINUTES;
    expect(blocks.map((block) => [ordinalOf.get(block.drill_id), block.start_offset_min, block.end_offset_min])).toEqual([
      [1, 0, 15], // warm-up
      [5, 0, 15], // fresh technical check, "at the end of the warm-up"
      [2, 15, 15 + D], // main set
      [6, 15, 15 + D], // same technical check, "straight after the main set"
      [3, 15 + D, 23 + D], // cool-down
      [4, 23 + D, 23 + 2 * D], // record
    ]);
    // The checks add no minutes: the plan runs as long as its four other steps.
    expect(Math.max(...blocks.map((block) => block.end_offset_min))).toBe(15 + D + 8 + D);
  });

  it('every committed template with no nested step builds as before: ordinal order, each block on from the one before', () => {
    const byTemplate = new Map<string, ReturnType<typeof committedSteps>>();
    for (const row of committedSteps()) byTemplate.set(row.template_id, [...(byTemplate.get(row.template_id) ?? []), row]);
    let plain = 0;
    for (const [templateId, steps] of byTemplate) {
      if (steps.some((row) => typeof row.details?.within_item_id === 'string')) continue;
      plain += 1;
      let at = 0;
      const before = [...steps].sort((a, b) => a.ordinal - b.ordinal).map((row) => {
        const start = at;
        at += row.duration_minutes ?? DEFAULT_STEP_MINUTES;
        return [row.drill_id, row.contact_level, start, at];
      });
      const blocks = blocksFromTemplateSteps('T', steps);
      expect({ templateId, blocks: blocks.map((block) => [block.drill_id, block.contact_level, block.start_offset_min, block.end_offset_min]) })
        .toEqual({ templateId, blocks: before });
    }
    // A count is not pinned, so a new template in the seed does not fail this case without a code fault.
    expect(plain).toBeGreaterThan(0);
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
