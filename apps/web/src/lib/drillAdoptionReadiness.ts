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
// Two rules the corpus could support were left out on purpose, because they
// are owner decisions, not facts: "at least one cue" (34 of the 119 seeded
// drills have none, including 23 of the 25 conditioning drills) and "the
// provenance must be validated" (114 of 119 are marked REQUIRES FLOOR
// VALIDATION and nothing records a validation).
//
// PURE and client-safe: the promote route enforces it on the server, so a
// direct API call cannot skip it, and the coach page runs the same function to
// show the result before anyone presses Promote.

export interface AdoptionReadinessInput {
  active: boolean;
  superseded_at: string | null;
  name: string;
  purpose: string;
  category: string;
  difficulty: string;
  standard_setup: string;
  execution: string;
  what_good_looks_like: string;
  scale_levels: { scale_level: string; is_starting_point: boolean }[];
  stop_rules: unknown[];
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

  // Safety: at least one condition to stop on. Contact level and the
  // coach-authorization flag are required columns with defaults, so checking
  // them here would prove nothing.
  if (drill.stop_rules.length === 0) missing.push('It has no stop rules.');

  return { ready: missing.length === 0, missing };
}
