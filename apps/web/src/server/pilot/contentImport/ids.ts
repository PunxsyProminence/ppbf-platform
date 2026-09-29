import { createHash } from 'node:crypto';

// EVERY IDENTIFIER SHAPE THE CONTENT PACKAGES USE, AND HOW NEW ONES ARE MINTED.
//
// One module on purpose: the validator, the prepare step, the contract doc and
// (later) the athlete tag stripper all need the same answer to "is this a
// claim id", and three regexes for one shape is how drillLibraryV3.ts:651 came
// to accept only letter-digit tracks ([A-Z]\d+) while the registry also holds
// PS- and CB- claims.
//
// MINTING IS DETERMINISTIC, NOT RANDOM. A new item gets the id its content
// would have been given by the process that minted the committed ids, so the
// same hand-off prepared twice produces the same files. Each formula below was
// checked against EVERY committed row when this module was written (OBSERVED
// at 67857c79), not assumed. From then on contentImportValidate.test.ts pins
// each formula to real committed (inputs, id) pairs, so a formula edit fails.
// It is deliberately NOT re-checked over every current row: the contract's
// revision rule keeps an item's id when its name changes, so a renamed item's
// id no longer matches its name -- and that is correct, not a defect.
//
//   drl_  sha256(discipline + ':' + name)      119/119 committed drills
//   wtp_  sha256(name)                          12/12 committed templates
//   coh_  sha256(cohort_name)                    6/6 committed cohorts
//   wti_  sha256(template_id + ':' + ordinal)  82/82 committed template items
//   blk_  sha256(script_id + block_order)      65/65 committed blocks (no separator)
//   rnd_  sha256(script_id + format)            4/4 committed renderings (no separator)
//
// NOT REPRODUCIBLE from any column of the committed rows (every single, pair
// and triple of columns and seven separators were tried): scr_, scl_, stp_,
// cue_ and txf_. The committed ids stay exactly as they are; only NEW items
// get the formulas marked NEW below, which follow the same sha256-prefix shape.

/** First 14 hex characters of sha256 -- the tail every committed id carries. */
export function hex14(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 14);
}

export type IdKind =
  | 'drill'
  | 'template'
  | 'script'
  | 'cohort'
  | 'universal_rule'
  | 'scale'
  | 'stop_rule'
  | 'cue'
  | 'template_item'
  | 'block'
  | 'rendering'
  | 'transfer'
  | 'claim'
  | 'skill'
  | 'assessment_protocol'
  | 'slug';

export const ID_PREFIX = {
  drill: 'drl',
  template: 'wtp',
  script: 'scr',
  cohort: 'coh',
  universal_rule: 'ust',
  scale: 'scl',
  stop_rule: 'stp',
  cue: 'cue',
  template_item: 'wti',
  block: 'blk',
  rendering: 'rnd',
  transfer: 'txf',
} as const satisfies Partial<Record<IdKind, string>>;

type PrefixedKind = keyof typeof ID_PREFIX;

function prefixedPattern(kind: PrefixedKind): RegExp {
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{14}$`);
}

/**
 * Research registry claim id: A1-001, B6-012, PS-001, CB-008. Named
 * "registry" because pilot.shadow_evidence_claims.claim_id is a uuid and means
 * something else. 1193/1193 ids in the loaded 2026-08-07 package conform.
 */
export const REGISTRY_CLAIM_ID_PATTERN = /^[A-Z][A-Z0-9]-\d{3}$/;

/** The same shape written inline in drill prose: "... [A2-070]". */
export const INLINE_CLAIM_TAG_PATTERN = /\[([A-Z][A-Z0-9]-\d{3})\]/g;

/**
 * Operational skill code, e.g. SK-STANCE-01. The family ids SKILL-01..12 are a
 * different namespace and are never stored in a skill column (owner decision
 * D2-B, skillFamilies.ts:19-24); they are refused separately so the message
 * can say why.
 */
export const SKILL_CODE_PATTERN = /^SK-[A-Z]+-\d{2}$/;
export const SKILL_FAMILY_PREFIX = /^SKILL-/i;

/**
 * Assessment protocol id, taken from the research test battery: A5-T01..A5-T20
 * (shadow-research/2026-08-08/physical_test_battery.csv, 20/20 conform).
 * pilot.assessment_protocols.protocol_id is free text in the database; this is
 * the only id scheme any committed file uses for it.
 */
export const ASSESSMENT_PROTOCOL_ID_PATTERN = /^[A-Z][A-Z0-9]-T\d{2}$/;

/** Natural keys such as a discipline ('boxing') or a competence level ('holding'). */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A new item's placeholder id in a hand-off: new:<short-name>. */
export const NEW_ID_PATTERN = /^new:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isNewId(value: string): boolean {
  return value.startsWith('new:');
}

export function idPattern(kind: IdKind): RegExp {
  switch (kind) {
    case 'claim':
      return REGISTRY_CLAIM_ID_PATTERN;
    case 'skill':
      return SKILL_CODE_PATTERN;
    case 'assessment_protocol':
      return ASSESSMENT_PROTOCOL_ID_PATTERN;
    case 'slug':
      return SLUG_PATTERN;
    default:
      return prefixedPattern(kind);
  }
}

/** Plain-English shape, for findings and the contract doc. */
export function idShapeText(kind: IdKind): string {
  switch (kind) {
    case 'claim':
      return 'a capital letter, a capital letter or digit, a hyphen, three digits (A1-001, PS-001)';
    case 'skill':
      return 'SK-, capital letters, a hyphen, two digits (SK-STANCE-01)';
    case 'assessment_protocol':
      return 'a capital letter, a capital letter or digit, -T, two digits (A5-T01)';
    case 'slug':
      return 'lowercase letters, digits and underscores, starting with a letter (boxing)';
    default:
      return `${ID_PREFIX[kind]}_ and 14 lowercase hex characters`;
  }
}

/** Text is minted from what it will be stored as, minus accidental edge whitespace. */
function norm(value: string): string {
  return value.normalize('NFC').trim();
}

export const MINT = {
  drill: (discipline: string, name: string) => `drl_${hex14(`${norm(discipline)}:${norm(name)}`)}`,
  template: (name: string) => `wtp_${hex14(norm(name))}`,
  cohort: (cohortName: string) => `coh_${hex14(norm(cohortName))}`,
  // NEW: the committed scr_ ids are not reproducible; this follows drl_,
  // because a script, like a drill, belongs to a discipline.
  script: (discipline: string, name: string) => `scr_${hex14(`${norm(discipline)}:${norm(name)}`)}`,
  // NEW: no universal rule exists yet (R3). The rule's words are its identity.
  universalRule: (conditionText: string) => `ust_${hex14(norm(conditionText))}`,
  templateItem: (templateId: string, ordinal: string) => `wti_${hex14(`${templateId}:${norm(ordinal)}`)}`,
  block: (scriptId: string, blockOrder: string) => `blk_${hex14(`${scriptId}${norm(blockOrder)}`)}`,
  rendering: (scriptId: string, format: string) => `rnd_${hex14(`${scriptId}${norm(format)}`)}`,
  // NEW (committed ids not reproducible): parent id plus what makes the row
  // unique within its parent.
  scale: (drillId: string, scaleLevel: string) => `scl_${hex14(`${drillId}:${norm(scaleLevel)}`)}`,
  stopRule: (drillId: string, ordinal: string) => `stp_${hex14(`${drillId}:${norm(ordinal)}`)}`,
  cue: (drillId: string, cueText: string) => `cue_${hex14(`${drillId}:${norm(cueText)}`)}`,
  transfer: (targetId: string, claimKind: string, statement: string) =>
    `txf_${hex14(`${targetId}:${norm(claimKind)}:${norm(statement)}`)}`,
} as const;

/** The minting formulas as the contract doc states them. */
export const MINT_FORMULA_TEXT: Readonly<Record<string, string>> = {
  drill: "'drl_' + first 14 hex of sha256(discipline + ':' + name)",
  template: "'wtp_' + first 14 hex of sha256(name)",
  cohort: "'coh_' + first 14 hex of sha256(cohort_name)",
  script: "'scr_' + first 14 hex of sha256(discipline + ':' + name)",
  universal_rule: "'ust_' + first 14 hex of sha256(condition_text)",
  template_item: "'wti_' + first 14 hex of sha256(template_id + ':' + ordinal)",
  block: "'blk_' + first 14 hex of sha256(script_id + block_order)",
  rendering: "'rnd_' + first 14 hex of sha256(script_id + format)",
  scale: "'scl_' + first 14 hex of sha256(drill_id + ':' + scale_level)",
  stop_rule: "'stp_' + first 14 hex of sha256(drill_id + ':' + ordinal)",
  cue: "'cue_' + first 14 hex of sha256(drill_id + ':' + cue_text)",
  transfer: "'txf_' + first 14 hex of sha256(target id + ':' + claim_kind + ':' + statement)",
};
