// Floor validation of a draft reference drill (OD-2026-10-06-026 ruling 3:
// "They stay drafts until a coach marks them floor-tested").
//
// PURE and client-safe: the promote route, the content validator and the coach
// page decide "is this a draft that still needs a floor test" from one place.

/**
 * The two field_provenance values that mark a drill as a draft. Verbatim from
 * pilot_drill_library_field_provenance_check (drill-library-v3 :266-273):
 * the column holds exact strings, so these are compared exactly too.
 */
export const REQUIRES_FLOOR_VALIDATION_PROVENANCE = [
  'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION',
  'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION',
] as const;

/** True for a draft: a drill no gym may adopt until one of its coaches has floor-tested it. */
export function requiresFloorValidation(fieldProvenance: string | null | undefined): boolean {
  return (REQUIRES_FLOOR_VALIDATION_PROVENANCE as readonly string[]).includes(fieldProvenance ?? '');
}

/** The adoption checklist line. */
export const NOT_FLOOR_TESTED_READINESS_MESSAGE =
  'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.';
