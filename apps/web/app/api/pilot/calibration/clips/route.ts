import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  assertVideoClippable,
  createCalibrationClip,
  listCalibrationClips,
  type CalibrationClipRow,
} from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator, writeCalibrationAuditEvent } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * A clip-code collision within one study, and ONLY that.
 *
 * The named constraint is checked rather than the bare 23505, for the reason
 * boardSeats.ts checks its own: a colliding UUID on the primary key is a
 * different fault, and telling a coach to "pick another code" over it would
 * send them renaming something that was never the problem.
 */
function isClipCodeTaken(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (code !== '23505') {
    return false;
  }
  const name = 'pilot_calibration_clips_code_uq';
  return constraint === name || (typeof message === 'string' && message.includes(name));
}

/**
 * The clips cut for one calibration project.
 *
 * WHAT `playable` IS, AND WHAT IT IS NOT. It is the answer
 * assertVideoClippable gives right now for that clip's source video -- the
 * same call the annotation routes make, not a second opinion about it. It is a
 * HINT for the picker so a clip whose footage has since been quarantined,
 * blocked or archived reads as unavailable instead of taking the annotator
 * into a workspace that will refuse them.
 *
 * It authorizes nothing. Playback goes through teaching's own door,
 * GET /api/pilot/teach-shadow/footage/[videoId]/stream, which asks for itself:
 * requireAnnotator (coach or organization admin), then assertVideoClippable
 * again at the moment of the request, in the caller's organization. A true
 * `playable` therefore means "the study's gate was satisfied when this list
 * was built", never "here is a stream": footage archived or blocked a second
 * later reads `playable: true` here and is refused at the door, which is the
 * safe direction for a hint to be wrong in.
 *
 * There is no athlete-access check and no guardian-consent check on that
 * path, and none belongs there: teaching footage names nobody and has no
 * consent step (OD-2026-09-28-006). This comment used to describe the Film
 * Study video route and its per-athlete checks; the labelling page stopped
 * using that route in TEACH-DATA-01, and it had refused every teaching clip
 * since 2026-09-25 in any case.
 *
 * The clip's own status is NOT disclosed -- a boolean, never
 * VideoNotClippableError's `videoStatus`. Whether a particular video is
 * quarantined is a safeguarding fact about a scan, and this is a list an
 * annotator loads to pick their next six seconds of work.
 */
interface CalibrationClipListItem extends CalibrationClipRow {
  playable: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('calibration_project_id')?.trim() ?? '';
    if (!projectId) {
      throw new Error('Missing calibration_project_id');
    }

    const clips = await listCalibrationClips(principal.organizationId, projectId);

    const items: CalibrationClipListItem[] = await Promise.all(
      clips.map(async (clip) => {
        try {
          await assertVideoClippable(principal.organizationId, clip.video_session_id);
          return { ...clip, playable: true };
        } catch {
          // Swallowed on purpose and ONLY here. The catch turns "this clip's
          // footage is not available" into a greyed-out row; every route that
          // actually serves or writes against a clip lets the same error
          // propagate so the annotator is told why. A catch on a write path
          // would be this hint quietly becoming a bypass.
          return { ...clip, playable: false };
        }
      }),
    );

    return NextResponse.json({ ok: true, clips: items });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Cut a clip.
 *
 * THE ACT THIS BUILD HAD NO DOOR FOR. Every other stage of the teaching loop
 * has a screen -- film it, release it, label it, withdraw it -- and this one
 * had a script, `pilot-bootstrap-calibration-clip.ts`, run by hand against a
 * production connection string. So a coach could film footage and could open
 * the labelling page, and nothing they could do joined the two. The loop the
 * Teach Shadow home page describes could not be walked.
 *
 * ALMOST NOTHING IS DECIDED HERE. createCalibrationClip already owns the
 * rules and is covered by its own database-backed suite: it refuses a clip
 * that does not end after it starts, a sampling reason outside the closed
 * vocabulary, an empty code, and -- through assertVideoClippable -- any source
 * that is not this organization's released teaching footage. Re-checking any
 * of that here would be a second opinion that can drift out of step with the
 * first. This route supplies the two things that module cannot know: who is
 * asking, and how to say no in a sentence a coach can act on.
 *
 * THE CLIP CODE IS THE ONE THING A PERSON MUST STILL CHOOSE. It is how a clip
 * is referred to out loud between two annotators comparing notes, so it is not
 * generated. Its uniqueness within a study is a database constraint, and the
 * collision is translated below for the same reason the study name's is.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = await request.json().catch(() => ({}));
    const projectId = typeof body?.calibration_project_id === 'string'
      ? body.calibration_project_id.trim()
      : '';
    const videoSessionId = typeof body?.video_session_id === 'string'
      ? body.video_session_id.trim()
      : '';
    const clipCode = typeof body?.clip_code === 'string' ? body.clip_code.trim() : '';

    if (!projectId) throw new Error('Missing calibration_project_id');
    if (!videoSessionId) throw new Error('Missing video_session_id');
    if (!clipCode) throw new Error('Missing clip_code: a clip needs a code two annotators can say out loud');

    /*
     * THE OFFSETS ARE READ AS NUMBERS AND PASSED ON UNCHECKED, on purpose.
     * createCalibrationClip's requireOffsetMs is the one place that decides
     * what a valid millisecond offset is -- whole, non-negative, and with the
     * end after the start -- and it raises messages this route already knows
     * how to return. A pre-check here would be a second definition of the same
     * rule, and the two would drift.
     *
     * Non-numbers become NaN rather than silently becoming 0: Number(undefined)
     * is NaN and Number('') is 0, so the empty string is caught explicitly.
     */
    const startMs = body?.start_ms === '' ? Number.NaN : Number(body?.start_ms);
    const endMs = body?.end_ms === '' ? Number.NaN : Number(body?.end_ms);

    let clip;
    try {
      clip = await createCalibrationClip({
        organizationId: principal.organizationId,
        calibrationClipId: randomUUID(),
        calibrationProjectId: projectId,
        videoSessionId,
        clipCode,
        startMs,
        endMs,
        primarySamplingReason: body?.primary_sampling_reason,
        createdByAccountId: principal.accountId,
      });
    } catch (error) {
      if (isClipCodeTaken(error)) {
        return NextResponse.json(
          {
            error: `This study already has a clip called "${clipCode}". Pick another code.`,
            reason: 'CALIBRATION_CLIP_CODE_TAKEN',
          },
          { status: 409 },
        );
      }
      throw error;
    }

    /*
     * A FAILED AUDIT WRITE IS NOT SWALLOWED, and the refusal names what was
     * left behind -- the posture bootstrap.ts argues for at length. The clip
     * exists and cannot be rolled back from here, so a caller told "failed"
     * with no further detail would cut it again and end up with two.
     */
    try {
      await writeCalibrationAuditEvent({
        eventType: 'create',
        principal,
        entityType: 'calibration_clip',
        entityId: clip.calibration_clip_id,
        details: {
          calibration_project_id: clip.calibration_project_id,
          video_session_id: clip.video_session_id,
          clip_code: clip.clip_code,
          start_ms: clip.start_ms,
          end_ms: clip.end_ms,
          primary_sampling_reason: clip.primary_sampling_reason,
          // NULL on teaching footage by design (TS-ANON-01). Recorded rather
          // than omitted so the row says which kind of source this was without
          // a second lookup.
          athlete_id: clip.athlete_id,
        },
      });
    } catch (error) {
      /*
       * RETURNED, NOT THROWN. jsonError maps status by message PREFIX and
       * replaces anything it does not recognise with "Internal server error"
       * -- so this sentence, which exists precisely to stop somebody cutting
       * the clip a second time, would never reach them. Caught by its own
       * test, which is the only reason it is not still a throw.
       */
      const reason = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          error: `${reason} -- the clip "${clip.clip_code}" (${clip.calibration_clip_id}) was cut `
            + 'before its audit record could be written and still exists, unaudited. Do not cut it '
            + 'again; it is in the study.',
          reason: 'CALIBRATION_CLIP_AUDIT_FAILED',
          calibration_clip_id: clip.calibration_clip_id,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, clip }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
