// Adoption readiness: whether a reference drill carries what a gym needs before
// it may adopt it as an operational drill (OD-2026-09-19-001 PROMOTION QUALITY,
// W-D4C).
//
// WHAT THIS IS, AND WHAT IT IS NOT. It checks only what the durable data can
// decide for EVERY drill: the reference is current (active, not superseded),
// and the content a drill cannot run without is present. It is NOT the
// context-aware quality gate the ruling asks for, and it must not be described
// as one. That gate needs to know when a requirement APPLIES to a drill --
// solo / partner / coach-led, space and environment, when drill-specific stop
// rules, corrections or scaling are required, ordered execution, and whether a
// reference has been validated on the floor -- and no column records any of
// those. Guessing them from prose is ruled out, so they are reported as a
// VERIFIED_MODEL_GAP instead of being approximated here.
//
// "At least one cue" is a rule now (OD-2026-10-06-026 ruling 2: required except
// for conditioning drills; see drillCueRule.ts). Of the 119 seeded drills, 34
// have no cue; 23 of those are conditioning and exempt, so 11 are not ready.
//
// "The provenance must be validated" is a rule now too (same ruling, ruling 3:
// "They stay drafts until a coach marks them floor-tested"). A draft -- one of
// the two REQUIRES FLOOR VALIDATION provenance values -- is ready for a gym
// only once a coach of THAT gym has marked it floor-tested
// (pilot.drill_floor_validations; see drillFloorValidation.ts). 114 of the 119
// seeded drills are drafts, so until coaches mark them none is adoptable.
//
// PURE and client-safe: the promote route enforces it on the server, so a
// direct API call cannot skip it, and the coach page runs the same function to
// show the result before anyone presses Promote.

import { NO_CUE_READINESS_MESSAGE, breaksCueRule, isConditioningLabel } from './drillCueRule';
import { NOT_FLOOR_TESTED_READINESS_MESSAGE, requiresFloorValidation } from './drillFloorValidation';

export interface AdoptionReadinessInput {
  active: boolean;
  superseded_at: string | null;
  name: string;
  purpose: string;
  /** 'conditioning' exempts the drill from the cue rule. */
  discipline: string;
  category: string;
  difficulty: string;
  standard_setup: string;
  execution: string;
  what_good_looks_like: string;
  scale_levels: { scale_level: string; is_starting_point: boolean }[];
  /**
   * The drill's OWN stop rules only -- DrillWithDetail.stop_rules, every
   * pilot.drill_stop_rules row of this version. The gym's stored-once rules
   * (DrillWithDetail.universal_stop_rules) are deliberately not an input: see
   * the safety rule below.
   */
  stop_rules: unknown[];
  /** The drill's cues (pilot.drill_cues rows); blank text does not count. */
  cues: { cue_text: string }[];
  /** A pilot_drill_library_field_provenance_check literal; the two DRAFT values need a floor test. */
  field_provenance: string;
  /** Whether a coach of the ADOPTING gym has marked this version floor-tested. */
  floor_tested_by_this_gym: boolean;
}

export interface AdoptionReadiness {
  ready: boolean;
  /** One plain sentence per unmet requirement, in a fixed order. Empty when ready. */
  missing: string[];
}

const blank = (value: string | null | undefined) => !(value ?? '').trim();

export function adoptionReadiness(drill: AdoptionReadinessInput): AdoptionReadiness {
  const missing: string[] = [];

  // Governance: only a current reference version may be newly adopted.
  if (!drill.active) missing.push('The reference drill has been withdrawn.');
  if (drill.superseded_at) missing.push('A newer version of this reference drill exists.');

  // Identity.
  if (blank(drill.name)) missing.push('It has no name.');
  if (blank(drill.purpose)) missing.push('It does not say what it is for.');
  if (blank(drill.category)) missing.push('It has no category.');
  if (blank(drill.difficulty)) missing.push('It has no difficulty.');

  // Execution: how to set it up, how it runs, and what doing it well looks like.
  if (blank(drill.standard_setup)) missing.push('It has no setup.');
  if (blank(drill.execution)) missing.push('It does not say how it runs.');
  if (blank(drill.what_good_looks_like)) missing.push('It does not say what good execution looks like.');

  // Scaling: the A/B/C structure every drill in the model carries, with one
  // level marked as where to start.
  const levels = new Set(drill.scale_levels.map((level) => level.scale_level));
  const starts = drill.scale_levels.filter((level) => level.is_starting_point).length;
  if (!levels.has('A') || !levels.has('B') || !levels.has('C') || starts !== 1) {
    missing.push('Its scaling is incomplete: it needs easier, standard and harder levels, with one marked as the starting point.');
  }

  // Safety: at least one condition to stop on that belongs to THIS drill.
  // Contact level and the coach-authorization flag are required columns with
  // defaults, so checking them here would prove nothing.
  //
  // THE GYM'S STORED-ONCE RULES NEVER COUNT (owner ruling R3; flagged default:
  // a drill needs at least one rule of its own). They apply to every drill, so
  // counting them would make every drill "have stop rules" the moment one
  // injury rule was loaded, and this check would stop checking anything. The
  // legacy per-drill rows labelled scope='universal' DO count: under R3 they are
  // the drill's own, and they are what keeps today's 119 seeded drills
  // adoptable. contentImport/warnings.ts judges new drills the same way.
  if (drill.stop_rules.length === 0) missing.push('It has no stop rules.');

  // Coaching: a technique drill needs at least one cue; conditioning does not.
  if (breaksCueRule({ conditioning: isConditioningLabel(drill.discipline), cues: drill.cues })) {
    missing.push(NO_CUE_READINESS_MESSAGE);
  }

  // Provenance: a draft stays a draft for this gym until one of its coaches
  // has tried it on the floor and said so.
  if (requiresFloorValidation(drill.field_provenance) && !drill.floor_tested_by_this_gym) {
    missing.push(NOT_FLOOR_TESTED_READINESS_MESSAGE);
  }

  return { ready: missing.length === 0, missing };
}
