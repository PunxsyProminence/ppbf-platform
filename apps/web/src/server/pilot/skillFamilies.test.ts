import fs from 'node:fs';
import path from 'node:path';

import {
  FAMILY_MEMBER_CODES,
  SKILL_FAMILY_IDS,
  SKILL_FAMILY_NAMES,
  SKILL_FAMILY_PREREQUISITES,
  UNMAPPED_SKILL_CODES,
  isSkillFamilyId,
  memberCodesForFamily,
  type SkillFamilyId,
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

describe('SKILL-02..SKILL-12 expand to the list Jason approved on 2026-10-05', () => {
  // Written out rather than derived, for the same reason as SKILL-01 above.
  // Approved as drafted, AskUserQuestion toolu_01MYKQUdWWwaWnpRAyXej5Cp.
  const APPROVED: Record<Exclude<SkillFamilyId, 'SKILL-01'>, string[]> = {
    'SKILL-02': ['SK-DIST-01', 'SK-DIST-02', 'SK-DIST-03', 'SK-JAB-01', 'SK-JAB-02', 'SK-JAB-03'],
    'SKILL-03': ['SK-CROSS-01', 'SK-CTR-01'],
    'SKILL-04': ['SK-HOOK-01', 'SK-HOOK-02'],
    'SKILL-05': ['SK-IN-01', 'SK-IN-02', 'SK-UPPER-01'],
    'SKILL-06': [
      'SK-CTR-02',
      'SK-DEF-01',
      'SK-DEF-02',
      'SK-DEF-03',
      'SK-DEF-04',
      'SK-DEF-05',
      'SK-DEF-06',
      'SK-DEF-07',
      'SK-DEF-08',
    ],
    'SKILL-07': [
      'SK-ANG-01',
      'SK-COMBO-03',
      'SK-FW-01',
      'SK-FW-02',
      'SK-FW-03',
      'SK-FW-04',
      'SK-FW-05',
      'SK-FW-06',
      'SK-OUT-01',
      'SK-TAC-02',
    ],
    'SKILL-08': ['SK-TAC-01', 'SK-TAC-04'],
    'SKILL-09': ['SK-FEINT-01', 'SK-RHY-01'],
    'SKILL-10': ['SK-BODY-01'],
    'SKILL-11': ['SK-BAG-01', 'SK-FW-07'],
    'SKILL-12': ['SK-FILM-01', 'SK-FILM-02', 'SK-SELF-01', 'SK-SPAR-04'],
  };

  it.each(Object.entries(APPROVED))('%s holds exactly its approved codes', (familyId, codes) => {
    expect([...memberCodesForFamily(familyId)].sort()).toEqual(codes);
  });

  it('leaves exactly the eighteen approved codes unmapped', () => {
    expect([...UNMAPPED_SKILL_CODES].sort()).toEqual([
      'SK-BAG-02',
      'SK-COMBO-01',
      'SK-COMBO-02',
      'SK-DRILL-01',
      'SK-HAND-01',
      'SK-PAD-01',
      'SK-PARTNER-01',
      'SK-RET-01',
      'SK-RET-02',
      'SK-REV-01',
      'SK-REV-02',
      'SK-SAFE-01',
      'SK-SAFE-02',
      'SK-SHADOW-01',
      'SK-SPAR-01',
      'SK-SPAR-02',
      'SK-SPAR-03',
      'SK-TAC-03',
    ]);
  });

  it('gives every family at least one drill in the shipped library', () => {
    // A family whose codes all exist but match no drill would show an empty
    // shelf, which is the failure memberCodesForFamily refuses to produce.
    const seeded = new Set(SEEDED_CODES);
    for (const id of SKILL_FAMILY_IDS) {
      expect(memberCodesForFamily(id).some((code) => seeded.has(code))).toBe(true);
    }
  });
});

describe('a new skill code is added by one line, and cannot arrive silently', () => {
  // Jason's condition on the 2026-10-05 approval: "we ill need to make sure we
  // can add to as moreskills become available". The test above that accounts
  // for every seeded code is what makes adding safe; these pin that it works
  // in both directions for a code that does not exist yet.
  const unaccounted = (seeded: string[], crosswalk: Record<string, readonly string[]>, unmapped: readonly string[]) => {
    const known = new Set([...Object.values(crosswalk).flat(), ...unmapped]);
    return seeded.filter((code) => !known.has(code));
  };

  it('flags a new seed code that nobody has placed', () => {
    expect(unaccounted([...SEEDED_CODES, 'SK-NEW-01'], { ...FAMILY_MEMBER_CODES } as Record<string, readonly string[]>, UNMAPPED_SKILL_CODES))
      .toEqual(['SK-NEW-01']);
  });

  it('accepts it once it is added to a family list, and expands it', () => {
    const extended = {
      ...FAMILY_MEMBER_CODES,
      'SKILL-04': [...(FAMILY_MEMBER_CODES['SKILL-04'] ?? []), 'SK-NEW-01'],
    };
    expect(unaccounted([...SEEDED_CODES, 'SK-NEW-01'], extended as Record<string, readonly string[]>, UNMAPPED_SKILL_CODES))
      .toEqual([]);
    expect(memberCodesForFamily('SKILL-04', extended)).toContain('SK-NEW-01');
  });
});

describe('an unexpandable family refuses instead of returning nothing', () => {
  it('reconciles all twelve families today', () => {
    expect(SKILL_FAMILY_IDS.filter((id) => !FAMILY_MEMBER_CODES[id])).toEqual([]);
  });

  it('refuses a family that is real but has no crosswalk', () => {
    // THE CASE THAT MATTERS MOST. An empty array here would reach the caller as
    // an empty drill list, which reads as "this family has no drills" and is
    // false. No family is in this state today, so the guard is exercised
    // against a crosswalk with SKILL-07 withdrawn.
    const withoutSeven = { ...FAMILY_MEMBER_CODES };
    delete withoutSeven['SKILL-07'];
    expect(() => memberCodesForFamily('SKILL-07', withoutSeven)).toThrow(/no approved code crosswalk yet/);

    try {
      memberCodesForFamily('SKILL-07', withoutSeven);
      throw new Error('expected memberCodesForFamily to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('SKILL_FAMILY_NOT_RECONCILED');
      expect((error as { status?: number }).status).toBe(400);
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

describe('SKILL_FAMILY_PREREQUISITES', () => {
  /*
    Pinned to the Prerequisites column of the Skill_Index sheet in
    00_MASTER_SKILL_REGISTRY.xlsx, as read 2026-10-03 and confirmed by Jason
    as the D1-A source the same day. A change here is a change to which skill
    an athlete is told comes first, and must arrive as a deliberate edit to
    this table, not a side effect.
  */
  test('matches the registry, family by family', () => {
    expect(SKILL_FAMILY_PREREQUISITES).toEqual({
      'SKILL-01': { kind: 'families', families: [] },
      'SKILL-02': { kind: 'families', families: ['SKILL-01'] },
      'SKILL-03': { kind: 'families', families: ['SKILL-01', 'SKILL-02'] },
      'SKILL-04': { kind: 'families', families: ['SKILL-01'] },
      'SKILL-05': { kind: 'families', families: ['SKILL-01', 'SKILL-03', 'SKILL-04'] },
      'SKILL-06': { kind: 'families', families: ['SKILL-01'] },
      'SKILL-07': { kind: 'families', families: ['SKILL-01', 'SKILL-02'] },
      'SKILL-08': { kind: 'families', families: ['SKILL-01', 'SKILL-02'] },
      'SKILL-09': { kind: 'families', families: ['SKILL-02', 'SKILL-08'] },
      'SKILL-10': { kind: 'families', families: ['SKILL-01', 'SKILL-02', 'SKILL-03', 'SKILL-04', 'SKILL-05'] },
      'SKILL-11': { kind: 'across_all', registryText: 'core skills seeded' },
      'SKILL-12': { kind: 'across_all', registryText: 'registry + film inputs' },
    });
  });

  test('every family has an entry and no family needs itself', () => {
    for (const id of SKILL_FAMILY_IDS) {
      const entry = SKILL_FAMILY_PREREQUISITES[id];
      expect(entry).toBeDefined();
      if (entry.kind === 'families') {
        expect(entry.families).not.toContain(id);
        for (const p of entry.families) expect(isSkillFamilyId(p)).toBe(true);
      }
    }
  });
});
