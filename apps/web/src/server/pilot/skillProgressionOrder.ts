import { query, queryOne } from './db';
import {
  SKILL_FAMILY_IDS,
  SKILL_FAMILY_NAMES,
  SKILL_FAMILY_PREREQUISITES,
  type SkillFamilyId,
  type SkillFamilyPrerequisites,
} from './skillFamilies';

/*
  THE TECHNICAL PROGRESSION ORDER, DERIVED -- never typed out.

  Owner decision, Jason 2026-10-03 ("A: Registry wins"): the order comes from
  the registry prerequisites in skillFamilies.ts. A family's step is one more
  than the latest step among its prerequisites, so a family can never be shown
  ahead of something it needs. Writing the order as a list would be a second
  source of truth that could disagree with the prerequisites; deriving it means
  a prerequisite change moves the order with it.

  The coach-consensus [CC] order from the 2026-10-04 research synthesis
  (stance/guard > footwork > straight punches > defence > hooks/uppercuts >
  combinations > distance > ring generalship > counters/feints > style) is
  used ONLY to order families that share a step. Where it disagreed with the
  registry -- it puts footwork before the jab, the registry makes SKILL-07
  need SKILL-02 -- the registry won. Combinations, distance and style are not
  families and are not shown.
*/

/**
 * Within-step rank from the [CC] order. Lower comes first. Families the
 * synthesis does not mention (SKILL-08 Perception, SKILL-10 Body) sort after
 * every ranked family in their step, then by id.
 *
 * SKILL-07 is ranked by "footwork" (2nd in [CC]) rather than "ring
 * generalship" (8th): the family's first owned territory is footwork (pivots,
 * L-step), and ring generalship is what it builds toward.
 */
const CC_TIE_BREAK_RANK: Readonly<Partial<Record<SkillFamilyId, number>>> = {
  'SKILL-01': 0, // stance / guard
  'SKILL-07': 1, // footwork
  'SKILL-02': 2, // straight punches
  'SKILL-03': 2, // straight punches
  'SKILL-06': 3, // defence
  'SKILL-04': 4, // hooks / uppercuts
  'SKILL-05': 4, // hooks / uppercuts
  'SKILL-09': 8, // counters / feints
};

export interface OrderedSkillFamily {
  familyId: SkillFamilyId;
  name: string;
  /** Prerequisite families, in id order, with their names. */
  prerequisites: { familyId: SkillFamilyId; name: string }[];
}

export interface SkillProgressionStep {
  /** 1-based. Step 1 is the family with no prerequisites. */
  step: number;
  families: OrderedSkillFamily[];
}

export interface AcrossAllSkillFamily {
  familyId: SkillFamilyId;
  name: string;
  /** The registry's own Prerequisites cell, verbatim. */
  registryText: string;
}

export interface SkillProgressionOrder {
  steps: SkillProgressionStep[];
  /** Families that run alongside every step rather than at one of them. */
  acrossAll: AcrossAllSkillFamily[];
}

function rank(id: SkillFamilyId): number {
  return CC_TIE_BREAK_RANK[id] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Derive the ordered steps from a prerequisite table.
 *
 * Takes the table as a parameter so the tests can prove the refusal on a
 * cycle and on a dangling prerequisite; the app always calls it with the
 * registry table. A cycle or a prerequisite that is not itself in the
 * sequence throws -- either would mean some family has no honest place in the
 * order, and dropping it silently would show an athlete a ladder with a rung
 * missing.
 */
export function deriveSkillProgressionOrder(
  table: Readonly<Record<SkillFamilyId, SkillFamilyPrerequisites>> = SKILL_FAMILY_PREREQUISITES,
): SkillProgressionOrder {
  const sequenced = SKILL_FAMILY_IDS.filter((id) => table[id].kind === 'families');
  const inSequence = new Set<SkillFamilyId>(sequenced);
  const stepOf = new Map<SkillFamilyId, number>();

  const prereqsOf = (id: SkillFamilyId): readonly SkillFamilyId[] => {
    const entry = table[id];
    return entry.kind === 'families' ? entry.families : [];
  };

  for (const id of sequenced) {
    for (const prereq of prereqsOf(id)) {
      if (!inSequence.has(prereq)) {
        throw new Error(`${id} needs ${prereq}, which has no place in the sequence.`);
      }
    }
  }

  // Longest-path layering. At most sequenced.length passes; a pass that
  // places nothing while families remain means a cycle.
  while (stepOf.size < sequenced.length) {
    let placed = 0;
    for (const id of sequenced) {
      if (stepOf.has(id)) continue;
      const prereqs = prereqsOf(id);
      if (prereqs.every((p) => stepOf.has(p))) {
        stepOf.set(id, prereqs.reduce((max, p) => Math.max(max, stepOf.get(p)! + 1), 1));
        placed += 1;
      }
    }
    if (placed === 0) {
      const stuck = sequenced.filter((id) => !stepOf.has(id));
      throw new Error(`Skill family prerequisites form a cycle: ${stuck.join(', ')}`);
    }
  }

  const steps: SkillProgressionStep[] = [];
  for (const id of sequenced) {
    const step = stepOf.get(id)!;
    while (steps.length < step) steps.push({ step: steps.length + 1, families: [] });
    steps[step - 1].families.push({
      familyId: id,
      name: SKILL_FAMILY_NAMES[id],
      prerequisites: [...prereqsOf(id)]
        .sort()
        .map((p) => ({ familyId: p, name: SKILL_FAMILY_NAMES[p] })),
    });
  }
  for (const s of steps) {
    s.families.sort((a, b) => rank(a.familyId) - rank(b.familyId) || a.familyId.localeCompare(b.familyId));
  }

  const acrossAll: AcrossAllSkillFamily[] = [];
  for (const id of SKILL_FAMILY_IDS) {
    const entry = table[id];
    if (entry.kind === 'across_all') {
      acrossAll.push({ familyId: id, name: SKILL_FAMILY_NAMES[id], registryText: entry.registryText });
    }
  }

  return { steps, acrossAll };
}

/** One of the athlete's own assignments that trains a given family. */
export interface FamilyDrillAssignment {
  assignment_id: string;
  drill_display_name: string;
  status: 'assigned' | 'in_progress' | 'completed' | 'incomplete';
  assigned_at: string;
}

/**
 * An athlete's own assignments that train one family, newest first.
 *
 * THE PATH IS THE ONLY ONE THE SCHEMA HAS: assignment -> the gym's drill
 * (pilot.drills) -> the reference drill it was promoted from
 * (reference_drill_id) -> that reference drill's primary skill code or any
 * secondary code. A family is the codes memberCodesForFamily expands it to,
 * and that call throws for a family with no crosswalk -- so this function
 * cannot answer "nothing" for SKILL-02..12; it refuses, and the route turns
 * the refusal into "not mapped yet".
 *
 * Rows, not a count. A tally of a child's drills is a score produced by
 * arithmetic (the development-blocks route explains why that surface refuses
 * one); the athlete sees which drills, and each one's status as the coach's
 * own assignment row already states it.
 *
 * Cancelled assignments are left out: the coach withdrew them.
 */
export async function listAthleteFamilyDrills(
  organizationId: string,
  athleteId: string,
  codes: readonly string[],
): Promise<FamilyDrillAssignment[]> {
  return query<FamilyDrillAssignment>(
    `select a.assignment_id,
            coalesce(d.name, a.drill_name) as drill_display_name,
            a.status,
            a.assigned_at
     from pilot.drill_assignments a
     join pilot.drills d
       on d.organization_id = a.organization_id and d.drill_id = a.drill_id
     join pilot.drill_library l
       on l.organization_id = d.organization_id and l.drill_id = d.reference_drill_id
     where a.organization_id = $1
       and a.athlete_id = $2
       and a.status <> 'cancelled'
       and (
         l.skill_id = any($3::text[])
         or exists (
           select 1
           from pilot.drill_secondary_skills s
           where s.organization_id = l.organization_id
             and s.drill_id = l.drill_id
             and s.skill_id = any($3::text[])
         )
       )
     order by a.assigned_at desc, a.assignment_id`,
    [organizationId, athleteId, [...codes]],
  );
}

/**
 * The athlete's live assignments that carry no skill code at all, so no
 * family can ever claim them:
 *   - no reference drill behind them (hand-authored gym drills, and
 *     assignments written before drills had identity), or
 *   - a reference drill with a blank skill_id and no secondary skill row
 *     (the shipped seed has such rows, e.g. warm-ups).
 * The page says so rather than letting the path look complete.
 *
 * A drill WITH a code whose family is undecided (UNMAPPED_SKILL_CODES) is not
 * counted here: it belongs under a family that already reads "not mapped
 * yet", and counting it twice would tell the athlete two different stories
 * about one drill.
 *
 * Athlete-wide, so asked once per read, not once per family.
 */
export async function countUnlinkedAssignments(organizationId: string, athleteId: string): Promise<number> {
  const row = await queryOne<{ unlinked: string }>(
    `select count(*)::text as unlinked
     from pilot.drill_assignments a
     left join pilot.drills d
       on d.organization_id = a.organization_id and d.drill_id = a.drill_id
     left join pilot.drill_library l
       on l.organization_id = d.organization_id and l.drill_id = d.reference_drill_id
     where a.organization_id = $1
       and a.athlete_id = $2
       and a.status <> 'cancelled'
       and (
         l.drill_id is null
         or (
           nullif(btrim(l.skill_id), '') is null
           and not exists (
             select 1
             from pilot.drill_secondary_skills s
             where s.organization_id = l.organization_id
               and s.drill_id = l.drill_id
           )
         )
       )`,
    [organizationId, athleteId],
  );

  return Number(row?.unlinked ?? 0);
}
