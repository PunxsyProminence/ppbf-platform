import { query, withTransaction } from './db';
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

// Human-flagged only in this pass. A system-detected heuristic (e.g. an
// acute:chronic contact-exposure ratio crossing a threshold with no
// decision on file) is a real product decision -- what ratio, what window --
// that shouldn't be invented as a side effect of this module; it's
// deliberately out of scope, not an oversight.
export async function flagNearMiss(input: {
  organizationId: string;
  athleteId: string;
  decisionId?: string | null;
  description: string;
  severity: ShadowNearMissSeverity;
  detectedByAccountId: string;
  detectedByRole: string;
  metadata?: Record<string, unknown>;
}): Promise<ShadowNearMissRow> {
  return withTransaction(async (client) => {
    const result = await client.query<ShadowNearMissRow>(
      `insert into pilot.shadow_near_misses
       (organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata)
       values ($1,$2,$3,$4,$5,'human',$6,$7::jsonb)
       returning near_miss_id, organization_id, athlete_id, decision_id, description, severity, detected_by, detected_by_account_id, metadata, created_at`,
      [
        input.organizationId,
        input.athleteId,
        input.decisionId ?? null,
        input.description,
        input.severity,
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
