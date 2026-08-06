import { query, withTransaction } from './db';
import { fileEscalation, shouldAutoEscalateNearMiss } from './escalationLadder';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type ShadowNearMissSeverity = 'low' | 'moderate' | 'high' | 'critical';

export interface ShadowNearMissRow {
  near_miss_id: string;
  organization_id: string;
  athlete_id: string;
  decision_id: string | null;
  description: string;
  severity: ShadowNearMissSeverity;
  detected_by: 'system' | 'human';
  detected_by_account_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Records a near miss for coach/admin review.
 *
 * `detectedBy` defaults to 'human', which is how every caller before the
 * contact-clearance gate used this: a person noticing something and flagging it.
 * The gate passes 'system' -- it is a deterministic rule (contact logged for an
 * athlete with no current medical clearance), not a heuristic, so it does not
 * carry the "what threshold, what window" product question that kept
 * system-detected flagging out of this module originally.
 *
 * `detected_by_account_id` is still the submitting account even for a system
 * detection: knowing who filed the observation that tripped the rule is the
 * useful provenance, and the column is nullable rather than required.
 */
export async function flagNearMiss(input: {
  organizationId: string;
  athleteId: string;
  decisionId?: string | null;
  description: string;
  severity: ShadowNearMissSeverity;
  detectedByAccountId: string;
  detectedByRole: string;
  detectedBy?: 'system' | 'human';
  metadata?: Record<string, unknown>;
}): Promise<ShadowNearMissRow> {
  return withTransaction(async (client) => {
    const result = await client.query<ShadowNearMissRow>(
      `insert into pilot.shadow_near_misses
       (organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       returning near_miss_id, organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata, created_at`,
      [
        input.organizationId,
        input.athleteId,
        input.decisionId ?? null,
        input.description,
        input.severity,
        input.detectedBy ?? 'human',
        input.detectedByAccountId,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to record SHADOW near miss.');
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'near_miss',
      entityId: row.near_miss_id,
      action: 'flagged',
      actorAccountId: input.detectedByAccountId,
      actorRole: input.detectedByRole,
      afterState: { severity: row.severity, decisionId: row.decision_id },
    });

    // High/critical near misses escalate automatically -- see
    // escalationLadder.ts's module doc for why this is the one chokepoint
    // both contactClearanceGate.ts and painReportAlert.ts flow through, and
    // why 'low'/'moderate' stay pull-only rather than escalating every near
    // miss into noise. Same transaction as the near-miss insert above: one
    // severe enough to escalate must never commit without its escalation.
    if (shouldAutoEscalateNearMiss(row.severity)) {
      await fileEscalation(
        {
          organizationId: input.organizationId,
          sourceType: 'near_miss',
          sourceId: row.near_miss_id,
          athleteId: row.athlete_id,
          severity: row.severity,
          reason: row.description,
          triggeredBy: 'system',
          triggeredByAccountId: input.detectedByAccountId,
          triggeredByRole: input.detectedByRole,
          metadata: { near_miss_id: row.near_miss_id, trigger: (row.metadata as { trigger?: string } | null)?.trigger },
        },
        client,
      );
    }

    return row;
  });
}

export async function listNearMisses(organizationId: string, athleteId: string): Promise<ShadowNearMissRow[]> {
  return query<ShadowNearMissRow>(
    `select near_miss_id, organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata, created_at
     from pilot.shadow_near_misses
     where organization_id = $1 and athlete_id = $2
     order by created_at desc`,
    [organizationId, athleteId],
  );
}

/**
 * The generation path's read: recent near misses for the athlete a chat turn
 * is about, severity-first so a critical event cannot be pushed out of a
 * capped list by newer low-severity ones. Bounded window and count because
 * this feeds a model prompt, not a report -- the full history stays on the
 * near-misses API.
 */
export async function listRecentNearMisses(
  organizationId: string,
  athleteId: string,
  options: { windowDays?: number; limit?: number } = {},
): Promise<ShadowNearMissRow[]> {
  const windowDays = Math.min(365, Math.max(1, Math.trunc(options.windowDays ?? 90)));
  const limit = Math.min(10, Math.max(1, Math.trunc(options.limit ?? 5)));
  return query<ShadowNearMissRow>(
    `select near_miss_id, organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata, created_at
     from pilot.shadow_near_misses
     where organization_id = $1
       and athlete_id = $2
       and created_at > now() - ($3 * interval '1 day')
     order by
       case severity
         when 'critical' then 0
         when 'high' then 1
         when 'moderate' then 2
         else 3
       end asc,
       created_at desc
     limit $4`,
    [organizationId, athleteId, windowDays, limit],
  );
}
