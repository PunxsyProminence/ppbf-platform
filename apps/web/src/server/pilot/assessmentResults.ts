import { query, queryOne } from './db';
import { ValidationError } from './errors';
import { SKILL_FAMILY_IDS, SKILL_FAMILY_NAMES, type SkillFamilyId } from './skillFamilies';

// A COACH RECORDS ONE ATHLETE'S JUMP TEST AND SKILL RATINGS, AND READS THAT
// ATHLETE'S OWN HISTORY BACK. Map items 7-8 (ELITE-BOXING app map, 2026-10-04).
//
// NO NEW TABLE. pilot.assessments already carries protocol_id/version,
// administered_on, assessor_role and a jsonb result, and
// pilot.assessment_protocols already has 'physical_test' and 'skill_rubric'
// (infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql). What
// was missing was protocol rows for the gym, a writer, and a reader.
//
// OWNER DECISIONS (Jason, 2026-10-04, in the lane): jump test "can it be both
// or either" -> two protocols, countermovement jump height and standing broad
// jump distance, a coach records either or both; rating wording "A" -> the
// five levels in SKILL_RATING_LEVELS, verbatim.
//
// WHAT THIS MODULE DOES NOT DO, on purpose (engines rule: own record only).
// No total, average or combined score across skill families; no ranking; no
// read that spans more than one athlete. Each rating is one family on one
// date, and each jump is one number on one date.
//
// AUTHORIZATION IS THE CALLER'S. Every function takes an athlete id the route
// has already passed through assertActorCanAccessAthlete. The writes and the
// history read additionally re-check that the athlete is a live row in the
// organization, so a soft-deleted athlete is neither written to nor read.
//
// PROTOCOL ROWS ARE CREATED BY ensurePpbfAssessmentProtocols, called by the
// route before any read or write: idempotent, scoped to the caller's own
// organization, and never a migration seed. Every measurement-property field
// is left at the migration's explicit unvalidated default -- this module does
// not claim a reliability, a minimal detectable change or a retest interval
// the gym has not established.

export const JUMP_PROTOCOL_IDS = ['ppbf-jump-cmj-height', 'ppbf-jump-broad-distance'] as const;
export type JumpProtocolId = (typeof JUMP_PROTOCOL_IDS)[number];

export const SKILL_RATING_SCALE = 'ppbf-skill-1-5-v1';

/** Jason 2026-10-04, option A. Index 0 is level 1. */
export const SKILL_RATING_LEVELS: ReadonlyArray<{ level: 1 | 2 | 3 | 4 | 5; label: string; description: string }> = [
  { level: 1, label: 'Learning', description: "Can't do it yet without step-by-step coaching" },
  { level: 2, label: 'Developing', description: 'Does it in slow drills, with mistakes' },
  { level: 3, label: 'Solid', description: 'Does it right in drills at full speed' },
  { level: 4, label: 'Applies', description: 'Uses it under pressure in partner work or sparring' },
  { level: 5, label: 'Sharp', description: 'Uses it automatically in hard sparring and bouts, and adapts it' },
];

const PROTOCOL_VERSION = 1;
const SOURCE_REF = 'ppbf-coach-entry-v1';

export function skillRubricProtocolId(familyId: SkillFamilyId): string {
  return `ppbf-skill-rating-${familyId.toLowerCase()}`;
}

interface ProtocolSeed {
  protocol_id: string;
  name: string;
  measure_kind: 'physical_test' | 'skill_rubric';
  quality_measured: string;
  protocol_summary: string;
  equipment_needed: string;
  time_to_administer_min: number;
}

const RUBRIC_SUMMARY = SKILL_RATING_LEVELS
  .map((entry) => `${entry.level} ${entry.label}: ${entry.description}.`)
  .join(' ');

export const PPBF_ASSESSMENT_PROTOCOLS: readonly ProtocolSeed[] = [
  {
    protocol_id: 'ppbf-jump-cmj-height',
    name: 'Countermovement jump height',
    measure_kind: 'physical_test',
    quality_measured: 'Lower-body power (vertical)',
    protocol_summary:
      'Hands on hips, dip and jump straight up as high as possible. Three tries; record the best height in centimetres, as the jump app or mat reports it.',
    equipment_needed: 'Phone jump app or jump mat',
    time_to_administer_min: 5,
  },
  {
    protocol_id: 'ppbf-jump-broad-distance',
    name: 'Standing broad jump distance',
    measure_kind: 'physical_test',
    quality_measured: 'Lower-body power (horizontal)',
    protocol_summary:
      'Toes behind a line, swing and jump forward as far as possible, landing on both feet. Three tries; record the best distance in centimetres from the line to the back of the nearest heel.',
    equipment_needed: 'Tape measure and a floor line',
    time_to_administer_min: 5,
  },
  ...SKILL_FAMILY_IDS.map((familyId): ProtocolSeed => ({
    protocol_id: skillRubricProtocolId(familyId),
    name: `Skill rating: ${SKILL_FAMILY_NAMES[familyId]}`,
    measure_kind: 'skill_rubric',
    quality_measured: SKILL_FAMILY_NAMES[familyId],
    protocol_summary: `Coach rating on a 1-5 scale. ${RUBRIC_SUMMARY}`,
    equipment_needed: '',
    time_to_administer_min: 1,
  })),
];

const PPBF_PROTOCOL_IDS: readonly string[] = PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.protocol_id);

/**
 * Creates the gym's jump and skill-rating protocol rows if they are missing.
 * Never updates an existing row: a coach-edited or retired protocol is left
 * as it is. Throws if, afterwards, any of the rows is still absent (for
 * example an unrelated active protocol already holds the same name), because
 * every write below depends on the foreign key to these rows.
 */
export async function ensurePpbfAssessmentProtocols(organizationId: string): Promise<void> {
  const ids = PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.protocol_id);
  await query(
    `insert into pilot.assessment_protocols
       (organization_id, protocol_id, protocol_version, name, measure_kind, source_ref,
        quality_measured, protocol_summary, equipment_needed, time_to_administer_min)
     select $1, s.protocol_id, $2, s.name, s.measure_kind, $3,
            s.quality_measured, s.protocol_summary, s.equipment_needed, s.time_to_administer_min
     from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[])
       as s(protocol_id, name, measure_kind, quality_measured, protocol_summary, equipment_needed,
            time_to_administer_min)
     on conflict do nothing`,
    [
      organizationId,
      PROTOCOL_VERSION,
      SOURCE_REF,
      ids,
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.name),
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.measure_kind),
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.quality_measured),
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.protocol_summary),
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.equipment_needed),
      PPBF_ASSESSMENT_PROTOCOLS.map((p) => p.time_to_administer_min),
    ],
  );

  const present = await queryOne<{ n: number }>(
    `select count(*)::int as n from pilot.assessment_protocols
     where organization_id = $1 and protocol_version = $2 and protocol_id = any($3::text[])`,
    [organizationId, PROTOCOL_VERSION, ids],
  );
  if ((present?.n ?? 0) !== ids.length) {
    // Plain Error: an internal state problem, not caller-facing text.
    throw new Error('PPBF assessment protocols could not be ensured for this organization.');
  }
}

async function assertLiveAthlete(organizationId: string, athleteId: string): Promise<void> {
  const row = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [organizationId, athleteId],
  );
  if (!row) {
    throw new Error('Forbidden: athlete does not belong to organization');
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseAdministeredOn(value: unknown, today: string): string {
  if (value === undefined || value === null || value === '') return today;
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError('The test date must be a date (YYYY-MM-DD).', 'ASSESSMENT_DATE_INVALID');
  }
  if (value > today) {
    throw new ValidationError('The test date cannot be in the future.', 'ASSESSMENT_DATE_FUTURE');
  }
  return value;
}

function parseNote(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ValidationError('The note must be text.', 'ASSESSMENT_NOTE_INVALID');
  }
  const note = value.trim();
  if (note.length > 500) {
    throw new ValidationError('The note is limited to 500 characters.', 'ASSESSMENT_NOTE_TOO_LONG');
  }
  return note;
}

export interface AssessmentWriter {
  organizationId: string;
  accountId: string;
  role: string;
}

export interface RecordJumpInput {
  athleteId: string;
  protocolId: unknown;
  valueCm: unknown;
  administeredOn?: unknown;
  note?: unknown;
  /** Gym-local today (YYYY-MM-DD), supplied by the caller so tests are deterministic. */
  today: string;
}

export async function recordJumpResult(writer: AssessmentWriter, input: RecordJumpInput): Promise<AssessmentHistoryEntry> {
  if (typeof input.protocolId !== 'string' || !(JUMP_PROTOCOL_IDS as readonly string[]).includes(input.protocolId)) {
    throw new ValidationError('Choose the countermovement jump or the broad jump.', 'JUMP_PROTOCOL_INVALID');
  }
  const value = typeof input.valueCm === 'number' ? input.valueCm : Number.NaN;
  // A plausibility bound only, not a norm: it refuses a typo (a value in mm,
  // or a missing decimal point), nothing a real jump could produce.
  if (!Number.isFinite(value) || value <= 0 || value >= 500) {
    throw new ValidationError('Enter the best result in centimetres, more than 0 and under 500.', 'JUMP_VALUE_INVALID');
  }
  const administeredOn = parseAdministeredOn(input.administeredOn, input.today);
  const note = parseNote(input.note);

  await assertLiveAthlete(writer.organizationId, input.athleteId);

  const row = await queryOne<AssessmentHistoryRow>(
    `insert into pilot.assessments
       (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
        protocol_id, protocol_version, administration_kind, administered_on, assessor_role, conditions_note)
     values ($1, gen_random_uuid(), $2, $3, 'physical_test', $4::jsonb, $5, $6, 'ad_hoc', $7, $8, $9)
     returning ${HISTORY_FIELDS}`,
    [
      writer.organizationId,
      input.athleteId,
      writer.accountId,
      JSON.stringify({ value: Math.round(value * 10) / 10, unit: 'cm', best_of: 3 }),
      input.protocolId,
      PROTOCOL_VERSION,
      administeredOn,
      writer.role,
      note,
    ],
  );
  if (!row) throw new Error('Unable to record jump result.');
  return toEntry(row);
}

export interface RecordSkillRatingsInput {
  athleteId: string;
  ratings: unknown;
  administeredOn?: unknown;
  note?: unknown;
  today: string;
}

/**
 * One row per rated family, written in ONE statement so a coach's sheet is
 * saved whole or not at all. Families left unrated are simply absent -- an
 * unrated family is not a zero.
 */
export async function recordSkillRatings(
  writer: AssessmentWriter,
  input: RecordSkillRatingsInput,
): Promise<AssessmentHistoryEntry[]> {
  if (!Array.isArray(input.ratings) || input.ratings.length === 0) {
    throw new ValidationError('Rate at least one skill family.', 'SKILL_RATINGS_EMPTY');
  }
  const seen = new Set<string>();
  const families: SkillFamilyId[] = [];
  const levels: number[] = [];
  for (const entry of input.ratings) {
    const candidate = (entry ?? {}) as { skill_family_id?: unknown; level?: unknown };
    const familyId = candidate.skill_family_id;
    if (typeof familyId !== 'string' || !(SKILL_FAMILY_IDS as readonly string[]).includes(familyId)) {
      throw new ValidationError('A rating names an unknown skill family.', 'SKILL_FAMILY_INVALID');
    }
    if (seen.has(familyId)) {
      throw new ValidationError('Each skill family can be rated once per entry.', 'SKILL_FAMILY_DUPLICATE');
    }
    if (typeof candidate.level !== 'number' || !Number.isInteger(candidate.level) || candidate.level < 1 || candidate.level > 5) {
      throw new ValidationError('Each rating must be a whole number from 1 to 5.', 'SKILL_RATING_INVALID');
    }
    seen.add(familyId);
    families.push(familyId as SkillFamilyId);
    levels.push(candidate.level);
  }
  const administeredOn = parseAdministeredOn(input.administeredOn, input.today);
  const note = parseNote(input.note);

  await assertLiveAthlete(writer.organizationId, input.athleteId);

  const rows = await query<AssessmentHistoryRow>(
    `insert into pilot.assessments
       (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result,
        protocol_id, protocol_version, administration_kind, administered_on, assessor_role, conditions_note)
     select $1, gen_random_uuid(), $2, $3, 'skill_rubric',
            jsonb_build_object('level', r.level, 'scale', $4::text, 'skill_family_id', r.family_id),
            r.protocol_id, $5, 'ad_hoc', $6, $7, $8
     from unnest($9::text[], $10::text[], $11::int[]) as r(protocol_id, family_id, level)
     returning ${HISTORY_FIELDS}`,
    [
      writer.organizationId,
      input.athleteId,
      writer.accountId,
      SKILL_RATING_SCALE,
      PROTOCOL_VERSION,
      administeredOn,
      writer.role,
      note,
      families.map(skillRubricProtocolId),
      families,
      levels,
    ],
  );
  return rows.map(toEntry);
}

const HISTORY_FIELDS =
  'assessment_id, protocol_id, assessment_type, result, administered_on::text as administered_on, '
  + 'assessor_role, conditions_note, created_at';

interface AssessmentHistoryRow {
  assessment_id: string;
  protocol_id: string;
  assessment_type: string;
  result: Record<string, unknown>;
  administered_on: string;
  assessor_role: string | null;
  conditions_note: string;
  created_at: string;
}

export interface AssessmentHistoryEntry {
  assessment_id: string;
  protocol_id: string;
  kind: 'jump' | 'skill_rating';
  administered_on: string;
  /** Jump: centimetres. Skill rating: level 1-5. */
  value: number;
  skill_family_id: SkillFamilyId | null;
  assessor_role: string | null;
  note: string;
  recorded_at: string;
}

function toEntry(row: AssessmentHistoryRow): AssessmentHistoryEntry {
  const isJump = (JUMP_PROTOCOL_IDS as readonly string[]).includes(row.protocol_id);
  const result = row.result ?? {};
  const value = Number(isJump ? result.value : result.level);
  const family = typeof result.skill_family_id === 'string' ? (result.skill_family_id as SkillFamilyId) : null;
  return {
    assessment_id: row.assessment_id,
    protocol_id: row.protocol_id,
    kind: isJump ? 'jump' : 'skill_rating',
    administered_on: row.administered_on,
    value,
    skill_family_id: isJump ? null : family,
    assessor_role: row.assessor_role,
    note: row.conditions_note ?? '',
    recorded_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * ONE athlete's own jump and skill-rating history, newest first. Only the
 * PPBF protocols above; nothing aggregated. Returns [] for a deleted or
 * foreign athlete rather than disclosing anything (the route has already
 * answered the access question with a 403).
 */
export async function listAthleteAssessmentHistory(
  organizationId: string,
  athleteId: string,
): Promise<AssessmentHistoryEntry[]> {
  const rows = await query<AssessmentHistoryRow>(
    `select a.assessment_id, a.protocol_id, a.assessment_type, a.result,
            a.administered_on::text as administered_on, a.assessor_role, a.conditions_note, a.created_at
     from pilot.assessments a
     join pilot.athletes ath
       on ath.organization_id = a.organization_id and ath.athlete_id = a.athlete_id
     where a.organization_id = $1
       and a.athlete_id = $2
       and ath.deleted_at is null
       and a.administered_on is not null
       and a.protocol_id = any($3::text[])
     order by a.administered_on desc, a.created_at desc
     limit 500`,
    [organizationId, athleteId, PPBF_PROTOCOL_IDS],
  );
  return rows.map(toEntry);
}
