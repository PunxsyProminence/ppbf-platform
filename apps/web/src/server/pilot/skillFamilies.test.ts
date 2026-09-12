import fs from 'node:fs';
import path from 'node:path';

import {
  FAMILY_MEMBER_CODES,
  SKILL_FAMILY_IDS,
  SKILL_FAMILY_NAMES,
  UNMAPPED_SKILL_CODES,
  isSkillFamilyId,
  memberCodesForFamily,
} from './skillFamilies';

/*
  The crosswalk in skillFamilies.ts is static authority. Static authority drifts
  from the data it describes unless something holds the two together, and the
  data here is a CSV that a content pass edits -- so the failure mode is a new
  skill code arriving in the library with no family decision attached to it,
  silently.

  This is a SOURCE-LEVEL test on purpose: it reads the shipped seed CSV and
  needs no database, so it runs in the fast suite rather than behind the pg
  chain. drillSeedPrerequisite.test.ts ties the same CSV to its migration the
  same way and for the same reason.
*/

const SEED_CSV = path.resolve(
  __dirname,
  '../../../seed-data/drill-library/seed_drill_library.csv',
);

/**
 * RFC4180, not split('\n').
 *
 * seed_drill_library.csv is 1342 PHYSICAL LINES and 119 RECORDS -- quoted
 * fields carry embedded newlines throughout. A line-based reader does not
 * merely miscount here, it manufactures skill_id values out of the middle of
 * prose fields, which would fail this suite for a reason that does not exist.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function seededSkillCodes(): string[] {
  const rows = parseCsv(fs.readFileSync(SEED_CSV, 'utf8'));
  const header = rows[0];
  const skillIdColumn = header.indexOf('skill_id');
  const drillIdColumn = header.indexOf('drill_id');

  if (skillIdColumn === -1 || drillIdColumn === -1) {
    throw new Error('seed_drill_library.csv is missing skill_id or drill_id -- this parser needs updating');
  }

  const codes = rows
    .slice(1)
    .filter((r) => r.length >= header.length && r[drillIdColumn] !== '')
    .map((r) => r[skillIdColumn].trim())
    .filter((code) => code !== '');

  return Array.from(new Set(codes)).sort();
}

const SEEDED_CODES = seededSkillCodes();
const MAPPED_CODES = Object.values(FAMILY_MEMBER_CODES).flatMap((codes) => [...(codes ?? [])]);

describe('the seed library and the crosswalk describe the same vocabulary', () => {
  it('finds skill codes in the CSV at all, so the cases below cannot pass vacuously', () => {
    // A broken parser returning [] would satisfy every "is mapped or unmapped"
    // assertion below by having nothing to check.
    expect(SEEDED_CODES.length).toBeGreaterThan(0);
    expect(SEEDED_CODES).toContain('SK-STANCE-01');
  });

  it('accounts for every seeded skill code as MAPPED or EXPLICITLY_UNMAPPED', () => {
    // THE POINT OF THIS FILE. A code added to the CSV lands on neither list and
    // fails here, which is the only thing standing between a content edit and a
    // skill code with no family decision behind it.
    const accounted = new Set([...MAPPED_CODES, ...UNMAPPED_SKILL_CODES]);
    const unaccounted = SEEDED_CODES.filter((code) => !accounted.has(code));

    expect(unaccounted).toEqual([]);
  });

  it('carries no crosswalk entry for a code the library does not use', () => {
    // The other direction. A code removed from the CSV, or a typo in either
    // list, leaves a stale entry that would otherwise sit here forever looking
    // authoritative.
    const seeded = new Set(SEEDED_CODES);
    const stale = [...MAPPED_CODES, ...UNMAPPED_SKILL_CODES].filter((code) => !seeded.has(code));

    expect(stale).toEqual([]);
  });

  it('never lists a code as both mapped and unmapped', () => {
    const unmapped = new Set(UNMAPPED_SKILL_CODES);
    expect(MAPPED_CODES.filter((code) => unmapped.has(code))).toEqual([]);
  });

  it('lists each code once', () => {
    expect(new Set(MAPPED_CODES).size).toBe(MAPPED_CODES.length);
    expect(new Set(UNMAPPED_SKILL_CODES).size).toBe(UNMAPPED_SKILL_CODES.length);
  });
});

describe('family ids and operational codes are separate namespaces', () => {
  it('stores no family id in the library skill_id column', () => {
    // D2-B, checked against the data rather than trusted. If a SKILL-* value
    // ever reaches a skill column, the two taxonomy levels have been mixed and
    // related_skill_id has silently become two questions.
    const familyShaped = SEEDED_CODES.filter((code) => /^SKILL-\d+$/i.test(code));
    expect(familyShaped).toEqual([]);
  });

  it('recognises exactly the twelve promoted families', () => {
    expect(SKILL_FAMILY_IDS).toHaveLength(12);
    expect(SKILL_FAMILY_IDS).toContain('SKILL-01');
    expect(SKILL_FAMILY_IDS).toContain('SKILL-12');
    expect(SKILL_FAMILY_NAMES['SKILL-01']).toBe('Stance / Guard / Reset');

    expect(isSkillFamilyId('SKILL-01')).toBe(true);
    expect(isSkillFamilyId('SK-STANCE-01')).toBe(false);
    expect(isSkillFamilyId('SKILL-13')).toBe(false);
  });
});

describe('SKILL-01 expands to exactly the approved six', () => {
  it('holds the owner-approved member set and nothing else', () => {
    // Written out rather than derived. Deriving the expectation from the map
    // would make this a comparison of one literal with itself.
    expect([...memberCodesForFamily('SKILL-01')].sort()).toEqual([
      'SK-GUARD-01',
      'SK-GUARD-02',
      'SK-STANCE-01',
      'SK-STANCE-02',
      'SK-STANCE-03',
      'SK-WT-01',
    ]);
  });

  it('excludes the two codes whose exclusion was a finding', () => {
    // SK-RET-01/02 share the word "reset" with SKILL-01 and mean something
    // else. Named here so a future reader does not "fix" the apparent gap.
    const members = memberCodesForFamily('SKILL-01');
    expect(members).not.toContain('SK-RET-01');
    expect(members).not.toContain('SK-RET-02');
  });

  it('covers fifteen drills in the shipped library', () => {
    const rows = parseCsv(fs.readFileSync(SEED_CSV, 'utf8'));
    const header = rows[0];
    const skillIdColumn = header.indexOf('skill_id');
    const drillIdColumn = header.indexOf('drill_id');
    const members = new Set(memberCodesForFamily('SKILL-01'));

    const drills = rows
      .slice(1)
      .filter((r) => r.length >= header.length && r[drillIdColumn] !== '')
      .filter((r) => members.has(r[skillIdColumn].trim()));

    expect(drills).toHaveLength(15);
  });
});

describe('an unexpandable family refuses instead of returning nothing', () => {
  it('refuses a family that is real but not yet reconciled', () => {
    // THE CASE THAT MATTERS MOST. An empty array here would reach the caller as
    // an empty drill list, which reads as "this family has no drills" and is
    // false. Every family except SKILL-01 is in this state today.
    expect(() => memberCodesForFamily('SKILL-07')).toThrow(/no approved code crosswalk yet/);

    try {
      memberCodesForFamily('SKILL-07');
      throw new Error('expected memberCodesForFamily to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('SKILL_FAMILY_NOT_RECONCILED');
      expect((error as { status?: number }).status).toBe(400);
    }
  });

  it('refuses every family that has no crosswalk, not just the one sampled above', () => {
    const unreconciled = SKILL_FAMILY_IDS.filter((id) => !FAMILY_MEMBER_CODES[id]);

    // Today that is eleven of twelve. Asserting the count keeps this honest if
    // a family is crosswalked later without this file being revisited.
    expect(unreconciled).toHaveLength(11);
    for (const id of unreconciled) {
      expect(() => memberCodesForFamily(id)).toThrow(/no approved code crosswalk yet/);
    }
  });

  it('refuses an id that is not a family at all, and says so differently', () => {
    // Distinct from the case above: "you named a non-family" is not the same
    // problem as "that family is not mapped yet", and a caller correcting the
    // request needs to know which one they hit.
    expect(() => memberCodesForFamily('SK-STANCE-01')).toThrow(/Unknown skill family/);

    try {
      memberCodesForFamily('SKILL-99');
      throw new Error('expected memberCodesForFamily to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('UNKNOWN_SKILL_FAMILY');
      expect((error as { status?: number }).status).toBe(400);
    }
  });
});
