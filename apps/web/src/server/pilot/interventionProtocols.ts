import { randomUUID } from 'node:crypto';

import { query, queryOne, withTransaction } from './db';

// Intervention protocols (register module 026 slice 1) -- what PPBF
// INTENDED to do: the hypothesis, the designed intervention, the intended
// exposure, the evaluation plan. Slice 2's executions record what actually
// happened; nothing here is evidence anything was delivered.
//
// Exposure is a structured map of dimension -> amount over a fixed
// vocabulary -- never a scalar dose. Editing is supersession: a new version
// row in the same lineage, the old row stamped superseded, nothing
// overwritten. An athlete-specific protocol (athlete_id set) never
// auto-generalizes to the organization, per the standing lessons rule.

export const EXPOSURE_DIMENSIONS = [
  'sessions', 'rounds', 'minutes', 'repetitions',
  'live_opportunities', 'constrained_opportunities', 'cue_exposures', 'task_exposures',
] as const;

export type ExposureDimension = (typeof EXPOSURE_DIMENSIONS)[number];
export type ProtocolStatus = 'active' | 'retired' | 'superseded';

export interface InterventionProtocolRow {
  organization_id: string;
  protocol_id: string;
  lineage_id: string;
  version: number;
  supersedes_protocol_id: string | null;
  athlete_id: string | null;
  athlete_name: string | null;
  title: string;
  target_problem: string;
  hypothesis: string;
  intervention_description: string;
  intended_task_context: string;
  intended_exposure: Record<string, number>;
  expected_outcome: string;
  contradicting_evidence: string;
  alternative_explanations: string;
  evaluation_plan: string;
  status: ProtocolStatus;
  created_by_account_id: string;
  created_at: string;
}

const FIELDS = `p.organization_id, p.protocol_id, p.lineage_id, p.version,
  p.supersedes_protocol_id, p.athlete_id, a.full_name as athlete_name,
  p.title, p.target_problem, p.hypothesis, p.intervention_description,
  p.intended_task_context, p.intended_exposure, p.expected_outcome,
  p.contradicting_evidence, p.alternative_explanations,
  p.evaluation_plan, p.status, p.created_by_account_id, p.created_at`;

const FROM = `from pilot.intervention_protocols p
  left join pilot.athletes a
    on a.organization_id = p.organization_id and a.athlete_id = p.athlete_id`;

/** Validates the structured-exposure contract: known dimensions, positive
 * finite amounts. Returns the reason a shape is refused, or null when it is
 * sound -- the route turns a reason into a 400. */
export function exposureShapeError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'intended_exposure must be an object of dimension -> amount.';
  }
  for (const [dimension, amount] of Object.entries(value)) {
    if (!(EXPOSURE_DIMENSIONS as readonly string[]).includes(dimension)) {
      return `Unknown exposure dimension '${dimension}'.`;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return `Exposure '${dimension}' must be a positive number.`;
    }
  }
  return null;
}

export interface ProtocolContentInput {
  title: string;
  targetProblem: string;
  hypothesis: string;
  interventionDescription: string;
  intendedTaskContext?: string;
  intendedExposure?: Record<string, number>;
  expectedOutcome: string;
  contradictingEvidence?: string;
  alternativeExplanations?: string;
  evaluationPlan?: string;
}

export async function createProtocol(input: ProtocolContentInput & {
  organizationId: string;
  athleteId?: string | null;
  createdByAccountId: string;
}): Promise<InterventionProtocolRow | null> {
  if (input.athleteId) {
    const athlete = await queryOne<{ athlete_id: string }>(
      `select athlete_id from pilot.athletes
       where organization_id = $1 and athlete_id = $2`,
      [input.organizationId, input.athleteId],
    );
    if (!athlete) return null;
  }

  const protocolId = randomUUID();
  await queryOne(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, version, athlete_id, title, target_problem,
        hypothesis, intervention_description, intended_task_context, intended_exposure,
        expected_outcome, contradicting_evidence, alternative_explanations, evaluation_plan, created_by_account_id)
     values ($1, $2, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
     returning protocol_id`,
    [
      input.organizationId,
      protocolId,
      input.athleteId ?? null,
      input.title,
      input.targetProblem,
      input.hypothesis,
      input.interventionDescription,
      input.intendedTaskContext ?? '',
      JSON.stringify(input.intendedExposure ?? {}),
      input.expectedOutcome,
      input.contradictingEvidence ?? '',
      input.alternativeExplanations ?? '',
      input.evaluationPlan ?? '',
      input.createdByAccountId,
    ],
  );

  return getProtocol(input.organizationId, protocolId);
}

export async function getProtocol(organizationId: string, protocolId: string): Promise<InterventionProtocolRow | null> {
  return queryOne<InterventionProtocolRow>(
    `select ${FIELDS} ${FROM}
     where p.organization_id = $1 and p.protocol_id = $2`,
    [organizationId, protocolId],
  );
}

/** Active heads first, then retired lineage heads; superseded rows are
 * history and only appear via lineage reads. */
export async function listProtocols(organizationId: string): Promise<InterventionProtocolRow[]> {
  return query<InterventionProtocolRow>(
    `select ${FIELDS} ${FROM}
     where p.organization_id = $1 and p.status <> 'superseded'
     order by (p.status = 'retired') asc, p.created_at desc`,
    [organizationId],
  );
}

/**
 * Raised inside reviseProtocol's transaction when the head it read is no
 * longer active by the time the stamp runs -- a concurrent revision or
 * retirement won. Private to this module: it exists only to roll the
 * transaction back and is converted straight back to the null this function
 * has always returned for "not revisable".
 */
class ProtocolRevisionLostRace extends Error {}

/** Supersession: a NEW version row in the lineage; the old head is stamped,
 * never edited. The new row re-states full content -- a version is a
 * complete statement of intent, not a diff. */
export async function reviseProtocol(input: ProtocolContentInput & {
  organizationId: string;
  protocolId: string;
  revisedByAccountId: string;
}): Promise<InterventionProtocolRow | null> {
  const current = await getProtocol(input.organizationId, input.protocolId);
  if (!current || current.status !== 'active') return null;

  const newId = randomUUID();

  // ONE TRANSACTION, AND THE FLIP CARRIES THE STATE IT READ.
  //
  // Three statements build a revision -- insert the successor born
  // 'superseded' (so the one-active-head unique index is never contended),
  // stamp the old head, then raise the successor. Run on autocommit they had
  // two failure shapes, and the comment that used to sit here described
  // neither of them correctly:
  //
  //   A failure or crash after the second statement leaves BOTH rows
  //   'superseded' -- the lineage has NO active head, not "its OLD head still
  //   active". Nothing recovers from that state: startExecution refuses a
  //   protocol that is not active, reviseProtocol and retireProtocol both
  //   require an active row to act on, and no path sets one. The protocol is
  //   dead and its executions can never resume.
  //
  //   Two concurrent revisions of the same protocol both read `current` as
  //   active, both insert (legal -- both successors are born superseded), and
  //   both then flipped the old head, because that UPDATE named no state. The
  //   first raise wins the unique index; the second raises a 23505 the caller
  //   sees as an opaque 500, and its successor row is stranded 'superseded'
  //   forever -- a ghost version in the lineage nothing can activate or
  //   remove.
  //
  // The transaction makes the three all-or-nothing, and `and status =
  // 'active'` on the stamp is the compare-and-set that decides the race
  // inside the database: the loser matches zero rows, rolls back its own
  // insert, and returns null, which the route already renders as a hidden
  // not-found.
  return withTransaction(async (client) => {
    await client.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, version, supersedes_protocol_id, athlete_id,
          title, target_problem, hypothesis, intervention_description, intended_task_context,
          intended_exposure, expected_outcome, contradicting_evidence, alternative_explanations,
          evaluation_plan, status, created_by_account_id)
       select organization_id, $3, lineage_id, version + 1, protocol_id, athlete_id,
              $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 'superseded', $14
       from pilot.intervention_protocols
       where organization_id = $1 and protocol_id = $2
       returning protocol_id`,
      [
        input.organizationId,
        input.protocolId,
        newId,
        input.title,
        input.targetProblem,
        input.hypothesis,
        input.interventionDescription,
        input.intendedTaskContext ?? '',
        JSON.stringify(input.intendedExposure ?? {}),
        input.expectedOutcome,
        input.contradictingEvidence ?? '',
        input.alternativeExplanations ?? '',
        input.evaluationPlan ?? '',
        input.revisedByAccountId,
      ],
    );

    const stamped = await client.query<{ protocol_id: string }>(
      `update pilot.intervention_protocols set status = 'superseded', updated_at = now()
       where organization_id = $1 and protocol_id = $2 and status = 'active'
       returning protocol_id`,
      [input.organizationId, input.protocolId],
    );
    if (stamped.rows.length === 0) {
      throw new ProtocolRevisionLostRace();
    }

    await client.query(
      `update pilot.intervention_protocols set status = 'active', updated_at = now()
       where organization_id = $1 and protocol_id = $2 returning protocol_id`,
      [input.organizationId, newId],
    );

    const revised = await client.query<InterventionProtocolRow>(
      `select ${FIELDS} ${FROM}
       where p.organization_id = $1 and p.protocol_id = $2`,
      [input.organizationId, newId],
    );
    return revised.rows[0] ?? null;
  }).catch((error) => {
    // The lost race is a caller-visible "someone else revised it first",
    // which this function has always reported as null (hidden not-found at
    // the route). Every other error is a real fault and still propagates.
    if (error instanceof ProtocolRevisionLostRace) return null;
    throw error;
  });
}

/** Retiring ends the lineage's active life without pretending it never
 * existed; executions recorded against it keep their meaning. */
export async function retireProtocol(organizationId: string, protocolId: string): Promise<InterventionProtocolRow | null> {
  const row = await queryOne<{ protocol_id: string }>(
    `update pilot.intervention_protocols set status = 'retired', updated_at = now()
     where organization_id = $1 and protocol_id = $2 and status = 'active'
     returning protocol_id`,
    [organizationId, protocolId],
  );
  if (!row) return null;
  return getProtocol(organizationId, protocolId);
}
