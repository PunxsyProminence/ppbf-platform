import { query, withTransaction } from './db';
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
    const decision = await client.query<{ decision_id: string }>(
      `select decision_id from pilot.shadow_decisions
       where organization_id = $1 and decision_id = $2`,
      [input.organizationId, input.decisionId],
    );
    if (decision.rows.length === 0) {
      throw new Error('Decision not found in this organization scope.');
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
