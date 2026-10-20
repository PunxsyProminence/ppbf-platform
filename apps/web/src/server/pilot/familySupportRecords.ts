import { staffDisplayNameFor } from '@/src/shared/coachDisplayName';
import { gymDayIso } from '@/src/lib/gymTime';

import { STAFF_AUTHOR_NAME_FLOOR } from './achievements';
import { query, queryOne } from './db';
import { accountDeletedSql } from './deletedAccountSignIn';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

// The office's record of support the gym gave a family (PH-12b, on PH-12's
// pilot.family_support_records): only what happened, no plans; support_kind is
// family-readable (PH-13). Org admins and admins of this gym record and retire
// (Q-E); the database re-checks the seat (a 403). Never edited or deleted.

export const SUPPORT_ROLES = ['organization_admin', 'admin'] as const;
type SupportRole = (typeof SUPPORT_ROLES)[number];

export const SUPPORT_KIND_MAX = 200;

export interface SupportActor {
  organizationId: string;
  accountId: string;
  role: string;
}

/** One live record as the office sees it: no account id, no email. */
export interface StaffSupportRow {
  record_id: string;
  support_kind: string;
  provided_on: string;
  recorded_by_name: string;
  created_at: string;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function supportRole(actor: SupportActor): SupportRole {
  const role = (SUPPORT_ROLES as readonly string[]).includes(actor.role) ? (actor.role as SupportRole) : null;
  if (!role) throw new ForbiddenError('Only an organization admin or admin records family support.');
  return role;
}

/** A real calendar day, written YYYY-MM-DD. */
function isRealDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The database's seat refusal is the caller's authority, not a server fault. */
function seatRefusal(error: unknown): never {
  const pg = error as { code?: unknown; constraint?: unknown };
  if (pg.code === '23514' && pg.constraint === 'pilot_family_support_records_writer_of_this_gym') {
    throw new ForbiddenError('Only an organization admin or admin of this gym records family support.');
  }
  if (pg.code === '23514' && pg.constraint === 'pilot_family_support_records_provided_past') {
    throw new ValidationError('The date provided cannot be in the future.');
  }
  if (pg.code === '23514' && pg.constraint === 'pilot_family_support_records_only_retired') {
    throw new ConflictError('This record is already retired.');
  }
  throw error;
}

/** Live records for one athlete of this gym, most recent provided_on first (then newest written, then record id, so the order is stable). */
export async function listSupportForStaff(organizationId: string, athleteId: string): Promise<StaffSupportRow[]> {
  // The recorder is named only while their account stands and they belong to
  // this gym (the rule achievements.ts names staff by); otherwise the floor.
  const rows = await query<Omit<StaffSupportRow, 'recorded_by_name'> & { recorder_email: string | null; recorder_display_name: string | null }>(
    `select r.record_id::text as record_id, r.support_kind, r.provided_on::text as provided_on,
            r.created_at::text as created_at, acc.login_email as recorder_email,
            ap.staff_display_name as recorder_display_name
       from pilot.family_support_records r
       join pilot.athletes ath
         on ath.organization_id = r.organization_id and ath.athlete_id = r.athlete_id and ath.deleted_at is null
       left join pilot.accounts acc
         on acc.account_id = r.recorded_by_account_id and not ${accountDeletedSql('acc')}
        and (acc.organization_id = r.organization_id or exists (
              select 1 from pilot.organization_memberships om
               where om.account_id = acc.account_id and om.organization_id = r.organization_id and om.active_flag))
       -- The name the gym typed (Q1 part B), only for a recorder the join above still names.
       left join pilot.account_profiles ap
         on acc.account_id is not null and ap.organization_id = r.organization_id and ap.account_id = acc.account_id
      where r.organization_id = $1 and r.athlete_id = $2 and r.retired_at is null
      order by r.provided_on desc, r.created_at desc, r.record_id`,
    [organizationId, athleteId],
  );
  return rows.map(({ recorder_email, recorder_display_name, ...row }) => ({
    ...row,
    recorded_by_name: staffDisplayNameFor(recorder_display_name, recorder_email) ?? STAFF_AUTHOR_NAME_FLOOR,
  }));
}

/**
 * Records support given. Returns null when the athlete is not a live athlete
 * of this gym (the caller answers with a hidden not-found).
 */
export async function recordSupport(
  actor: SupportActor,
  athleteId: string,
  supportKind: unknown,
  providedOn: unknown,
): Promise<{ record_id: string } | null> {
  const role = supportRole(actor);
  const kind = typeof supportKind === 'string' ? supportKind.trim() : '';
  if (kind.length < 1 || kind.length > SUPPORT_KIND_MAX) {
    throw new ValidationError(`Say what the gym provided, in 1 to ${SUPPORT_KIND_MAX} characters.`);
  }
  if (typeof providedOn !== 'string' || !isRealDate(providedOn)) {
    throw new ValidationError('provided_on must be a real date, YYYY-MM-DD.');
  }
  const today = gymDayIso();
  if (today && providedOn > today) {
    throw new ValidationError('The date provided cannot be in the future.');
  }

  // The live-athlete check and the insert are one statement: FOR SHARE waits out a
  // withdrawal in flight and then reads the row again, so an athlete withdrawn
  // while this runs gets no record (no row comes back, and the caller answers
  // not-found). A separate lookup first would let that withdrawal slip between.
  try {
    return await queryOne<{ record_id: string }>(
      `insert into pilot.family_support_records
         (organization_id, athlete_id, support_kind, provided_on, recorded_by_account_id, recorded_by_role)
       select ath.organization_id, ath.athlete_id, $3::text, $4::date, $5::text, $6::text
         from pilot.athletes ath
        where ath.organization_id = $1 and ath.athlete_id = $2 and ath.deleted_at is null
        for share
       returning record_id::text as record_id`,
      [actor.organizationId, athleteId, kind, providedOn, actor.accountId, role],
    );
  } catch (error) {
    return seatRefusal(error);
  }
}

/**
 * Retires a live record of this gym, naming who retired it. Returns null when
 * there is no such record in this gym, or its athlete is no longer a live
 * athlete here (the same hidden not-found the list gives).
 */
export async function retireSupport(actor: SupportActor, recordId: string): Promise<{ record_id: string } | null> {
  supportRole(actor);
  const current = await queryOne<{ retired: boolean }>(
    `select r.retired_at is not null as retired
       from pilot.family_support_records r
       join pilot.athletes ath
         on ath.organization_id = r.organization_id and ath.athlete_id = r.athlete_id and ath.deleted_at is null
      where r.organization_id = $1 and r.record_id = $2::uuid`,
    [actor.organizationId, recordId],
  );
  if (!current) return null;
  if (current.retired) throw new ConflictError('This record is already retired.');

  // The athlete's live check holds at the write, as in recordSupport: FOR SHARE waits
  // out a withdrawal in flight and reads the row again, so a record of an athlete
  // withdrawn while this runs is not retired.
  let retired: { record_id: string } | null;
  try {
    retired = await queryOne<{ record_id: string }>(
      `update pilot.family_support_records r
          set retired_by_account_id = $3
        where r.organization_id = $1 and r.record_id = $2::uuid and r.retired_at is null
          and exists (
            select 1 from pilot.athletes ath
             where ath.organization_id = r.organization_id and ath.athlete_id = r.athlete_id
               and ath.deleted_at is null
             for share)
        returning r.record_id::text as record_id`,
      [actor.organizationId, recordId, actor.accountId],
    );
  } catch (error) {
    return seatRefusal(error);
  }
  if (!retired) {
    // The record was live a moment ago. If its athlete was withdrawn since, it is the
    // same hidden not-found the list gives; otherwise another retire got there first.
    const athleteLive = await queryOne<{ live: boolean }>(
      `select true as live
         from pilot.family_support_records r
         join pilot.athletes ath
           on ath.organization_id = r.organization_id and ath.athlete_id = r.athlete_id and ath.deleted_at is null
        where r.organization_id = $1 and r.record_id = $2::uuid`,
      [actor.organizationId, recordId],
    );
    if (!athleteLive) return null;
    throw new ConflictError('This record is already retired.');
  }
  return retired;
}
