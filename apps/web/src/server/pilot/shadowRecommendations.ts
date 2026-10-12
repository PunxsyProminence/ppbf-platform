import { query, queryOne, withTransaction } from './db';
import { effectiveMedicalStatus, getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
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

// THE MEDICAL STATUS IS RECORDED, NOT ENFORCED (Jason, 2026-10-10 and
// 2026-10-11, OD-2026-10-10-004 to -007: coaches make the assessments; the app
// teaches and records, it does not block, flag, warn or hold; issue #1474).
//
// Creating a recommendation, deciding one and recording a decision used to be
// refused unless the athlete held a current 'cleared' status. With no status
// on file for anyone in the live gym, no coach could record any decision. Now
// each record carries the status that was on file when it was made: the
// decision row's medical_status_snapshot_id, and on every audit entry the three
// fields below. The contact gate (contactClearanceGate.ts) is a separate rule
// with its own read of isClearanceCurrent and is not changed by this.

/** The athlete's medical administrative status as it stood when a record was made. */
export interface MedicalStatusOnFile {
  /**
   * effectiveMedicalStatus's words: 'no_record', 'pending', 'restricted',
   * 'not_cleared', 'cleared', or 'cleared_expired' for a clearance past its end.
   */
  medicalStatusOnFile: string;
  /** The status row on file, or null when there is none. */
  medicalStatusId: string | null;
  medicalStatusExpiresAt: string | null;
}

/** Reads the latest status once and states it as of `at` (default: now). Never refuses. */
export async function readMedicalStatusOnFile(
  organizationId: string,
  athleteId: string,
  at: Date = new Date(),
): Promise<MedicalStatusOnFile> {
  const row = await getLatestMedicalAdministrativeStatus(organizationId, athleteId);
  return {
    medicalStatusOnFile: effectiveMedicalStatus(row, at),
    medicalStatusId: row?.status_id ?? null,
    medicalStatusExpiresAt: row?.expires_at ?? null,
  };
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
}): Promise<ShadowRecommendationRow> {
  // Recorded with the recommendation, never a reason to refuse it (issue #1474).
  const onFile = await readMedicalStatusOnFile(input.organizationId, input.athleteId);

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
      afterState: { status: row.status, expiresAt: row.expires_at, ...onFile },
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

/**
 * Resolves which athlete a recommendation is about, so a route keyed by
 * recommendationId can enforce per-athlete access against the STORED owner
 * rather than against an athlete id the caller supplied. Mirrors
 * getDecisionAthleteId in shadowDecisions.ts, which exists for exactly the
 * same reason on the decision-outcomes route.
 */
export async function getRecommendationAthleteId(
  organizationId: string,
  recommendationId: string,
): Promise<string | null> {
  const row = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.shadow_recommendations
     where organization_id = $1 and recommendation_id = $2`,
    [organizationId, recommendationId],
  );
  return row?.athlete_id ?? null;
}

// The only path that can move a recommendation off 'provisional' -- always
// requires an explicit human decidedByAccountId; there is no code path that
// transitions status without one.
//
// athleteId is REQUIRED and is bound into the WHERE, so the row this statement
// can touch is the row whose owner the caller authorized. Before this, the
// UPDATE matched on (organization_id, recommendation_id) alone while the route
// above it authorized an athlete id taken from the request body -- so the
// authorized athlete and the written athlete were free to be different people,
// and a coach could decide a recommendation about a child they have no
// relationship with by naming one of their own athletes in the payload. The
// caller passes the owner it resolved and authorized; this predicate is what
// makes that authorization load-bearing rather than advisory.
export async function decideOnRecommendation(input: {
  organizationId: string;
  athleteId: string;
  recommendationId: string;
  decision: 'accepted' | 'rejected';
  decidedByAccountId: string;
  decidedByRole: string;
}): Promise<ShadowRecommendationRow | null> {
  // Recorded with the decision, never a reason to refuse it (issue #1474).
  const onFile = await readMedicalStatusOnFile(input.organizationId, input.athleteId);

  return withTransaction(async (client) => {
    const result = await client.query<ShadowRecommendationRow>(
      `update pilot.shadow_recommendations
       set status = $3, decided_by_account_id = $4, decided_at = now()
       where organization_id = $1 and recommendation_id = $2 and athlete_id = $5 and status = 'provisional'
       returning recommendation_id, organization_id, athlete_id, source_formula_result_id, recommendation_text, expected_outcome, status, created_by_account_id, created_at, expires_at, decided_by_account_id, decided_at`,
      [input.organizationId, input.recommendationId, input.decision, input.decidedByAccountId, input.athleteId],
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
      afterState: { status: row.status, ...onFile },
    });

    return row;
  });
}
