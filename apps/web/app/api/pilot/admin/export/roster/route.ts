import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query } from '@/src/server/pilot/db';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

import { ROSTER_EXPORT_COLUMNS, buildRosterCsv, rosterExportFilename, type RosterExportRow } from './csv';

export const runtime = 'nodejs';

/**
 * One row per athlete in the caller's own gym.
 *
 * organization_id is the only parameter and it comes from the session, never
 * from the request, so there is no shape of query string that reaches another
 * gym's rows. Every join carries the organization forward rather than matching
 * on the athlete or parent id alone -- two gyms can legitimately both use
 * "ath-001", and a join that forgot the organization would hand one gym the
 * other's guardian.
 *
 * NOTHING HERE READS pilot.accounts.pin_hash, pilot.accounts.must_change_pin,
 * OR pilot.session_tokens. The athlete's sign-in id is included because an
 * admin reconstructing a roster elsewhere needs it; the credential on that id
 * is not this file's business and must never be.
 *
 * Timestamps are rendered in UTC by the database rather than by the server's
 * locale, so the same export is byte-identical wherever it is produced.
 */
const ROSTER_QUERY = `
  select
    ath.athlete_id,
    ath.full_name,
    to_char(ath.dob, 'YYYY-MM-DD') as date_of_birth,
    ath.weight_class,
    ath.gym_status,
    ath.active_flag as active,
    ath.coach_id as coach_account_id,
    coach.login_email as coach_email,
    ath.emergency_contact as emergency_contact_note,
    contact.full_name as emergency_contact_name,
    contact.relationship_to_athlete as emergency_contact_relationship,
    contact.phone as emergency_contact_phone,
    contact.email as emergency_contact_email,
    guardian.guardian_count,
    guardian.guardians,
    login.account_id as athlete_login_id,
    login.active_flag as athlete_login_active,
    -- Same formula as attendanceReporting.ts#computeAttendanceRate: present /
    -- (present + absent), rounded to 3 places, null (not 0) when there is
    -- nothing to compute a rate from yet. Excused marks are not counted
    -- against the rate. Computed here rather than by calling that module, so
    -- the export stays the single query this file's own tests pin it to.
    case
      when coalesce(attend.present_count, 0) + coalesce(attend.absent_count, 0) = 0 then null
      else round(attend.present_count::numeric / (attend.present_count + attend.absent_count), 3)
    end as attendance_rate,
    to_char(ath.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
    to_char(ath.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
  from pilot.athletes ath
  left join pilot.accounts coach
    on coach.account_id = ath.coach_id
   and coach.organization_id = ath.organization_id
  left join pilot.accounts login
    on login.organization_id = ath.organization_id
   and login.athlete_id = ath.athlete_id
   and login.role = 'athlete'
  left join lateral (
    select c.full_name, c.relationship_to_athlete, c.phone, c.email
    from pilot.emergency_contacts c
    where c.organization_id = ath.organization_id
      and c.athlete_id = ath.athlete_id
    order by c.is_primary desc, c.created_at asc
    limit 1
  ) contact on true
  left join lateral (
    select
      count(*)::int as guardian_count,
      string_agg(
        p.full_name
          || ' (' || gl.relationship_to_athlete || ')'
          || coalesce(' ' || nullif(p.phone, ''), '')
          || coalesce(' ' || nullif(p.email, ''), ''),
        '; ' order by p.full_name
      ) as guardians
    from pilot.guardian_links gl
    join pilot.parents p
      on p.organization_id = gl.organization_id
     and p.parent_id = gl.parent_id
    where gl.organization_id = ath.organization_id
      and gl.athlete_id = ath.athlete_id
  ) guardian on true
  -- Only marks backed by a live registration count -- same guard
  -- getOrganizationAttendanceSummary uses, so a mark that predates that
  -- enforcement (or one for a class the athlete was never on the roster
  -- for) cannot inflate the exported rate beyond what the dashboard shows
  -- for the same athlete.
  left join lateral (
    select
      count(*) filter (where sa.status = 'present') as present_count,
      count(*) filter (where sa.status = 'absent') as absent_count
    from pilot.scheduler_attendance sa
    join pilot.scheduler_classes sc
      on sc.organization_id = sa.organization_id and sc.class_id = sa.class_id
    join pilot.scheduler_registrations sr
      on sr.organization_id = sa.organization_id
      and sr.class_id = sa.class_id
      and sr.athlete_id = sa.athlete_id
      and sr.status = 'registered'
    where sa.organization_id = ath.organization_id
      and sa.athlete_id = ath.athlete_id
  ) attend on true
  where ath.organization_id = $1
  order by ath.full_name asc, ath.athlete_id asc
`;

/**
 * Downloads the caller's own gym roster as CSV.
 *
 * ORGANIZATION ADMIN ONLY, deliberately excluding platform_owner. access.ts
 * states that the platform owner cannot reach organization-private athlete
 * records, and a whole-roster download is the strongest form of that access
 * there is. The platform owner provisions gyms; they do not take a gym's
 * children home in a spreadsheet.
 *
 * AUDITED BEFORE THE FILE IS RETURNED. A data export is exactly the act
 * somebody asks about months later, so if the audit row cannot be written the
 * export does not happen -- the request fails instead. 'create' is the event
 * type because the vocabulary in auditEventTypes.ts is closed by a database
 * check constraint and a dedicated 'export' value needs its own migration;
 * entity_type 'roster_export' is what makes the row findable.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin']);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const rows = await query<RosterExportRow>(ROSTER_QUERY, [principal.organizationId]);
    const csv = buildRosterCsv(rows);
    const filename = rosterExportFilename(principal.organizationId, new Date());
    const exportId = randomUUID();

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'roster_export',
      entity_id: exportId,
      details: {
        format: 'csv',
        filename,
        athlete_row_count: rows.length,
        columns: ROSTER_EXPORT_COLUMNS.map((column) => column.key),
      },
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // The row count travels in a header so the page can say how many
        // athletes it downloaded without parsing the file it just saved.
        'X-Roster-Row-Count': String(rows.length),
        'X-Roster-Export-Id': exportId,
        // A roster of minors must not sit in a shared cache, and must not be
        // re-served from a browser's back-forward cache after a logout.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
