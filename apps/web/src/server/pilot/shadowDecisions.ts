import { query, queryOne, withTransaction } from './db';
import { effectiveMedicalStatus, type MedicalAdministrativeStatusValue } from './shadowMedicalStatus';
import { readMedicalStatusOnFile } from './shadowRecommendations';
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

/**
 * A decision as the history reads it: with the medical status that was on file
 * when it was recorded, in effectiveMedicalStatus's words ('no_record' when
 * none was), and that status's end date if it had one.
 */
export interface ShadowDecisionListRow extends ShadowDecisionRow {
  medical_status_on_file: string;
  medical_status_expires_at: string | null;
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
  // The athlete's medical status never refuses a decision (Jason, 2026-10-11:
  // "let the coach make those assements"; OD-2026-10-10-004 to -007; issue
  // #1474). It is recorded with it: the row's medical_status_snapshot_id and
  // the audit entry's after_state, so the history shows what was on file.
  const onFile = await readMedicalStatusOnFile(input.organizationId, input.athleteId);

  return withTransaction(async (client) => {
    if (input.recommendationId) {
      // Scoped to THIS athlete as well as the organization. The route clears
      // only the athlete in the body, so without athlete_id here a decision
      // about one child could cite another child's recommendation -- and the
      // 409 would read out that recommendation's status (CL-A16). Someone
      // else's recommendation is reported exactly like a missing one.
      const recommendation = await client.query<{ status: string }>(
        `select status from pilot.shadow_recommendations
         where organization_id = $1 and recommendation_id = $2 and athlete_id = $3`,
        [input.organizationId, input.recommendationId, input.athleteId],
      );
      const status = recommendation.rows[0]?.status;
      const isActionable = status === 'provisional' || status === 'accepted';
      if (!isActionable) {
        throw new RecommendationNotActionableError(status ?? 'not_found');
      }
    }

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
        onFile.medicalStatusId,
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
      afterState: { recommendationId: row.recommendation_id, status: row.status, ...onFile },
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

export async function listDecisions(organizationId: string, athleteId: string): Promise<ShadowDecisionListRow[]> {
  // The snapshot row is read in the decision's own gym, and its status is
  // stated as of the moment the decision was recorded, so a clearance that
  // has since lapsed still reads as it stood then.
  const rows = await query<ShadowDecisionRow & {
    snapshot_status: MedicalAdministrativeStatusValue | null;
    snapshot_expires_at: string | null;
  }>(
    `select d.decision_id, d.organization_id, d.athlete_id, d.recommendation_id, d.decision_text, d.expected_outcome,
            d.decided_by_account_id, d.decided_by_role, d.medical_status_snapshot_id, d.status, d.decided_at,
            s.status as snapshot_status, s.expires_at::text as snapshot_expires_at
     from pilot.shadow_decisions d
     left join pilot.shadow_medical_administrative_status s
       on s.organization_id = d.organization_id and s.athlete_id = d.athlete_id
      and s.status_id = d.medical_status_snapshot_id
     where d.organization_id = $1 and d.athlete_id = $2
     order by d.decided_at desc`,
    [organizationId, athleteId],
  );
  return rows.map(({ snapshot_status, snapshot_expires_at, ...decision }) => ({
    ...decision,
    medical_status_on_file: snapshot_status === null
      ? effectiveMedicalStatus(null)
      : effectiveMedicalStatus(
        { status: snapshot_status, expires_at: snapshot_expires_at } as Parameters<typeof effectiveMedicalStatus>[0],
        new Date(decision.decided_at),
      ),
    medical_status_expires_at: snapshot_expires_at,
  }));
}
