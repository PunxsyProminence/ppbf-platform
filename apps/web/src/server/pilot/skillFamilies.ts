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
 * Family -> member codes, for every family whose crosswalk has been decided.
 *
 * Partial ON PURPOSE. A family absent from this map is a family nobody has
 * reconciled yet, and memberCodesForFamily refuses it out loud rather than
 * expanding it to nothing -- see the note there.
 */
export const FAMILY_MEMBER_CODES: Readonly<Partial<Record<SkillFamilyId, readonly string[]>>> = {
  'SKILL-01': SKILL_01_MEMBER_CODES,
};

/**
 * Every other skill code currently carried by the shipped drill library.
 *
 * This list is not documentation. It is the reason a NEW code cannot enter the
 * seed CSV unnoticed: skillFamilies.test.ts requires every non-empty skill_id
 * in the CSV to be either mapped above or named here, so an unrecognised value
 * fails rather than defaulting into "unmapped" by silence.
 *
 * Being here means "no family decided yet", never "belongs to no family".
 */
export const UNMAPPED_SKILL_CODES: readonly string[] = [
  'SK-ANG-01',
  'SK-BAG-01',
  'SK-BAG-02',
  'SK-BODY-01',
  'SK-COMBO-01',
  'SK-COMBO-02',
  'SK-COMBO-03',
  'SK-CROSS-01',
  'SK-CTR-01',
  'SK-CTR-02',
  'SK-DEF-01',
  'SK-DEF-02',
  'SK-DEF-03',
  'SK-DEF-04',
  'SK-DEF-05',
  'SK-DEF-06',
  'SK-DEF-07',
  'SK-DEF-08',
  'SK-DIST-01',
  'SK-DIST-02',
  'SK-DIST-03',
  'SK-DRILL-01',
  'SK-FEINT-01',
  'SK-FILM-01',
  'SK-FILM-02',
  'SK-FW-01',
  'SK-FW-02',
  'SK-FW-03',
  'SK-FW-04',
  'SK-FW-05',
  'SK-FW-06',
  'SK-FW-07',
  'SK-HAND-01',
  'SK-HOOK-01',
  'SK-HOOK-02',
  'SK-IN-01',
  'SK-IN-02',
  'SK-JAB-01',
  'SK-JAB-02',
  'SK-JAB-03',
  'SK-OUT-01',
  'SK-PAD-01',
  'SK-PARTNER-01',
  'SK-RET-01',
  'SK-RET-02',
  'SK-REV-01',
  'SK-REV-02',
  'SK-RHY-01',
  'SK-SAFE-01',
  'SK-SAFE-02',
  'SK-SELF-01',
  'SK-SHADOW-01',
  'SK-SPAR-01',
  'SK-SPAR-02',
  'SK-SPAR-03',
  'SK-SPAR-04',
  'SK-TAC-01',
  'SK-TAC-02',
  'SK-TAC-03',
  'SK-TAC-04',
  'SK-UPPER-01',
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
 * A REAL family with no crosswalk yet (SKILL-02..SKILL-12 today) is refused
 * TOO, and this is the case worth being careful about. Returning an empty
 * array would have been the easy branch and it is the wrong one: the caller
 * would receive an empty drill list, which is indistinguishable from "this
 * family genuinely has no drills" and quietly false. A coach filtering by
 * SKILL-07 must be told the mapping does not exist yet, not shown an empty
 * shelf.
 */
export function memberCodesForFamily(familyId: string): readonly string[] {
  if (!isSkillFamilyId(familyId)) {
    throw new ValidationError(
      `Unknown skill family: ${familyId}`,
      'UNKNOWN_SKILL_FAMILY',
    );
  }

  const codes = FAMILY_MEMBER_CODES[familyId];
  if (!codes) {
    throw new ValidationError(
      `Skill family ${familyId} (${SKILL_FAMILY_NAMES[familyId]}) has no approved code crosswalk yet.`,
      'SKILL_FAMILY_NOT_RECONCILED',
    );
  }

  return codes;
}
