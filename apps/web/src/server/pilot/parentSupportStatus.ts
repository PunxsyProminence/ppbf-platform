import { query, queryOne } from './db';
import { NotFoundError } from './errors';
import { isGuardianLinkedToAthlete } from './guardianAccess';
import type { MembershipStatus } from './programMemberships';

// What a guardian is shown of their own child's membership, scholarship and
// community-support standing (PH-13), from pilot.program_memberships and
// pilot.family_support_records (PH-12/12b). Q-D A (Overwatch 2026-10-17): each
// program's standing with its dates; scholarship "yes" only when a percent is
// above 0, otherwise none recorded; recorded supports with their dates. No
// percent, no notes: scholarship_percent, scholarship_note and notes never
// leave the database here -- the percent is reduced to one boolean in SQL.
//
// Membership is enrollment standing, not payment (WO-PH-12/13 Q1 B), and
// nothing is inferred from payment, attendance, participation or eligibility:
// only stored rows are read. No row is "none recorded", never "none provided".
// No account id, no staff name, no email.

export type ScholarshipStatus = 'yes' | 'none_recorded';

export interface GuardianMembership {
  program_name: string;
  status: MembershipStatus;
  started_on: string;
  ended_on: string | null;
}

export interface GuardianSupport {
  support_kind: string;
  provided_on: string;
}

export interface GuardianSupportStatus {
  memberships: GuardianMembership[];
  scholarship: ScholarshipStatus;
  supports: GuardianSupport[];
}

// The same sentence for every child this guardian may not read here (another
// family's, 18 or older, deleted, another gym's): which reason it was is not
// theirs to learn.
export const NOT_YOUR_CHILD = 'Not found: that child is not on your page.';

/**
 * One child's standing, for the guardian signed in. The link is checked on
 * this request (isGuardianLinkedToAthlete: linked now, in this gym, under 18,
 * not deleted) before anything is read.
 */
export async function getSupportStatusForGuardian(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<GuardianSupportStatus> {
  if (!(await isGuardianLinkedToAthlete(organizationId, accountId, athleteId))) {
    throw new NotFoundError(NOT_YOUR_CHILD);
  }

  // Live programs first (active, then lapsed), then ended; newest start first.
  const memberships = await query<GuardianMembership>(
    `select program_name, status, to_char(started_on, 'YYYY-MM-DD') as started_on,
            to_char(ended_on, 'YYYY-MM-DD') as ended_on
       from pilot.program_memberships
      where organization_id = $1 and athlete_id = $2
      order by case status when 'active' then 0 when 'lapsed' then 1 else 2 end,
               started_on desc, program_name asc`,
    [organizationId, athleteId],
  );

  // WHICH MEMBERSHIPS COUNT: every membership that has not ended (active or
  // lapsed). A lapsed enrollment keeps its scholarship until the office ends
  // it; an ended membership's scholarship no longer applies, so it does not
  // make the answer "yes". The percent is reduced to a boolean here and never
  // leaves the database.
  const scholarship = await queryOne<{ has_scholarship: boolean }>(
    `select coalesce(bool_or(scholarship_percent > 0), false) as has_scholarship
       from pilot.program_memberships
      where organization_id = $1 and athlete_id = $2 and status <> 'ended'`,
    [organizationId, athleteId],
  );

  // Live (not retired) records only, the most recent first.
  const supports = await query<GuardianSupport>(
    `select support_kind, to_char(provided_on, 'YYYY-MM-DD') as provided_on
       from pilot.family_support_records
      where organization_id = $1 and athlete_id = $2 and retired_at is null
      order by provided_on desc, created_at desc`,
    [organizationId, athleteId],
  );

  return {
    memberships: memberships.map(({ program_name, status, started_on, ended_on }) => ({
      program_name,
      status,
      started_on,
      ended_on,
    })),
    scholarship: scholarship?.has_scholarship === true ? 'yes' : 'none_recorded',
    supports: supports.map(({ support_kind, provided_on }) => ({ support_kind, provided_on })),
  };
}
