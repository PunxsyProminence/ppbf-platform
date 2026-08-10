import { NextResponse, type NextRequest } from 'next/server';

import { fileAthleteVoiceEscalation } from '@/src/server/pilot/athleteVoice';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import {
  FEEDBACK_BODY_MAX_LENGTH,
  createFeedbackSubmission,
  feedbackAcknowledgement,
  isFeedbackKind,
} from '@/src/server/pilot/feedback';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Anyone signed in may tell the gym something. That includes athletes, who sign
 * in with a PIN, so this is requirePrincipal and not the Microsoft-only gate --
 * a comment box a child cannot reach is a comment box that does not exist.
 *
 * The organization, the account and the capacity all come from the session.
 * A caller cannot file under another gym, another person, or another role.
 *
 * THE RESPONSE CARRIES NO ROUTE. The writer is told, honestly, that a person
 * reads this; they are never told their words were classified, and the client
 * is given nothing to branch a different interface on. The confirmation
 * sentence is composed on the server for the same reason.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const payload = (await request.json().catch(() => ({}))) as {
      kind?: unknown;
      body?: unknown;
    };

    const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (!body) {
      throw new Error('Missing body');
    }

    if (body.length > FEEDBACK_BODY_MAX_LENGTH) {
      throw new Error(`Unsupported body: longer than ${FEEDBACK_BODY_MAX_LENGTH} characters`);
    }

    if (!isFeedbackKind(kind)) {
      throw new Error('Unsupported kind');
    }

    // Awaited, so the submission is stored before anyone is told anything --
    // but NOTHING it returns is sent back, and that is the point.
    //
    // createFeedbackSubmission resolves with { submission_id, route }. `route`
    // is the classifier's verdict: whether these words were read as a child
    // disclosing harm or as a bug report. Handing it back -- or handing back an
    // id that could be used to look it up -- would turn this endpoint into an
    // oracle. Anyone could submit throwaway text and read the response to learn
    // which phrasings reach a human, including an adult a child might be
    // disclosing about, sitting beside them while they type.
    //
    // So the reply is the same for every submission: it worked, and a person
    // reads it. If you are here to add the submission id to this response,
    // that is what it would cost.
    const submission = await createFeedbackSubmission({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
      kind,
      body,
    });

    // Athlete Voice (#198): an athlete's safeguarding submission also files
    // an escalation, so the ladder -- the platform's only notification
    // surface -- carries the alarm and not just the queue. The filing is
    // deliberately NOT awaited: awaiting it would make the safeguarding
    // path measurably slower than the product path (extra lookups plus a
    // transaction, all before the response), and response LATENCY is as
    // much a classifier oracle as response shape -- someone driving an
    // athlete session can submit candidate phrasings and time the replies.
    // Fired-and-forgotten, the response path does identical work for every
    // submission, and the ordering still holds: the submission is committed
    // before this line runs.
    //
    // Every filing outcome is swallowed -- an error only the safeguarding
    // path can hit would be the same oracle -- but not silently on the
    // server: a persistently failing alarm (stale CHECK vocabulary, FK
    // breakage) must be visible to operators, so failures log a fixed
    // event name plus a validated SQLSTATE and nothing else. No body, no
    // submission id, no error message. The 42P01 pre-migration window
    // lands here too: no escalations table means the queue-only behavior
    // every submission had before #198.
    if (principal.role === 'athlete' && submission.route === 'safeguarding') {
      void fileAthleteVoiceEscalation({
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        submissionId: submission.submission_id,
        body,
      }).catch((error: unknown) => {
        const rawCode = error && typeof error === 'object' && 'code' in error
          ? (error as { code: unknown }).code
          : undefined;
        const code = sanitizedSqlState(rawCode);
        console.error({
          event: 'athlete-voice-escalation-filing-failed',
          ...(code ? { code } : {}),
        });
      });
    }

    return NextResponse.json({
      ok: true,
      acknowledgement: feedbackAcknowledgement(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
