import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { fileEscalation, type SafetyEscalationSeverity } from './escalationLadder';

// Behavior standards (register module 125). Two paths, deliberately
// asymmetric:
//
//   MEETING a standard is recognition -- it lands in pilot.recognitions,
//   the same record the platform already gives for good work, with a
//   typed link to the standard.
//
//   A CONCERN about conduct is NOT recorded here. It files into the
//   safety-escalation ladder as an incident, where an org admin sees it
//   and it is acknowledged and resolved on the record. There is no
//   per-athlete conduct log, no behavior score, and no loose discipline
//   note anywhere in this module: a concern about a child either matters
//   enough to be handled, or it does not get written down about them.

// The recognition vocabulary this platform already uses, in its own human
// words. A posted standard maps onto one of these rather than inventing a
// parallel taxonomy.
export const RECOGNITION_KINDS = [
  'helped_someone', 'showed_up_hard_day', 'back_after_a_loss',
  'worked_when_it_was_hard', 'good_partner', 'took_the_correction',
  'in_early_and_ready', 'left_it_better', 'spoke_up_well',
  'looked_after_someone_new',
] as const;

export type RecognitionKind = (typeof RECOGNITION_KINDS)[number];

export function isRecognitionKind(value: unknown): value is RecognitionKind {
  return typeof value === 'string' && (RECOGNITION_KINDS as readonly string[]).includes(value);
}

export interface BehaviorStandardRow {
  organization_id: string;
  standard_id: string;
  standard_name: string;
  description: string;
  recognition_kind: RecognitionKind;
  sort_order: number;
  active: boolean;
  created_at: string;
}

const FIELDS = `organization_id, standard_id, standard_name, description, recognition_kind,
  sort_order, active, created_at`;

export async function listStandards(organizationId: string, includeRetired = false): Promise<BehaviorStandardRow[]> {
  return query<BehaviorStandardRow>(
    `select ${FIELDS} from pilot.behavior_standards
     where organization_id = $1 and ($2 or active)
     order by active desc, sort_order asc, standard_name asc`,
    [organizationId, includeRetired],
  );
}

export async function createStandard(input: {
  organizationId: string;
  standardName: string;
  description?: string;
  recognitionKind: RecognitionKind;
  sortOrder?: number;
  createdByAccountId: string;
}): Promise<BehaviorStandardRow | null> {
  const standardId = randomUUID();
  await queryOne(
    `insert into pilot.behavior_standards
       (organization_id, standard_id, standard_name, description, recognition_kind, sort_order, created_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning standard_id`,
    [
      input.organizationId,
      standardId,
      input.standardName,
      input.description ?? '',
      input.recognitionKind,
      input.sortOrder ?? 100,
      input.createdByAccountId,
    ],
  );
  return queryOne<BehaviorStandardRow>(
    `select ${FIELDS} from pilot.behavior_standards where organization_id = $1 and standard_id = $2`,
    [input.organizationId, standardId],
  );
}

/** Retiring keeps the standard and every recognition that referenced it;
 * it only stops appearing as something to recognize going forward. */
export async function retireStandard(organizationId: string, standardId: string): Promise<BehaviorStandardRow | null> {
  const row = await queryOne<{ standard_id: string }>(
    `update pilot.behavior_standards set active = false, updated_at = now()
     where organization_id = $1 and standard_id = $2 and active
     returning standard_id`,
    [organizationId, standardId],
  );
  if (!row) return null;
  return queryOne<BehaviorStandardRow>(
    `select ${FIELDS} from pilot.behavior_standards where organization_id = $1 and standard_id = $2`,
    [organizationId, standardId],
  );
}

/** Recognizes an athlete for meeting a standard: an ordinary recognition
 * with a typed link. The coach's display name is stored as it stands
 * today, per the recognitions table's own rule. */
export async function recognizeStandardMet(input: {
  organizationId: string;
  athleteId: string;
  standardId: string;
  coachAccountId: string;
  coachDisplayName: string;
  note?: string;
}): Promise<{ recognition_id: string } | null> {
  // The standard supplies the recognition kind: a posted expectation
  // already says how it is recognized, so the caller cannot mislabel it.
  const standard = await queryOne<{ standard_id: string; recognition_kind: string }>(
    `select standard_id, recognition_kind from pilot.behavior_standards
     where organization_id = $1 and standard_id = $2 and active`,
    [input.organizationId, input.standardId],
  );
  if (!standard) return null;

  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const recognitionId = randomUUID();
  await queryOne(
    `insert into pilot.recognitions
       (organization_id, recognition_id, athlete_id, coach_account_id, coach_display_name, kind, note, standard_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning recognition_id`,
    [
      input.organizationId,
      recognitionId,
      input.athleteId,
      input.coachAccountId,
      input.coachDisplayName,
      standard.recognition_kind,
      input.note ?? '',
      input.standardId,
    ],
  );
  return { recognition_id: recognitionId };
}

/** A conduct concern goes to the SAFEGUARDING LADDER, not to a behavior
 * log. It is filed as an incident so an org admin sees it and it carries
 * an acknowledge/resolve lifecycle -- the same handling any other concern
 * about a child gets. Severity is the filer's stated judgment, never
 * computed from anything. */
export async function raiseConductConcern(input: {
  organizationId: string;
  athleteId: string;
  reason: string;
  severity: SafetyEscalationSeverity;
  standardId?: string | null;
  raisedByAccountId: string;
  raisedByRole: string;
}): Promise<{ escalation_id: string }> {
  const escalation = await fileEscalation({
    organizationId: input.organizationId,
    sourceType: 'incident',
    sourceId: input.standardId ?? null,
    athleteId: input.athleteId,
    severity: input.severity,
    reason: input.reason,
    triggeredBy: 'human',
    triggeredByAccountId: input.raisedByAccountId,
    triggeredByRole: input.raisedByRole,
    metadata: { concern_kind: 'conduct', standard_id: input.standardId ?? null },
  });
  return { escalation_id: escalation.escalation_id };
}
