import { query, queryOne, withTransaction } from './db';
import {
  EXPIRED_CLEARANCE_STATUS,
  effectiveMedicalStatus,
  getLatestMedicalAdministrativeStatus,
  isClearanceCurrent,
} from './shadowMedicalStatus';
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

function blockedMessage(status: string): string {
  if (status === 'no_record') {
    return "Blocked: this athlete has no medical administrative status on file yet. A medically sensitive decision requires an explicit 'cleared' status -- set one in the Medical Status panel before recording this decision.";
  }
  // A lapsed clearance needs its own sentence. "your status is
  // 'cleared_expired', not 'cleared'" would read as a bug to the coach, and the
  // action it calls for is different: not "decide", but "re-confirm".
  if (status === EXPIRED_CLEARANCE_STATUS) {
    return "Blocked: this athlete's medical clearance has passed its stated expiry, so it no longer counts as current. Record a new 'cleared' status in the Medical Status panel once the clearance has been re-confirmed.";
  }
  return `Blocked: this athlete's medical administrative status is '${status}', not 'cleared'. Set status to 'cleared' in the Medical Status panel before recording this decision, or leave it as-is if the athlete should not yet participate.`;
}

export class MedicalStatusBlockedError extends Error {
  constructor(readonly status: string) {
    super(blockedMessage(status));
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
  // Fail closed: only an explicit 'cleared' record that is still in force
  // allows a medically sensitive recommendation through. No record on file,
  // 'pending', 'restricted'/'not_cleared', and a clearance past its stated
  // expiry all block -- absence of a clearance decision is not itself a
  // clearance decision, and neither is a clearance that has run out.
  //
  // isClearanceCurrent is shared with contactClearanceGate.ts precisely so the
  // time bound cannot be enforced on one path and skipped on the other.
  const status = await getLatestMedicalAdministrativeStatus(organizationId, athleteId);
  if (!isClearanceCurrent(status)) {
    throw new MedicalStatusBlockedError(effectiveMedicalStatus(status));
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
}): Promise<ShadowRecommendationRow> {
  // Unconditional, and deliberately not a parameter.
  //
  // This guard used to run only when the caller passed isMedicallySensitive.
  // That flag arrived verbatim off the HTTP body behind a `typeof` check, with
  // `undefined` permitted -- so omitting one field from the JSON skipped the
  // clearance check entirely, on a return-to-play recommendation, in a youth
  // contact sport. A safety gate the caller decides to arm is not a gate.
  //
  // The alternative considered was deriving sensitivity server-side from the
  // recommendation text (shadowClassifier.ts already carries the vocabulary).
  // It was rejected as the primary control: a denylist decides by phrasing, and
  // "he took a bad shot Tuesday, is he good to spar?" matches none of those
  // patterns. Consulting the athlete's clearance record on every recommendation
  // depends on no vocabulary at all.
  //
  // The cost is that a recommendation cannot be written for an athlete with no
  // clearance record on file. That is the intended reading of the guard's own
  // rule -- absence of a decision is not a decision -- and setting a status is
  // ordinary onboarding, not a workaround.
  await assertMedicalStatusAllowsRecommendation(input.organizationId, input.athleteId);

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
      afterState: { status: row.status },
    });

    return row;
  });
}
