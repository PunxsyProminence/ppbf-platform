import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  D8_BLANK_EQUIPMENT_IS_NONE,
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
    // A blank equipment column is unknown, not none (Jason 2026-11-19), unless the drill is a D8 drill.
    expect(setupAndEquipment('Use controlled partner touch.', '')).toEqual({
      setup: 'Use controlled partner touch.',
      equipment: 'Not written yet',
    });
    expect(setupAndEquipment('Use controlled partner touch.', '', 'drl_7f812fecacfee4')).toEqual({
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

describe('D8 drill ids match the committed seed', () => {
  // Without this a typo, or a re-versioned drill_id, would silently turn a D8 drill's
  // blank equipment into "Not written yet".
  test('the five ids are exactly the seed rows from the v3 source manual', () => {
    const csv = readFileSync(path.join(__dirname, '../../seed-data/drill-library/seed_drill_library.csv'), 'utf8');
    expect(csv.split('Punxsy_Drill_Library_Source_v3.docx').length - 1).toBe(5);
    for (const id of D8_BLANK_EQUIPMENT_IS_NONE) {
      expect(csv).toContain(`,${id},${id},1,`);
    }
  });
});

describe('equipmentLabel', () => {
  test('reads "none" as none needed, and real equipment as itself', () => {
    expect(equipmentLabel('none')).toBe('No equipment needed');
    expect(equipmentLabel('gloves')).toBe('gloves');
  });

  // Jason 2026-11-19, "A: Not written yet": a blank value is unknown, not "none".
  test('reads blank equipment as not written yet, never as none needed', () => {
    for (const blank of ['', '   ', null, undefined]) {
      expect(equipmentLabel(blank)).toBe('Not written yet');
      expect(equipmentLabel(blank, 'drl_9de5719225a39c')).toBe('Not written yet');
    }
    expect(setupAndEquipment('', '')).toEqual({ setup: null, equipment: 'Not written yet' });
  });

  test('a written "none" stays "No equipment needed", for any drill', () => {
    expect(equipmentLabel('none')).toBe('No equipment needed');
    expect(equipmentLabel(' None ', 'drl_9de5719225a39c')).toBe('No equipment needed');
  });

  // OD-2026-10-08-008 D8: blank equipment on the five source-manual drills means none needed.
  test('the five D8 drills keep "No equipment needed" when blank; a written value is unchanged', () => {
    expect(D8_BLANK_EQUIPMENT_IS_NONE.size).toBe(5);
    for (const id of D8_BLANK_EQUIPMENT_IS_NONE) {
      expect(equipmentLabel('', id)).toBe('No equipment needed');
      expect(equipmentLabel(null, id)).toBe('No equipment needed');
      expect(equipmentLabel('gloves', id)).toBe('gloves');
    }
    // A newer version of a D8 drill has a new drill_id and keeps the lineage_id.
    expect(equipmentLabel('', 'drl_newer_version', 'drl_7f812fecacfee4')).toBe('No equipment needed');
    expect(equipmentLabel('', 'drl_newer_version', 'drl_9de5719225a39c')).toBe('Not written yet');
    expect(setupAndEquipment('', '', 'drl_newer_version', 'drl_7f812fecacfee4')).toEqual({
      setup: null,
      equipment: 'No equipment needed',
    });
  });
});
