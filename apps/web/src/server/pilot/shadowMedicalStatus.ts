import { queryOne, withTransaction } from './db';
import { writeShadowAuditEntry } from './shadowAuditEntries';

export type MedicalAdministrativeStatusValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';

/**
 * The label every reader uses for a clearance whose `expires_at` has passed.
 *
 * Deliberately NOT a member of MedicalAdministrativeStatusValue: nothing writes
 * this string, no row ever stores it, and the table's CHECK constraint would
 * reject it. It is a derived reading of a stored 'cleared' row, in the same way
 * 'no_record' is a derived reading of no row at all.
 */
export const EXPIRED_CLEARANCE_STATUS = 'cleared_expired';

/** Derived reading of no row at all, matching the vocabulary the gates report. */
export const NO_CLEARANCE_RECORD_STATUS = 'no_record';

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
  /**
   * When this record stops counting as current, or null for "no stated expiry".
   *
   * Null is not a hedge, it is the only honest default available here. How long
   * a youth contact-sport medical clearance stays valid is an open research
   * question in this repository, not a coding decision -- see
   * docs/HANDOFF_RESEARCH.md item 1, which lists "renewal and expiry intervals
   * per instrument, and what 'lapsed' should mean operationally" as work still
   * needing sourced answers, under the standing rule "do not close any item
   * below by picking a plausible number." A default interval invented here
   * would be a fabricated clinical constant enforced against real children.
   *
   * TODO(owner): confirm the clinical validity window for a medical clearance
   * (and whether it differs by clearance instrument). Once that answer exists
   * with a citation, the decisions it unblocks are (a) a default applied when
   * the recorder states none and (b) what to do about rows already on file.
   * Until then a null expiry keeps today's behaviour exactly: no automatic
   * timeout, re-confirmation is a human act.
   */
  expires_at: string | null;
  created_at: string;
}

/**
 * Whether this record is a clearance that is in force right now.
 *
 * The one place the "is this athlete cleared" question is answered, so the time
 * bound cannot be honoured by one gate and forgotten by another. Both readers
 * call it: contactClearanceGate.ts (contact logged without a clearance) and
 * shadowRecommendations.ts#assertMedicalStatusAllowsRecommendation (which
 * shadowDecisions.ts also routes through).
 *
 * Fail closed on every axis: no row is not a clearance, any status other than
 * 'cleared' is not a clearance, and a 'cleared' row past its stated expiry is
 * not a clearance. An unparseable expiry is treated as expired rather than
 * ignored -- a corrupt time bound must not read as "no time bound".
 */
export function isClearanceCurrent(
  row: ShadowMedicalAdministrativeStatusRow | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!row || row.status !== 'cleared') {
    return false;
  }
  if (row.expires_at === null || row.expires_at === undefined) {
    // No stated expiry: unchanged from the behaviour before expiry existed.
    // See the TODO on expires_at above -- this is the parked question, not an
    // omission.
    return true;
  }
  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAt)) {
    return false;
  }
  return expiresAt > now.getTime();
}

/**
 * What a gate should report this athlete's clearance state as.
 *
 * Returns the stored status for everything except a lapsed clearance, which
 * reports as EXPIRED_CLEARANCE_STATUS so a reviewer reading a near miss can
 * tell "nobody ever decided" (`no_record`/`pending`) apart from "somebody did
 * decide and it ran out".
 *
 * Only 'cleared' is downgraded by expiry, and that asymmetry is deliberate: a
 * lapsed 'restricted' or 'not_cleared' row must keep restricting until a human
 * writes a new record, because letting a restriction expire itself into
 * permission is the exact failure this module exists to prevent.
 */
export function effectiveMedicalStatus(
  row: ShadowMedicalAdministrativeStatusRow | null | undefined,
  now: Date = new Date(),
): string {
  if (!row) {
    return NO_CLEARANCE_RECORD_STATUS;
  }
  if (row.status === 'cleared' && !isClearanceCurrent(row, now)) {
    return EXPIRED_CLEARANCE_STATUS;
  }
  return row.status;
}

// The ONLY write path for this table. Never import this function from
// shadowRecommendations.ts / shadowDecisions.ts -- those modules must only
// ever call getLatestMedicalAdministrativeStatus() below. This is what
// makes MedicalAdministrativeStatus a read-only gate to recommendation
// logic rather than something a recommendation could influence.
//
// Callers must run assertShadowAuthority first: this write decides whether a
// child may take contact, and shadowAuthority.ts's forbidden-action list names
// clearance actions explicitly. medical-status/route.ts is the only caller.
export async function setMedicalAdministrativeStatus(input: {
  organizationId: string;
  athleteId: string;
  status: MedicalAdministrativeStatusValue;
  restrictionFlags?: Record<string, unknown>;
  sourceReference?: string | null;
  /**
   * ISO timestamp after which this record stops counting as current, or null
   * for "no stated expiry". Never defaulted to a computed interval here -- see
   * the TODO on ShadowMedicalAdministrativeStatusRow.expires_at.
   */
  expiresAt?: string | null;
  setByAccountId: string;
  setByRole: string;
}): Promise<ShadowMedicalAdministrativeStatusRow> {
  return withTransaction(async (client) => {
    const result = await client.query<ShadowMedicalAdministrativeStatusRow>(
      `insert into pilot.shadow_medical_administrative_status
       (organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, expires_at)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::timestamptz)
       returning status_id, organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at, expires_at::text, created_at`,
      [
        input.organizationId,
        input.athleteId,
        input.status,
        JSON.stringify(input.restrictionFlags ?? {}),
        input.sourceReference ?? null,
        input.setByAccountId,
        input.setByRole,
        input.expiresAt ?? null,
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
      // expiresAt is part of the audited state: "cleared until March" and
      // "cleared indefinitely" are different decisions by the same person.
      afterState: { status: row.status, athleteId: row.athlete_id, expiresAt: row.expires_at },
    });

    return row;
  });
}

// Read-only. Safe to import from anywhere, including recommendation/
// decision logic -- it can only ever observe the latest status, never
// change it.
//
// Returns the row as stored, expired or not. Callers must not compare
// `.status` to 'cleared' themselves: use isClearanceCurrent /
// effectiveMedicalStatus above, which apply the time bound. The raw row is
// still returned because a display surface needs to show a lapsed clearance
// and who recorded it, not pretend it never existed.
export async function getLatestMedicalAdministrativeStatus(
  organizationId: string,
  athleteId: string,
): Promise<ShadowMedicalAdministrativeStatusRow | null> {
  return queryOne<ShadowMedicalAdministrativeStatusRow>(
    `select status_id, organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at, expires_at::text, created_at
     from pilot.shadow_medical_administrative_status
     where organization_id = $1 and athlete_id = $2
     order by effective_at desc
     limit 1`,
    [organizationId, athleteId],
  );
}
