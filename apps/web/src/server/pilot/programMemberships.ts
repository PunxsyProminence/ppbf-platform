import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, queryOne } from './db';

// Program memberships with scholarship-as-discount. The payment slot's rule,
// made a stored fact: a scholarship is a DISCOUNT PERCENTAGE on a real
// membership row (100 = full scholarship), never a bypass. When charging
// arrives it reads this table; nothing here bills anyone.
//
// Safeguarding boundary inherited from the migration: membership rows hold
// the athlete LINK only; names join through the org-scoped athlete record.
// Admin-only in both directions -- enrollment and scholarship decisions are
// administrative records about families, not floor data.

export const MEMBERSHIP_ROLES = ['organization_admin', 'admin'] as const;

export type MembershipStatus = 'active' | 'lapsed' | 'ended';

export const MEMBERSHIP_STATUSES: readonly MembershipStatus[] = ['active', 'lapsed', 'ended'];

// Forward and back between active and lapsed; ended is terminal -- a
// re-enrollment is a NEW row so the history of the old one survives.
const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  active: ['lapsed', 'ended'],
  lapsed: ['active', 'ended'],
  ended: [],
};

export interface MembershipRow {
  organization_id: string;
  membership_id: string;
  athlete_id: string;
  athlete_name: string;
  program_name: string;
  status: MembershipStatus;
  started_on: string;
  ended_on: string | null;
  scholarship_percent: number;
  scholarship_note: string;
  notes: string;
  created_at: string;
}

const FIELDS = `m.organization_id, m.membership_id, m.athlete_id,
  a.full_name as athlete_name, m.program_name, m.status,
  m.started_on::text as started_on, m.ended_on::text as ended_on,
  m.scholarship_percent, m.scholarship_note, m.notes, m.created_at`;

const FROM = `from pilot.program_memberships m
  join pilot.athletes a
    on a.organization_id = m.organization_id and a.athlete_id = m.athlete_id`;

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === 'string' && (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

export async function createMembership(input: {
  organizationId: string;
  athleteId: string;
  programName: string;
  startedOn: string;
  scholarshipPercent?: number;
  scholarshipNote?: string;
  notes?: string;
  createdByAccountId: string;
}): Promise<MembershipRow | null> {
  // The athlete lookup doubles as the tenancy check: an id from another
  // organization reads as "no such athlete" and the caller answers with a
  // hidden not-found.
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const membershipId = randomUUID();
  try {
    await queryOne(
      `insert into pilot.program_memberships
         (organization_id, membership_id, athlete_id, program_name, started_on,
          scholarship_percent, scholarship_note, notes, created_by_account_id)
       values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
       returning membership_id`,
      [
        input.organizationId,
        membershipId,
        input.athleteId,
        input.programName,
        input.startedOn,
        input.scholarshipPercent ?? 0,
        input.scholarshipNote ?? '',
        input.notes ?? '',
        input.createdByAccountId,
      ],
    );
  } catch (error) {
    if (error instanceof Error && /idx_program_memberships_one_active/.test(error.message)) {
      throw new Error('MEMBERSHIP_DUPLICATE_ACTIVE: athlete already has an active membership in this program');
    }
    throw error;
  }

  return queryOne<MembershipRow>(
    `select ${FIELDS} ${FROM}
     where m.organization_id = $1 and m.membership_id = $2`,
    [input.organizationId, membershipId],
  );
}

/** Live memberships first, then by program and name. */
export async function listMemberships(organizationId: string): Promise<MembershipRow[]> {
  return query<MembershipRow>(
    `select ${FIELDS} ${FROM}
     where m.organization_id = $1
     order by (m.status = 'ended') asc, m.program_name asc, a.full_name asc`,
    [organizationId],
  );
}

export async function setMembershipStatus(input: {
  organizationId: string;
  membershipId: string;
  status: MembershipStatus;
}): Promise<MembershipRow | null> {
  const current = await queryOne<{ status: MembershipStatus }>(
    `select status from pilot.program_memberships
     where organization_id = $1 and membership_id = $2`,
    [input.organizationId, input.membershipId],
  );
  if (!current) return null;

  if (current.status !== input.status && !MEMBERSHIP_TRANSITIONS[current.status].includes(input.status)) {
    throw new Error(`Invalid status transition: ${current.status} -> ${input.status}`);
  }

  await queryOne(
    `update pilot.program_memberships
     set status = $3,
         -- greatest(): ending a membership that has not started yet stamps
         -- the start date, not a date before it -- the constraint refuses an
         -- end before the beginning, and so does sense.
         ended_on = case when $3 = 'ended' then coalesce(ended_on, greatest(current_date, started_on)) else null end,
         updated_at = now()
     where organization_id = $1 and membership_id = $2
     returning membership_id`,
    [input.organizationId, input.membershipId, input.status],
  );

  return queryOne<MembershipRow>(
    `select ${FIELDS} ${FROM}
     where m.organization_id = $1 and m.membership_id = $2`,
    [input.organizationId, input.membershipId],
  );
}

export interface MembershipFlag {
  membership_id: string;
  program_name: string;
  status: MembershipStatus;
}

/**
 * Non-active (lapsed/ended) memberships for one athlete -- the read the
 * class-registration flow was missing entirely (capability-network audit:
 * membership status was read only by this module and its own admin page,
 * nowhere near registration). Deliberately informational, never a gate:
 * unlike a training hold's STOP, a lapsed/ended membership is a
 * billing/enrollment fact (this migration's own header: "WHAT THIS
 * DELIBERATELY IS NOT: billing"), not a safety fact, and product policy on
 * whether it should ever block is an explicit open question for the owner.
 * Per the owner's standing default for an ambiguous product-policy call,
 * this rides along as a non-blocking flag on a successful registration so a
 * coach/admin can see it and follow up with the family -- it never refuses
 * the registration itself.
 *
 * An athlete can hold several memberships across different programs (one
 * per program is enforced live; history rows coexist), and classes carry no
 * program of their own (same "classes are untyped" fact trainingHolds.ts
 * documents for holds), so this returns every non-active membership on
 * record rather than trying to match one program to the class.
 *
 * Reads inside the caller's transaction when given a client (the same
 * consistency point as the registration write, and the same SAVEPOINT
 * guard findRegistrationBlockingHold uses: a bare 42P01 mid-transaction
 * would otherwise leave the enclosing BEGIN block aborted for every
 * statement after it); a bare pool query otherwise. A missing table
 * (pre-migration window) degrades to "nothing to flag", never a 500 on the
 * registration path.
 */
export async function listMembershipFlagsForAthlete(
  organizationId: string,
  athleteId: string,
  client?: PoolClient,
): Promise<MembershipFlag[]> {
  const sql = `select membership_id, program_name, status
     from pilot.program_memberships
     where organization_id = $1 and athlete_id = $2 and status <> 'active'
     order by program_name asc`;
  const params = [organizationId, athleteId];

  if (client) {
    await client.query('SAVEPOINT membership_flag_probe');
    try {
      const result = await client.query<MembershipFlag>(sql, params);
      await client.query('RELEASE SAVEPOINT membership_flag_probe');
      return result.rows;
    } catch (error) {
      if ((error as { code?: unknown }).code !== '42P01') {
        throw error;
      }
      await client.query('ROLLBACK TO SAVEPOINT membership_flag_probe');
      return [];
    }
  }

  try {
    return await query<MembershipFlag>(sql, params);
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P01') {
      throw error;
    }
    return [];
  }
}

/** Scholarship is a stored discount on the membership, 0-100. Setting it is
 * an explicit administrative act with an optional note about the basis. */
export async function setMembershipScholarship(input: {
  organizationId: string;
  membershipId: string;
  scholarshipPercent: number;
  scholarshipNote?: string;
}): Promise<MembershipRow | null> {
  const row = await queryOne<{ membership_id: string }>(
    `update pilot.program_memberships
     set scholarship_percent = $3,
         scholarship_note = coalesce($4, scholarship_note),
         updated_at = now()
     where organization_id = $1 and membership_id = $2
     returning membership_id`,
    [input.organizationId, input.membershipId, input.scholarshipPercent, input.scholarshipNote ?? null],
  );
  if (!row) return null;

  return queryOne<MembershipRow>(
    `select ${FIELDS} ${FROM}
     where m.organization_id = $1 and m.membership_id = $2`,
    [input.organizationId, input.membershipId],
  );
}
