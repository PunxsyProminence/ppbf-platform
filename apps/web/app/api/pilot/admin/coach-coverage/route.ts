import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { jsonError, requireMicrosoftAuthenticatedPrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// T-002's "minimal way to grant coverage": an admin-only API surface with no
// UI -- the ticket explicitly allows cutting the UI at this size, and this
// PR does. Granting is deliberately privileged (Microsoft-authenticated
// organization_admin/admin): a coverage grant hands a coach access to a
// child's athlete-scoped records, which is an authority decision, not a
// convenience toggle. The schema's granted_by_role admits 'coach' so a
// future regular-coach handoff is a route change, not a migration -- but
// today the route does not offer it.
//
// A grant is capped at 14 days. Coverage is temporary by definition; an
// open-ended grant is a permanent reassignment wearing coverage's clothes,
// and permanent reassignment already has a real path (updating the
// athlete's coach_id) that this table must not quietly replace.
const MAX_COVERAGE_DAYS = 14;

export async function GET(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const rows = await query(
      `select coverage_id, athlete_id, covering_coach_account_id,
              granted_by_account_id, granted_by_role, reason,
              starts_at::text, expires_at::text, revoked_at::text, revoked_by_account_id,
              created_at::text,
              (revoked_at is null and starts_at <= now() and expires_at > now()) as is_active
       from pilot.coach_coverage
       where organization_id = $1
       order by created_at desc
       limit 200`,
      [principal.organizationId],
    );

    return NextResponse.json({ ok: true, coverage: rows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json()) as {
      athlete_id?: string;
      covering_coach_account_id?: string;
      expires_at?: string;
      starts_at?: string;
      reason?: string;
    };

    const athleteId = body.athlete_id?.trim();
    if (!athleteId) throw new Error('Missing athlete_id');
    const coveringCoachAccountId = body.covering_coach_account_id?.trim();
    if (!coveringCoachAccountId) throw new Error('Missing covering_coach_account_id');
    if (!body.expires_at || Number.isNaN(Date.parse(body.expires_at))) {
      throw new Error('Missing expires_at: must be a valid date string');
    }
    if (body.starts_at !== undefined && Number.isNaN(Date.parse(body.starts_at))) {
      throw new Error('Unsupported starts_at: must be a valid date string');
    }

    const startsAt = body.starts_at ? new Date(body.starts_at) : new Date();
    const expiresAt = new Date(body.expires_at);
    const now = Date.now();

    if (expiresAt.getTime() <= now) {
      throw new Error('Unsupported expires_at: must be in the future');
    }
    if (expiresAt.getTime() <= startsAt.getTime()) {
      throw new Error('Unsupported expires_at: must be after starts_at');
    }
    if (expiresAt.getTime() - now > MAX_COVERAGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new Error(
        `Unsupported expires_at: coverage is capped at ${MAX_COVERAGE_DAYS} days -- a longer arrangement is a coach reassignment, not coverage`,
      );
    }

    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    // The grantee must be a real, active coach in THIS organization. Without
    // this, a typo'd account id would mint a grant nobody can use -- or
    // worse, one a non-coach account could.
    const coachRow = await queryOne<{ account_id: string }>(
      `select account_id from pilot.accounts
       where account_id = $1 and organization_id = $2 and role = 'coach' and active_flag = true`,
      [coveringCoachAccountId, principal.organizationId],
    );
    if (!coachRow) {
      throw new Error('Missing coach account: covering_coach_account_id is not an active coach in this organization');
    }

    const coverageId = randomUUID();
    await query(
      `insert into pilot.coach_coverage (
         organization_id, coverage_id, athlete_id, covering_coach_account_id,
         granted_by_account_id, granted_by_role, reason, starts_at, expires_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        principal.organizationId,
        coverageId,
        athleteId,
        coveringCoachAccountId,
        principal.accountId,
        principal.role,
        typeof body.reason === 'string' ? body.reason.trim() : '',
        startsAt.toISOString(),
        expiresAt.toISOString(),
      ],
    );

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_coverage',
      entity_id: coverageId,
      details: {
        athlete_id: athleteId,
        covering_coach_account_id: coveringCoachAccountId,
        starts_at: startsAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      },
    });

    return NextResponse.json({ ok: true, coverage_id: coverageId });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin', 'admin']);

    const body = (await request.json()) as { coverage_id?: string };
    const coverageId = body.coverage_id?.trim();
    if (!coverageId) throw new Error('Missing coverage_id');

    // Guarded in the UPDATE itself (the escalation-ladder lesson): revoking
    // an already-revoked grant must not overwrite who revoked it first.
    const revoked = await queryOne<{ coverage_id: string }>(
      `update pilot.coach_coverage
       set revoked_at = now(), revoked_by_account_id = $3
       where organization_id = $1 and coverage_id = $2 and revoked_at is null
       returning coverage_id`,
      [principal.organizationId, coverageId, principal.accountId],
    );

    if (!revoked) {
      const existing = await queryOne<{ coverage_id: string }>(
        `select coverage_id from pilot.coach_coverage
         where organization_id = $1 and coverage_id = $2`,
        [principal.organizationId, coverageId],
      );
      if (!existing) throw new Error('Missing coverage record');
      throw new Error('Unsupported transition: coverage is already revoked');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_coverage',
      entity_id: coverageId,
      details: { action: 'revoked' },
    });

    return NextResponse.json({ ok: true, coverage_id: coverageId });
  } catch (error) {
    return jsonError(error);
  }
}
