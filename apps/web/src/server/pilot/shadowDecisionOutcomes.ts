import { query, withTransaction } from './db';
import { ValidationError } from './errors';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type ShadowDecisionMatchState = 'match' | 'partial' | 'miss' | 'confounded';

export interface ShadowDecisionOutcomeRow {
  outcome_id: string;
  organization_id: string;
  decision_id: string;
  observation_ids: string[];
  match_state: ShadowDecisionMatchState;
  notes: string | null;
  evaluated_by_account_id: string;
  evaluated_at: string;
}

export const MAX_OUTCOME_OBSERVATION_IDS = 50;

// ONE refusal for every way an observation id can be wrong -- it does not
// exist, it belongs to another organization, it belongs to another athlete,
// or there are too many of them. Distinguishing those would turn this write
// into a lookup: a caller could learn that a foreign id exists by reading
// which refusal came back.
const OBSERVATION_IDS_REFUSAL = 'Decision outcome observation ids are invalid.';

// Closes the loop: a human reviewer compares a decision's expected_outcome
// text against what actually happened and records the match. This is
// always a recorded human judgment, never an automated comparison --
// building an automated expected-vs-actual matcher would be a
// substantially larger NLP effort with no basis in what's been asked for.
export async function evaluateDecisionOutcome(input: {
  organizationId: string;
  decisionId: string;
  observationIds: string[];
  matchState: ShadowDecisionMatchState;
  notes?: string | null;
  evaluatedByAccountId: string;
  evaluatedByRole: string;
}): Promise<ShadowDecisionOutcomeRow> {
  return withTransaction(async (client) => {
    const decision = await client.query<{ decision_id: string; athlete_id: string }>(
      `select decision_id, athlete_id from pilot.shadow_decisions
       where organization_id = $1 and decision_id = $2`,
      [input.organizationId, input.decisionId],
    );
    if (decision.rows.length === 0) {
      throw new Error('Decision not found in this organization scope.');
    }

    // observation_ids is an untyped text[] -- no foreign key can cover an
    // array -- so this is the only place a foreign id can be stopped. The
    // column has never said which table it holds and the form is free text,
    // so an id is accepted from EITHER observation table, but only when it is
    // in the decision's organization AND about the decision's athlete. A
    // formula observation with no athlete (athlete_id null) is not about this
    // athlete and is refused. Checked on the same client as the insert so the
    // check and the write share one transaction.
    const distinctIds = [...new Set(input.observationIds)];
    if (distinctIds.length > MAX_OUTCOME_OBSERVATION_IDS) {
      throw new ValidationError(OBSERVATION_IDS_REFUSAL);
    }
    if (distinctIds.length > 0) {
      const matched = await client.query<{ matched: number }>(
        `select count(*)::int as matched from (
           select observation_id as id
           from pilot.shadow_formula_observations
           where organization_id = $1 and athlete_id = $2 and observation_id = any($3::text[])
           union
           select note_id::text as id
           from pilot.coach_observations
           where organization_id = $1 and athlete_id = $2 and note_id::text = any($3::text[])
         ) owned`,
        [input.organizationId, decision.rows[0].athlete_id, distinctIds],
      );
      if (matched.rows[0]?.matched !== distinctIds.length) {
        throw new ValidationError(OBSERVATION_IDS_REFUSAL);
      }
    }

    const result = await client.query<ShadowDecisionOutcomeRow>(
      `insert into pilot.shadow_decision_outcomes
       (organization_id, decision_id, observation_ids, match_state, notes, evaluated_by_account_id)
       values ($1,$2,$3,$4,$5,$6)
       returning outcome_id, organization_id, decision_id, observation_ids, match_state, notes, evaluated_by_account_id, evaluated_at`,
      [
        input.organizationId,
        input.decisionId,
        input.observationIds,
        input.matchState,
        input.notes ?? null,
        input.evaluatedByAccountId,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to record SHADOW decision outcome.');
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'outcome',
      entityId: row.outcome_id,
      action: 'evaluated',
      actorAccountId: input.evaluatedByAccountId,
      actorRole: input.evaluatedByRole,
      afterState: { decisionId: row.decision_id, matchState: row.match_state },
    });

    return row;
  });
}

export async function listDecisionOutcomes(organizationId: string, decisionId: string): Promise<ShadowDecisionOutcomeRow[]> {
  return query<ShadowDecisionOutcomeRow>(
    `select outcome_id, organization_id, decision_id, observation_ids, match_state, notes, evaluated_by_account_id, evaluated_at
     from pilot.shadow_decision_outcomes
     where organization_id = $1 and decision_id = $2
     order by evaluated_at desc`,
    [organizationId, decisionId],
  );
}
