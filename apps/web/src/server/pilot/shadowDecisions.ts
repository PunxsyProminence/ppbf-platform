import { query, queryOne, withTransaction } from './db';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { assertMedicalStatusAllowsRecommendation } from './shadowRecommendations';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type ShadowDecisionStatus = 'active' | 'superseded' | 'reversed';

export interface ShadowDecisionRow {
  decision_id: string;
  organization_id: string;
  athlete_id: string;
  recommendation_id: string | null;
  decision_text: string;
  expected_outcome: string;
  decided_by_account_id: string;
  decided_by_role: string;
  medical_status_snapshot_id: string | null;
  status: ShadowDecisionStatus;
  decided_at: string;
}

export class RecommendationNotActionableError extends Error {
  constructor(readonly recommendationStatus: string) {
    super(`Cannot act on a recommendation with status '${recommendationStatus}'.`);
    this.name = 'RecommendationNotActionableError';
  }
}

// A Decision always requires a human -- it may exist with no prior
// Recommendation (a coach can log one directly), but if it references one,
// that recommendation must still be live (not already expired/rejected/
// superseded), so nobody acts on a lapsed provisional as if it were current.
export async function recordDecision(input: {
  organizationId: string;
  athleteId: string;
  recommendationId?: string | null;
  decisionText: string;
  expectedOutcome: string;
  decidedByAccountId: string;
  decidedByRole: string;
}): Promise<ShadowDecisionRow> {
  // Unconditional. See createProvisionalRecommendation for the full reasoning:
  // this guard used to be armed by an isMedicallySensitive boolean read
  // verbatim off the HTTP body, so omitting one JSON field skipped the
  // clearance check on a return-to-play decision. A decision is the record of
  // an action taken about an athlete, so it carries at least the weight of the
  // recommendation that preceded it.
  await assertMedicalStatusAllowsRecommendation(input.organizationId, input.athleteId);

  return withTransaction(async (client) => {
    if (input.recommendationId) {
      const recommendation = await client.query<{ status: string }>(
        `select status from pilot.shadow_recommendations
         where organization_id = $1 and recommendation_id = $2`,
        [input.organizationId, input.recommendationId],
      );
      const status = recommendation.rows[0]?.status;
      const isActionable = status === 'provisional' || status === 'accepted';
      if (!isActionable) {
        throw new RecommendationNotActionableError(status ?? 'not_found');
      }
    }

    const medicalStatus = await getLatestMedicalAdministrativeStatus(input.organizationId, input.athleteId);

    const result = await client.query<ShadowDecisionRow>(
      `insert into pilot.shadow_decisions
       (organization_id, athlete_id, recommendation_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role, medical_status_snapshot_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning decision_id, organization_id, athlete_id, recommendation_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role, medical_status_snapshot_id, status, decided_at`,
      [
        input.organizationId,
        input.athleteId,
        input.recommendationId ?? null,
        input.decisionText,
        input.expectedOutcome,
        input.decidedByAccountId,
        input.decidedByRole,
        medicalStatus?.status_id ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to record SHADOW decision.');
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'decision',
      entityId: row.decision_id,
      action: 'recorded',
      actorAccountId: input.decidedByAccountId,
      actorRole: input.decidedByRole,
      afterState: { recommendationId: row.recommendation_id, status: row.status },
    });

    return row;
  });
}

// Resolves which athlete a decision belongs to, so routes scoped by
// decisionId (e.g. decision-outcomes) can still enforce per-athlete access
// control before reading/writing anything.
export async function getDecisionAthleteId(organizationId: string, decisionId: string): Promise<string | null> {
  const row = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.shadow_decisions where organization_id = $1 and decision_id = $2`,
    [organizationId, decisionId],
  );
  return row?.athlete_id ?? null;
}

export async function listDecisions(organizationId: string, athleteId: string): Promise<ShadowDecisionRow[]> {
  return query<ShadowDecisionRow>(
    `select decision_id, organization_id, athlete_id, recommendation_id, decision_text, expected_outcome, decided_by_account_id, decided_by_role, medical_status_snapshot_id, status, decided_at
     from pilot.shadow_decisions
     where organization_id = $1 and athlete_id = $2
     order by decided_at desc`,
    [organizationId, athleteId],
  );
}
