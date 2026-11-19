import {
  NOT_WRITTEN_YET,
  equipmentLabel,
  executionSteps,
  humanizeContactLevel,
  isNotWritten,
  listItems,
  listItemsOrNotWritten,
  orNotWritten,
  scaleLevelName,
  setupAndEquipment,
} from './drillPresentation';

describe('humanizeContactLevel', () => {
  test.each([
    ['none', 'No contact'],
    ['light_technical', 'Light technical contact'],
    ['conditioned', 'Conditioned contact'],
    ['controlled_sparring', 'Controlled sparring'],
    ['open_sparring', 'Open sparring'],
  ])('%s reads as "%s"', (value, label) => {
    expect(humanizeContactLevel(value)).toBe(label);
  });

  test('an unknown value degrades readably instead of vanishing', () => {
    expect(humanizeContactLevel('full_contact')).toBe('Full contact');
    expect(humanizeContactLevel('')).toBe('Not stated');
    expect(humanizeContactLevel(null)).toBe('Not stated');
  });
});

describe('executionSteps', () => {
  test('blank-line-separated steps come back in order, each on one line', () => {
    expect(executionSteps('Step one.\n\nStep two,\ncontinued.\n\nStep three.')).toEqual([
      'Step one.',
      'Step two, continued.',
      'Step three.',
    ]);
  });

  test('single-line-separated steps are steps too', () => {
    expect(executionSteps('First\nSecond\nThird')).toEqual(['First', 'Second', 'Third']);
  });

  test('a paragraph with no line breaks stays ONE item: no invented sequence', () => {
    expect(executionSteps('Slip either side of the rope. Keep the eyes up. Return to guard.')).toEqual([
      'Slip either side of the rope. Keep the eyes up. Return to guard.',
    ]);
  });

  test('empty text has no steps', () => {
    expect(executionSteps('')).toEqual([]);
    expect(executionSteps('   ')).toEqual([]);
    expect(executionSteps(undefined)).toEqual([]);
  });
});

describe('listItems', () => {
  test('one item per non-empty line', () => {
    expect(listItems('A\n\n  B  \nC')).toEqual(['A', 'B', 'C']);
    expect(listItems('')).toEqual([]);
  });
});

describe('scaleLevelName', () => {
  test('names the level for what it does', () => {
    expect(scaleLevelName('A')).toBe('Easier (A)');
    expect(scaleLevelName('B')).toBe('Standard (B)');
    expect(scaleLevelName('C')).toBe('Harder (C)');
  });
});

describe('setupAndEquipment', () => {
  // The corpus case: 114 of 119 reference drills store the equipment word in
  // standard_setup too. It must read as equipment, never as setup.
  test('setup that IS the equipment value is shown as equipment, not as setup', () => {
    expect(setupAndEquipment('focus mitt', 'focus mitt')).toEqual({ setup: null, equipment: 'focus mitt' });
    // The equipment column is the authority on equipment, whatever the setup's casing.
    expect(setupAndEquipment('Heavy Bag', 'heavy bag')).toEqual({ setup: null, equipment: 'heavy bag' });
  });

  test('"none" means no equipment is needed, whichever column says it', () => {
    expect(setupAndEquipment('none', 'none')).toEqual({ setup: null, equipment: 'No equipment needed' });
    expect(setupAndEquipment('Partners at distance.', 'none')).toEqual({
      setup: 'Partners at distance.',
      equipment: 'No equipment needed',
    });
  });

  test('real setup prose stays setup, and distinct equipment is shown beside it', () => {
    expect(setupAndEquipment('Partners at technical distance.', 'focus mitts')).toEqual({
      setup: 'Partners at technical distance.',
      equipment: 'focus mitts',
    });
    // A blank equipment column means none is needed (OD-2026-10-08-008 D8).
    expect(setupAndEquipment('Use controlled partner touch.', '')).toEqual({
      setup: 'Use controlled partner touch.',
      equipment: 'No equipment needed',
    });
  });

  test('a "none" setup never hides real equipment', () => {
    expect(setupAndEquipment('none', 'focus mitt')).toEqual({ setup: null, equipment: 'focus mitt' });
  });

  test('an equipment-only setup with no equipment column is still not called setup', () => {
    // The athlete detail carries equipment too, but a blank one must not turn
    // a "none" setup back into setup instructions.
    expect(setupAndEquipment('none', '')).toEqual({ setup: null, equipment: 'No equipment needed' });
  });
});

describe('NOT_WRITTEN_YET helpers', () => {
  test('one wording', () => {
    expect(NOT_WRITTEN_YET).toBe('Not written yet');
  });
  test('empty, blank and missing text read as not written; filled text is unchanged', () => {
    for (const empty of ['', '   ', '\n', null, undefined]) {
      expect(isNotWritten(empty)).toBe(true);
      expect(orNotWritten(empty)).toBe('Not written yet');
      expect(listItemsOrNotWritten(empty)).toEqual(['Not written yet']);
    }
    expect(orNotWritten('Keep the chin down')).toBe('Keep the chin down');
    expect(orNotWritten('0')).toBe('0');
    expect(listItemsOrNotWritten('a\nb')).toEqual(['a', 'b']);
  });
});

describe('equipmentLabel', () => {
  test('reads "none" as none needed, and real equipment as itself', () => {
    expect(equipmentLabel('none')).toBe('No equipment needed');
    expect(equipmentLabel('gloves')).toBe('gloves');
  });

  // OD-2026-10-08-008 D8: "Treat blank as 'none needed' (Recommended)".
  test('reads blank equipment as none needed, never as nothing to say', () => {
    expect(equipmentLabel('')).toBe('No equipment needed');
    expect(equipmentLabel('   ')).toBe('No equipment needed');
    expect(equipmentLabel(null)).toBe('No equipment needed');
    expect(equipmentLabel(undefined)).toBe('No equipment needed');
    expect(setupAndEquipment('', '')).toEqual({ setup: null, equipment: 'No equipment needed' });
  });
});
