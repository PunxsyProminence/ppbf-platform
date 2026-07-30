import { query, withTransaction } from './db';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type ShadowRecommendationStatus = 'provisional' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export interface ShadowRecommendationRow {
  recommendation_id: string;
  organization_id: string;
  athlete_id: string;
  source_formula_result_id: string | null;
  recommendation_text: string;
  expected_outcome: string;
  status: ShadowRecommendationStatus;
  created_by_account_id: string;
  created_at: string;
  expires_at: string;
  decided_by_account_id: string | null;
  decided_at: string | null;
}

const DEFAULT_EXPIRY_HOURS = 72;

export class MedicalStatusBlockedError extends Error {
  constructor(readonly status: string) {
    super(
      status === 'no_record'
        ? "Blocked: this athlete has no medical administrative status on file yet. A medically sensitive decision requires an explicit 'cleared' status -- set one in the Medical Status panel before recording this decision."
        : `Blocked: this athlete's medical administrative status is '${status}', not 'cleared'. Set status to 'cleared' in the Medical Status panel before recording this decision, or leave it as-is if the athlete should not yet participate.`,
    );
    this.name = 'MedicalStatusBlockedError';
  }
}

// Never auto-clear medical/sparring-clearance/weight-cut decisions. Any
// recommendation whose topic touches one of those must check the athlete's
// current MedicalAdministrativeStatus first -- this is the one shared guard
// both this module and shadowDecisions.ts rely on, so the rule lives in
// exactly one place.
export async function assertMedicalStatusAllowsRecommendation(
  organizationId: string,
  athleteId: string,
): Promise<void> {
  // Fail closed: only an explicit 'cleared' record allows a medically
  // sensitive recommendation through. No record on file, 'pending', and
  // 'restricted'/'not_cleared' all block -- absence of a clearance decision
  // is not itself a clearance decision.
  const status = await getLatestMedicalAdministrativeStatus(organizationId, athleteId);
  if (!status || status.status !== 'cleared') {
    throw new MedicalStatusBlockedError(status?.status ?? 'no_record');
  }
}

export async function createProvisionalRecommendation(input: {
  organizationId: string;
  athleteId: string;
  sourceFormulaResultId?: string | null;
  recommendationText: string;
  expectedOutcome: string;
  createdByAccountId: string;
  createdByRole: string;
  expiresInHours?: number;
  // Set true when the recommendation's subject matter touches medical
  // clearance, sparring/contact clearance, or weight-cut guidance -- forces
  // the medical-status guard above before the row is created.
  isMedicallySensitive?: boolean;
}): Promise<ShadowRecommendationRow> {
  if (input.isMedicallySensitive) {
    await assertMedicalStatusAllowsRecommendation(input.organizationId, input.athleteId);
  }

  const expiresInHours = input.expiresInHours && input.expiresInHours > 0
    ? input.expiresInHours
    : DEFAULT_EXPIRY_HOURS;

  return withTransaction(async (client) => {
    // status is intentionally NOT parameterized from caller input anywhere
    // in this INSERT -- every provisional recommendation is created with
    // that exact literal status, full stop.
    const result = await client.query<ShadowRecommendationRow>(
      `insert into pilot.shadow_recommendations
       (organization_id, athlete_id, source_formula_result_id, recommendation_text, expected_outcome, status, created_by_account_id, expires_at)
       values ($1,$2,$3,$4,$5,'provisional',$6, now() + ($7 || ' hours')::interval)
       returning recommendation_id, organization_id, athlete_id, source_formula_result_id, recommendation_text, expected_outcome, status, created_by_account_id, created_at, expires_at, decided_by_account_id, decided_at`,
      [
        input.organizationId,
        input.athleteId,
        input.sourceFormulaResultId ?? null,
        input.recommendationText,
        input.expectedOutcome,
        input.createdByAccountId,
        String(expiresInHours),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to create SHADOW recommendation.');
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'recommendation',
      entityId: row.recommendation_id,
      action: 'created_provisional',
      actorAccountId: input.createdByAccountId,
      actorRole: input.createdByRole,
      afterState: { status: row.status, expiresAt: row.expires_at },
    });

    return row;
  });
}

// Lazily expires stale provisional rows on read (no cron scheduler exists in
// this codebase, and none is needed for this) -- silence must never equal
// acceptance, so a provisional recommendation nobody acted on becomes
// 'expired' the moment anyone next lists it past its expires_at.
export async function listRecommendations(input: {
  organizationId: string;
  athleteId: string;
  status?: ShadowRecommendationStatus;
}): Promise<ShadowRecommendationRow[]> {
  await query(
    `update pilot.shadow_recommendations
     set status = 'expired'
     where organization_id = $1 and status = 'provisional' and expires_at < now()`,
    [input.organizationId],
  );

  return query<ShadowRecommendationRow>(
    `select recommendation_id, organization_id, athlete_id, source_formula_result_id, recommendation_text, expected_outcome, status, created_by_account_id, created_at, expires_at, decided_by_account_id, decided_at
     from pilot.shadow_recommendations
     where organization_id = $1 and athlete_id = $2
       and ($3::text is null or status = $3)
     order by created_at desc`,
    [input.organizationId, input.athleteId, input.status ?? null],
  );
}

// The only path that can move a recommendation off 'provisional' -- always
// requires an explicit human decidedByAccountId; there is no code path that
// transitions status without one.
export async function decideOnRecommendation(input: {
  organizationId: string;
  recommendationId: string;
  decision: 'accepted' | 'rejected';
  decidedByAccountId: string;
  decidedByRole: string;
}): Promise<ShadowRecommendationRow | null> {
  return withTransaction(async (client) => {
    const result = await client.query<ShadowRecommendationRow>(
      `update pilot.shadow_recommendations
       set status = $3, decided_by_account_id = $4, decided_at = now()
       where organization_id = $1 and recommendation_id = $2 and status = 'provisional'
       returning recommendation_id, organization_id, athlete_id, source_formula_result_id, recommendation_text, expected_outcome, status, created_by_account_id, created_at, expires_at, decided_by_account_id, decided_at`,
      [input.organizationId, input.recommendationId, input.decision, input.decidedByAccountId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'recommendation',
      entityId: row.recommendation_id,
      action: `decided_${input.decision}`,
      actorAccountId: input.decidedByAccountId,
      actorRole: input.decidedByRole,
      beforeState: { status: 'provisional' },
      afterState: { status: row.status },
    });

    return row;
  });
}
