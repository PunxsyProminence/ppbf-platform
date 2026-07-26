import { queryOne, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type MedicalAdministrativeStatusValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';

export interface ShadowMedicalAdministrativeStatusRow {
  status_id: string;
  organization_id: string;
  athlete_id: string;
  status: MedicalAdministrativeStatusValue;
  restriction_flags: Record<string, unknown>;
  source_reference: string | null;
  set_by_account_id: string;
  set_by_role: string;
  effective_at: string;
  created_at: string;
}

// The ONLY write path for this table. Never import this function from
// shadowRecommendations.ts / shadowDecisions.ts -- those modules must only
// ever call getLatestMedicalAdministrativeStatus() below. This is what
// makes MedicalAdministrativeStatus a read-only gate to recommendation
// logic rather than something a recommendation could influence.
export async function setMedicalAdministrativeStatus(input: {
  organizationId: string;
  athleteId: string;
  status: MedicalAdministrativeStatusValue;
  restrictionFlags?: Record<string, unknown>;
  sourceReference?: string | null;
  setByAccountId: string;
  setByRole: string;
}): Promise<ShadowMedicalAdministrativeStatusRow> {
  return withTransaction(async (client) => {
    const result = await client.query<ShadowMedicalAdministrativeStatusRow>(
      `insert into pilot.shadow_medical_administrative_status
       (organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7)
       returning status_id, organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at, created_at`,
      [
        input.organizationId,
        input.athleteId,
        input.status,
        JSON.stringify(input.restrictionFlags ?? {}),
        input.sourceReference ?? null,
        input.setByAccountId,
        input.setByRole,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Unable to record medical administrative status.');
    }

    await writeShadowAuditEntry(client, {
      organizationId: input.organizationId,
      entityType: 'medical_status',
      entityId: row.status_id,
      action: 'set_status',
      actorAccountId: input.setByAccountId,
      actorRole: input.setByRole,
      afterState: { status: row.status, athleteId: row.athlete_id },
    });

    return row;
  });
}

// Read-only. Safe to import from anywhere, including recommendation/
// decision logic -- it can only ever observe the latest status, never
// change it.
export async function getLatestMedicalAdministrativeStatus(
  organizationId: string,
  athleteId: string,
): Promise<ShadowMedicalAdministrativeStatusRow | null> {
  return queryOne<ShadowMedicalAdministrativeStatusRow>(
    `select status_id, organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at, created_at
     from pilot.shadow_medical_administrative_status
     where organization_id = $1 and athlete_id = $2
     order by effective_at desc
     limit 1`,
    [organizationId, athleteId],
  );
}
