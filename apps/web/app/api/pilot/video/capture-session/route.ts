import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  advanceTake,
  closeRecordingSession,
  createRecordingSession,
  findOpenSessionByJoinCode,
  getOpenTake,
  getSessionById,
  isSingleSubjectContext,
  listTakeFiles,
  SINGLE_SUBJECT_TRAINING_CONTEXTS,
  type RecordingSession,
  type CaptureTake,
} from '@/src/server/pilot/captureSessions';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * CAP-VID-01: the recording session several cameras share.
 *
 * Coaches stand around one athlete with their own phones and film the same
 * punch from different positions. Each phone produces its own file. This route
 * is how the platform learns those files are three views of one attempt rather
 * than three unrelated videos.
 *
 * THE JOIN CODE IS CORRELATION, NOT AUTHORIZATION, and every handler here is
 * written on that assumption. Typing a code grants nothing: each request is
 * independently gated on an authenticated coach or organization_admin, the
 * lookup is scoped to the caller's own organization, and a code belonging to
 * another gym is simply not found. If the code were ever allowed to stand in
 * for a session, a number read aloud across a room would become a credential.
 *
 * SAME ROLES AS UPLOAD, deliberately. The files produced here go through
 * /api/pilot/video/upload, which admits organization_admin and coach. A
 * narrower gate here would let someone start a session and then be refused the
 * upload; a wider one would let someone create sessions they cannot film.
 */

const ACTIONS = new Set(['create', 'join', 'advance_take', 'close']);

async function sessionPayload(session: RecordingSession, take: CaptureTake | null) {
  return {
    recording_session_id: session.recordingSessionId,
    join_code: session.joinCode,
    training_context: session.trainingContext,
    state: session.state,
    created_at: session.createdAt,
    current_take: take
      ? {
          capture_take_id: take.captureTakeId,
          take_number: take.takeNumber,
          state: take.state,
          files: await listTakeFiles(session.organizationId, take.captureTakeId),
        }
      : null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body = (await request.json().catch(() => null)) as
      | { action?: unknown; join_code?: unknown; training_context?: unknown; recording_session_id?: unknown }
      | null;

    const action = typeof body?.action === 'string' ? body.action : '';
    if (!ACTIONS.has(action)) {
      throw new Error('Unsupported action: expected "create", "join", "advance_take" or "close"');
    }

    if (action === 'create') {
      const rawContext = typeof body?.training_context === 'string' ? body.training_context : '';
      /*
       * REFUSED SERVER-SIDE, not merely absent from the form's dropdown. A
       * capture names ONE athlete and the scan sweep checks consent for
       * exactly that athlete, so a context with a second person in frame would
       * record two people and ask about one. Withheld until a participant
       * model can name everyone in a take.
       */
      if (!isSingleSubjectContext(rawContext)) {
        throw new Error(
          `Unsupported training_context: capture currently records one athlete at a time, so it accepts only ${SINGLE_SUBJECT_TRAINING_CONTEXTS.join(' and ')}`,
        );
      }

      const { session, take } = await createRecordingSession({
        organizationId: principal.organizationId,
        createdByAccountId: principal.accountId,
        // isSingleSubjectContext is a type guard, so rawContext is already
        // narrowed to a real TrainingContext by the refusal above.
        trainingContext: rawContext,
      });

      return NextResponse.json({ ok: true, session: await sessionPayload(session, take) });
    }

    if (action === 'join') {
      const rawCode = typeof body?.join_code === 'string' ? body.join_code : '';
      if (!rawCode.trim()) {
        throw new Error('Missing join_code');
      }

      // A code that belongs to another organization, or to a session that has
      // been closed, is NOT FOUND -- the same answer for both, so a caller
      // cannot use this to discover that some other gym is filming.
      const session = await findOpenSessionByJoinCode(principal.organizationId, rawCode);
      if (!session) {
        return hiddenNotFound();
      }

      const take = await getOpenTake(session.recordingSessionId);
      return NextResponse.json({ ok: true, session: await sessionPayload(session, take) });
    }

    const recordingSessionId =
      typeof body?.recording_session_id === 'string' ? body.recording_session_id.trim() : '';
    if (!recordingSessionId) {
      throw new Error('Missing recording_session_id');
    }

    const session = await getSessionById(principal.organizationId, recordingSessionId);
    if (!session) {
      return hiddenNotFound();
    }

    if (action === 'advance_take') {
      const take = await advanceTake({
        organizationId: principal.organizationId,
        recordingSessionId,
      });
      return NextResponse.json({ ok: true, session: await sessionPayload(session, take) });
    }

    await closeRecordingSession({ organizationId: principal.organizationId, recordingSessionId });
    return NextResponse.json({ ok: true, recording_session_id: recordingSessionId, state: 'closed' });
  } catch (error) {
    return jsonError(error);
  }
}

// Polled by every joined device so each one can see the other angles arriving
// against the current attempt. Read-only and organization-scoped like the rest.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const recordingSessionId = request.nextUrl.searchParams.get('recording_session_id')?.trim() ?? '';
    if (!recordingSessionId) {
      throw new Error('Missing recording_session_id');
    }

    const session = await getSessionById(principal.organizationId, recordingSessionId);
    if (!session) {
      return hiddenNotFound();
    }

    const take = await getOpenTake(session.recordingSessionId);
    return NextResponse.json({ ok: true, session: await sessionPayload(session, take) });
  } catch (error) {
    return jsonError(error);
  }
}
