import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import {
  captureDataCollectionRequest,
  createDataCollectionRequest,
  declineDataCollectionRequest,
  getDataCollectionRequestAthleteId,
  listOpenDataCollectionRequests,
  type DataCollectionRequestKind,
} from '@/src/server/pilot/assessmentProtocols';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const QUEUE_ROLES = ['organization_admin', 'admin', 'coach'] as const;
const PERSON_REQUEST_ROLES = ['organization_admin', 'admin'] as const;

// A request that names only a person account -- no athlete -- is organization
// admin business (CL-A11, overwatch ruling A11 = a). Until this, every coach
// could list, capture and decline them, and the account was never checked
// against the organization: it can be a parent's or an athlete's login, so
// "not athlete-scoped" meant "open to every coach in the gym". No screen
// calls this route today, so no coach workflow loses anything.
async function assertPersonInOrganization(personAccountId: string, organizationId: string): Promise<void> {
  const member = await queryOne<{ found: number }>(
    `select 1 as found
     from pilot.organization_memberships m
     join pilot.accounts a on a.account_id = m.account_id
     where m.account_id = $1 and m.organization_id = $2 and m.active_flag = true
       and a.active_flag = true and not a.is_platform_owner`,
    [personAccountId, organizationId],
  );
  if (!member) {
    throw new ValidationError('person_account_id must be an active account in this organization.');
  }
}

/** An optional id field: absent, or a non-blank string. Anything else is the caller's to fix, not a 500. */
function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string.`);
  }
  return value.trim() || undefined;
}

// The open-request queue this migration exists to surface: a specific
// person, a specific thing to capture, and the capture mode. GET is the
// queue itself; PATCH is the one-tap capture path (camera/upload already
// happened client-side -- this call just records that it did, and what the
// evidence is).
//
// A request names a child and says what to capture about them, so the
// athlete_id on it is authorized per athlete (assertActorCanAccessAthlete),
// and the unfiltered queue is scoped to the athletes the caller may reach.
// Requests addressed only to a person account are for organization admins.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id')?.trim() || undefined;
    const personAccountId = searchParams.get('person_account_id')?.trim() || undefined;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);
    if (personAccountId) requireRole(principal, [...PERSON_REQUEST_ROLES]);
    const seesPersonRequests = isOrganizationAdminRole(principal.role);

    let requests = await listOpenDataCollectionRequests(principal.organizationId, {
      athleteId,
      personAccountId,
    });
    if (!athleteId) {
      const named = requests
        .map((row) => row.athlete_id)
        .filter((id): id is string => id !== null);
      const allowed = await accessibleAthleteIds(principal, named);
      requests = requests.filter((row) => (row.athlete_id === null ? seesPersonRequests : allowed.has(row.athlete_id)));
    }
    return NextResponse.json({ requests });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const body = (await request.json()) as {
      athlete_id?: string;
      person_account_id?: string;
      request_kind?: DataCollectionRequestKind;
      protocol_id?: string;
      protocol_version?: number;
      prompt_text?: string;
      reason_code?: string;
      capture_hint?: string;
      due_on?: string;
      priority?: 'low' | 'normal' | 'high';
    };

    if (!body.request_kind || !body.prompt_text?.trim() || !body.reason_code?.trim()) {
      throw new Error('Missing request_kind, prompt_text, or reason_code');
    }

    const athleteId = optionalId(body.athlete_id, 'athlete_id');
    const personAccountId = optionalId(body.person_account_id, 'person_account_id');
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);
    if (!athleteId) requireRole(principal, [...PERSON_REQUEST_ROLES]);
    if (personAccountId) await assertPersonInOrganization(personAccountId, principal.organizationId);

    const created = await createDataCollectionRequest({
      organizationId: principal.organizationId,
      athleteId,
      personAccountId,
      requestKind: body.request_kind,
      protocolId: body.protocol_id,
      protocolVersion: body.protocol_version,
      promptText: body.prompt_text.trim(),
      reasonCode: body.reason_code.trim(),
      captureHint: body.capture_hint,
      dueOn: body.due_on,
      priority: body.priority,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'data_collection_request',
      entity_id: created.request_id,
      details: { request_kind: created.request_kind, reason_code: created.reason_code },
    });

    return NextResponse.json({ ok: true, request: created });
  } catch (error) {
    return jsonError(error);
  }
}

// The one-tap capture path: a coach holding pads cannot type, so this call
// carries only what a photo/video upload flow already produced (media_ref)
// plus who is confirming it. captureDataCollectionRequest stamps
// captured_at and captured_by_account_id together -- see that function's
// own comment for why a status change alone is never enough.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      request_id?: string;
      media_ref?: string;
      resulting_assessment_id?: string;
    };
    const requestId = body.request_id?.trim() || '';
    if (!requestId) {
      throw new Error('Missing request_id');
    }


    // Authorize the request's athlete before mutating it. GET and POST already
    // gate per athlete; PATCH (capture) and DELETE (decline) act on a
    // client-supplied request_id and did not, so a coach could capture or
    // decline a data-collection request for a minor outside their care. A
    // request with a null athlete_id names only a person account and is for
    // organization admins (CL-A11).
    const owner = await getDataCollectionRequestAthleteId(principal.organizationId, requestId);
    if (!owner) {
      throw new Error('Not found');
    }
    if (owner.athlete_id) {
      await assertActorCanAccessAthlete(principal, owner.athlete_id);
    } else {
      requireRole(principal, [...PERSON_REQUEST_ROLES]);
    }

    // The evidence must be about the request's own athlete (CL-A11). The id
    // used to be stored as sent, so a capture could record another child's
    // assessment, or another gym's, as this one's. A request about a person
    // account has no athlete for an assessment to be about.
    // Lowercased: Postgres prints a uuid in lowercase, and the comparison is on text.
    const resultingAssessmentId = optionalId(body.resulting_assessment_id, 'resulting_assessment_id')?.toLowerCase();
    if (resultingAssessmentId) {
      if (!owner.athlete_id) {
        throw new ValidationError('A request about a person account takes no resulting_assessment_id.');
      }
      const assessment = await queryOne<{ found: number }>(
        `select 1 as found from pilot.assessments
         where organization_id = $1 and assessment_id::text = $2 and athlete_id = $3`,
        [principal.organizationId, resultingAssessmentId, owner.athlete_id],
      );
      if (!assessment) {
        throw new ValidationError("resulting_assessment_id must be an assessment of this request's athlete.");
      }
    }

    const captured = await captureDataCollectionRequest({
      organizationId: principal.organizationId,
      requestId,
      capturedByAccountId: principal.accountId,
      mediaRef: body.media_ref,
      resultingAssessmentId,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'data_collection_request',
      entity_id: requestId,
      details: { action: 'capture' },
    });

    return NextResponse.json({ ok: true, request: captured });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      request_id?: string;
      declined_reason?: string;
    };
    const requestId = body.request_id?.trim() || '';
    if (!requestId) {
      throw new Error('Missing request_id');
    }


    // Authorize the request's athlete before mutating it. GET and POST already
    // gate per athlete; PATCH (capture) and DELETE (decline) act on a
    // client-supplied request_id and did not, so a coach could capture or
    // decline a data-collection request for a minor outside their care. A
    // request with a null athlete_id names only a person account and is for
    // organization admins (CL-A11).
    const owner = await getDataCollectionRequestAthleteId(principal.organizationId, requestId);
    if (!owner) {
      throw new Error('Not found');
    }
    if (owner.athlete_id) {
      await assertActorCanAccessAthlete(principal, owner.athlete_id);
    } else {
      requireRole(principal, [...PERSON_REQUEST_ROLES]);
    }

    const declined = await declineDataCollectionRequest({
      organizationId: principal.organizationId,
      requestId,
      declinedReason: body.declined_reason ?? '',
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'data_collection_request',
      entity_id: requestId,
      details: { action: 'decline' },
    });

    return NextResponse.json({ ok: true, request: declined });
  } catch (error) {
    return jsonError(error);
  }
}
