import { ValidationError } from './errors';

/*
  THE SKILL FAMILY CROSSWALK.

  TWO NAMESPACES, DELIBERATELY KEPT APART.

  SKILL-01..SKILL-12 are FAMILY identifiers. They come from the Punxsy
  Prominence skill taxonomy structure promoted to current authority by owner
  decision D1-A (2026-09-11), bounded to family ids, names, definitions,
  prerequisites, feeds-into, and primary-owner/secondary-skill relationship
  semantics. No legacy drill content, workout, programming or safety material
  was promoted with it.

  SK-* values are the OPERATIONAL codes this repository actually stores, in
  pilot.drill_library.skill_id and pilot.drill_secondary_skills.skill_id. They
  sit BELOW family level and the promoted taxonomy defines no tier for them.

  A FAMILY ID IS NEVER A COLUMN VALUE (owner decision D2-B). Neither skill
  column may hold SKILL-01..12, because a single column holding both levels
  makes `related_skill_id` mean two different questions with no way for a
  caller to say which one they are asking. Family membership is DERIVED here
  instead, and the expansion below is the only bridge between the two
  namespaces.

  NO ROW RESTATES A CROSSWALK (owner decision D2-C). A drill whose primary is
  SK-STANCE-01 is already in SKILL-01 by the map below; writing a secondary
  row to say so again would create a second source of truth that this file
  could silently drift from. Secondary rows exist only for relationships the
  primary does NOT imply.

  NO DATABASE ACCESS. This is static, version-controlled authority: a diff
  here is a taxonomy change and reviewable as one. skillFamilies.test.ts holds
  it to the shipped seed CSV so a code cannot appear in the library without
  someone deciding which family it belongs to.
*/

export type SkillFamilyId =
  | 'SKILL-01'
  | 'SKILL-02'
  | 'SKILL-03'
  | 'SKILL-04'
  | 'SKILL-05'
  | 'SKILL-06'
  | 'SKILL-07'
  | 'SKILL-08'
  | 'SKILL-09'
  | 'SKILL-10'
  | 'SKILL-11'
  | 'SKILL-12';

/** The promoted family vocabulary, verbatim from the authoritative Skill_Index. */
export const SKILL_FAMILY_NAMES: Readonly<Record<SkillFamilyId, string>> = {
  'SKILL-01': 'Stance / Guard / Reset',
  'SKILL-02': 'Jab System',
  'SKILL-03': 'Rear-Hand System',
  'SKILL-04': 'Hook System',
  'SKILL-05': 'Uppercut / Inside',
  'SKILL-06': 'Defense-to-Counter',
  'SKILL-07': 'Footwork / Ringcraft',
  'SKILL-08': 'Perception / Reaction',
  'SKILL-09': 'Feints / Traps',
  'SKILL-10': 'Body Attack',
  'SKILL-11': 'Skill Under Fatigue',
  'SKILL-12': 'Film-to-Drill Transfer',
};

export const SKILL_FAMILY_IDS: readonly SkillFamilyId[] = Object.keys(
  SKILL_FAMILY_NAMES,
) as SkillFamilyId[];

/**
 * Which families come before which -- the Prerequisites column of the
 * Skill_Index sheet in 00_MASTER_SKILL_REGISTRY.xlsx (SharePoint Club
 * Operations, .../LEGACY_PRO_BOXING_REFERENCE_ONLY/). Jason confirmed on
 * 2026-10-03 that this sheet is the prerequisite source D1-A promoted, despite
 * the folder name.
 *
 * TWO SHAPES, because the sheet has two. Ten families name other families and
 * are stored as ids. SKILL-11 and SKILL-12 do not: their cells read "core
 * skills seeded" and "registry + film inputs", and both families are layers
 * across all the others ("all skill families" in Shared_Territory). Turning
 * either cell into a list of ids would be inventing a prerequisite the
 * registry does not state, so the text is kept verbatim and the ordering
 * places those two families outside the sequence rather than guessing a step.
 */
export type SkillFamilyPrerequisites =
  | { kind: 'families'; families: readonly SkillFamilyId[] }
  | { kind: 'across_all'; registryText: string };

export const SKILL_FAMILY_PREREQUISITES: Readonly<Record<SkillFamilyId, SkillFamilyPrerequisites>> = {
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
};

/**
 * SKILL-01 Stance / Guard / Reset -- "Base, balance, guard recovery, reset
 * discipline", owning stance, guard and reset.
 *
 * These six codes and no others (owner decision D3-A). SK-STANCE-03 and
 * SK-WT-01 were approved at MEDIUM confidence: SK-STANCE-03 because the
 * promoted definition is silent on the adaptive/seated lane and no other
 * family claims it, SK-WT-01 because "balance" appears in SKILL-01's
 * definition and in no other family's, while "weight transfer" appears in no
 * family's owned territory at all. Both are the rows most likely to move.
 *
 * SK-RET-01 and SK-RET-02 are NOT here and their absence is a finding, not an
 * omission. SKILL-01's reset is the active, in-exchange return to a position
 * you can fight from; Between-Round Reset is a between-bout pause and
 * Instruction Under Fatigue is coachability. The word collides, the meaning
 * does not.
 */
const SKILL_01_MEMBER_CODES = [
  'SK-GUARD-01',
  'SK-GUARD-02',
  'SK-STANCE-01',
  'SK-STANCE-02',
  'SK-STANCE-03',
  'SK-WT-01',
] as const;

/**
 * SKILL-02..SKILL-12, approved by Jason on 2026-10-05 as drafted ("1 and we ill
 * need to make sure we can add to as moreskills become available";
 * AskUserQuestion toolu_01MYKQUdWWwaWnpRAyXej5Cp). Drafted from the Owned_Territory
 * and Purpose columns of the Skill_Index sheet. One family per code, because
 * athleteDrillExposure.ts files each drill under exactly one family.
 *
 * MEDIUM-confidence rows, the ones most likely to move: SK-DIST-* in SKILL-02
 * (its purpose names range and no family owns range), SK-CTR-01 in SKILL-03
 * (rear hand owns "counters"), SK-IN-* in SKILL-05 (inside position and exits
 * are held there for v2), SK-ANG-01 / SK-OUT-01 / SK-COMBO-03 / SK-TAC-02 in
 * SKILL-07, both SKILL-08 codes, and SK-SPAR-04 in SKILL-12.
 */
const SKILL_02_TO_12_MEMBER_CODES = {
  'SKILL-02': ['SK-JAB-01', 'SK-JAB-02', 'SK-JAB-03', 'SK-DIST-01', 'SK-DIST-02', 'SK-DIST-03'],
  'SKILL-03': ['SK-CROSS-01', 'SK-CTR-01'],
  'SKILL-04': ['SK-HOOK-01', 'SK-HOOK-02'],
  'SKILL-05': ['SK-UPPER-01', 'SK-IN-01', 'SK-IN-02'],
  'SKILL-06': [
    'SK-DEF-01',
    'SK-DEF-02',
    'SK-DEF-03',
    'SK-DEF-04',
    'SK-DEF-05',
    'SK-DEF-06',
    'SK-DEF-07',
    'SK-DEF-08',
    'SK-CTR-02',
  ],
  'SKILL-07': [
    'SK-FW-01',
    'SK-FW-02',
    'SK-FW-03',
    'SK-FW-04',
    'SK-FW-05',
    'SK-FW-06',
    'SK-ANG-01',
    'SK-OUT-01',
    'SK-COMBO-03',
    'SK-TAC-02',
  ],
  'SKILL-08': ['SK-TAC-01', 'SK-TAC-04'],
  'SKILL-09': ['SK-FEINT-01', 'SK-RHY-01'],
  'SKILL-10': ['SK-BODY-01'],
  'SKILL-11': ['SK-FW-07', 'SK-BAG-01'],
  'SKILL-12': ['SK-FILM-01', 'SK-FILM-02', 'SK-SELF-01', 'SK-SPAR-04'],
} as const satisfies Partial<Record<SkillFamilyId, readonly string[]>>;

/**
 * Family -> member codes. Every family is reconciled as of 2026-10-05.
 *
 * ADDING A SKILL CODE. A new SK-* code in the seed CSV fails
 * skillFamilies.test.ts until it is either added to one family's list above or
 * named in UNMAPPED_SKILL_CODES below; that one-line change is the whole job,
 * and the diff is the reviewable taxonomy decision. Moving a code between
 * families is the same one-line change.
 *
 * Typed Partial on purpose: memberCodesForFamily keeps refusing a family that
 * has no list, so removing one later cannot turn into an empty drill shelf.
 */
export const FAMILY_MEMBER_CODES: Readonly<Partial<Record<SkillFamilyId, readonly string[]>>> = {
  'SKILL-01': SKILL_01_MEMBER_CODES,
  ...SKILL_02_TO_12_MEMBER_CODES,
};

/**
 * Codes the shipped drill library carries that no family owns.
 *
 * This list is not documentation. It is the reason a NEW code cannot enter the
 * seed CSV unnoticed: skillFamilies.test.ts requires every non-empty skill_id
 * in the CSV to be either mapped above or named here, so an unrecognised value
 * fails rather than defaulting into "unmapped" by silence.
 *
 * Approved to stay unmapped with the 2026-10-05 crosswalk: training formats
 * (pads, bag purpose, shadow, partner contract, constraint swap, sparring),
 * safety drills, between-round reset and instruction under fatigue (see the
 * SKILL-01 note), mental rehearsal, plan-and-adjust, and hand wrapping. Being
 * here means "no family owns it today", and a code can leave this list for a
 * family by the same one-line change.
 */
export const UNMAPPED_SKILL_CODES: readonly string[] = [
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
];

export function isSkillFamilyId(value: unknown): value is SkillFamilyId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SKILL_FAMILY_NAMES, value);
}

/**
 * Expand a family to the operational codes it owns.
 *
 * THE TWO REFUSALS ARE THE POINT, AND THEY ARE DIFFERENT REFUSALS.
 *
 * An unrecognised id is a bad request -- the caller named something that is
 * not a family.
 *
 * A REAL family with no crosswalk is refused TOO (none today: all twelve were
 * reconciled by 2026-10-05, but the guard stays for a family whose list is
 * ever withdrawn), and this is the case worth being careful about. Returning an empty
 * array would have been the easy branch and it is the wrong one: the caller
 * would receive an empty drill list, which is indistinguishable from "this
 * family genuinely has no drills" and quietly false. A coach filtering by
 * SKILL-07 must be told the mapping does not exist yet, not shown an empty
 * shelf.
 */
export function memberCodesForFamily(
  familyId: string,
  crosswalk: Readonly<Partial<Record<SkillFamilyId, readonly string[]>>> = FAMILY_MEMBER_CODES,
): readonly string[] {
  if (!isSkillFamilyId(familyId)) {
    throw new ValidationError(
      `Unknown skill family: ${familyId}`,
      'UNKNOWN_SKILL_FAMILY',
    );
  }

  const codes = crosswalk[familyId];
  if (!codes) {
    throw new ValidationError(
      `Skill family ${familyId} (${SKILL_FAMILY_NAMES[familyId]}) has no approved code crosswalk yet.`,
      'SKILL_FAMILY_NOT_RECONCILED',
    );
  }

  return codes;
}
