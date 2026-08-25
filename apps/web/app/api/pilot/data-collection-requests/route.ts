import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  captureDataCollectionRequest,
  createDataCollectionRequest,
  declineDataCollectionRequest,
  getDataCollectionRequestAthleteId,
  listOpenDataCollectionRequests,
  type DataCollectionRequestKind,
} from '@/src/server/pilot/assessmentProtocols';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const QUEUE_ROLES = ['organization_admin', 'admin', 'coach'] as const;

// The open-request queue this migration exists to surface: a specific
// person, a specific thing to capture, and the capture mode. GET is the
// queue itself; PATCH is the one-tap capture path (camera/upload already
// happened client-side -- this call just records that it did, and what the
// evidence is).
//
// A request names a child and says what to capture about them, so the
// athlete_id on it is authorized per athlete (assertActorCanAccessAthlete),
// and the unfiltered queue is scoped to the athletes the caller may reach.
// Requests addressed to a non-athlete person carry no child and are not
// athlete-scoped.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id')?.trim() || undefined;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);

    let requests = await listOpenDataCollectionRequests(principal.organizationId, {
      athleteId,
      personAccountId: searchParams.get('person_account_id') ?? undefined,
    });
    if (!athleteId) {
      const named = requests
        .map((row) => row.athlete_id)
        .filter((id): id is string => id !== null);
      const allowed = await accessibleAthleteIds(principal, named);
      requests = requests.filter((row) => row.athlete_id === null || allowed.has(row.athlete_id));
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

    const athleteId = body.athlete_id?.trim() || undefined;
    if (athleteId) await assertActorCanAccessAthlete(principal, athleteId);

    const created = await createDataCollectionRequest({
      organizationId: principal.organizationId,
      athleteId,
      personAccountId: body.person_account_id,
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
    // request with a null athlete_id is a non-athlete person request and skips
    // the athlete gate, exactly like the GET/POST person path.
    const owner = await getDataCollectionRequestAthleteId(principal.organizationId, requestId);
    if (!owner) {
      throw new Error('Not found');
    }
    if (owner.athlete_id) {
      await assertActorCanAccessAthlete(principal, owner.athlete_id);
    }

    const captured = await captureDataCollectionRequest({
      organizationId: principal.organizationId,
      requestId,
      capturedByAccountId: principal.accountId,
      mediaRef: body.media_ref,
      resultingAssessmentId: body.resulting_assessment_id,
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
    // request with a null athlete_id is a non-athlete person request and skips
    // the athlete gate, exactly like the GET/POST person path.
    const owner = await getDataCollectionRequestAthleteId(principal.organizationId, requestId);
    if (!owner) {
      throw new Error('Not found');
    }
    if (owner.athlete_id) {
      await assertActorCanAccessAthlete(principal, owner.athlete_id);
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
