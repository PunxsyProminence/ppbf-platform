import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { uploadPilotVideoFile } from '@/src/server/pilot/blob';
import {
  athleteIdsForParticipants,
  linkParticipantToVideo,
  participantsForSession,
} from '@/src/server/pilot/captureParticipants';
import { query } from '@/src/server/pilot/db';
import {
  assertTeachShadowConsent,
  TeachShadowConsentMissingError,
} from '@/src/server/pilot/guardianConsent';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from '@/src/server/pilot/shadowRateLimit';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { isVideoScanConfigured, resolveVideoScanConfig } from '@/src/server/pilot/videoScanPolicy';
import {
  describeVideoUpload,
  validateVideoUploadSignature,
  validateVideoUploadTransport,
} from '@/src/server/pilot/videoUploadPolicy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const transport = validateVideoUploadTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ error: transport.error }, { status: transport.status });
    }
    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...resolveShadowRateLimit('video_upload'),
    });

    const formData = await request.formData();
    const file = formData.get('file');
    const athleteIdValue = formData.get('athlete_id');
    const titleValue = formData.get('title');
    const notesValue = formData.get('notes');
    // CAP-VID-01 capture provenance. All optional: an ordinary file upload
    // from the Video Analysis page sends none of them and is unchanged.
    const captureTakeIdValue = formData.get('capture_take_id');
    const cameraViewValue = formData.get('camera_view');
    const recordedAtValue = formData.get('recorded_at');
    const captureSourceValue = formData.get('capture_source');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing video file' }, { status: 400 });
    }
    const uploadDescriptor = describeVideoUpload(file);
    if (!uploadDescriptor) {
      return NextResponse.json(
        { error: 'Only bounded MP4, MOV, AVI, WebM, and MPEG video files are accepted.' },
        { status: 415 },
      );
    }
    const signatureBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!validateVideoUploadSignature(uploadDescriptor, signatureBytes)) {
      return NextResponse.json(
        { error: 'The video content does not match its declared file type.' },
        { status: 415 },
      );
    }

    const athleteId = typeof athleteIdValue === 'string' ? athleteIdValue.trim() : null;
    const title = typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.trim()
      : uploadDescriptor.safeOriginalName;
    const notes = typeof notesValue === 'string' ? notesValue.trim() : '';
    if (title.length > 200 || notes.length > 2_000) {
      return NextResponse.json({ error: 'Video title or notes exceed the allowed size.' }, { status: 400 });
    }

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    /*
     * WHAT PRODUCED THESE BYTES, taken from the client rather than inferred.
     *
     * Inferring 'in_app_recording' from the mere presence of a take was wrong:
     * an angle that arrives as an EXISTING FILE chosen from the device -- the
     * fallback for a browser whose recorder this platform cannot use -- also
     * belongs to a take, and labelling it as recorded in-app would be a false
     * provenance claim on a file this app never recorded.
     *
     * Validated against the closed vocabulary because the column's CHECK will
     * refuse anything else as an opaque 500 otherwise.
     */
    const rawCaptureSource = typeof captureSourceValue === 'string' ? captureSourceValue.trim() : '';
    if (rawCaptureSource && !['in_app_recording', 'file_upload'].includes(rawCaptureSource)) {
      return NextResponse.json(
        { error: 'Unsupported capture_source: expected "in_app_recording" or "file_upload".' },
        { status: 400 },
      );
    }
    const captureSource = rawCaptureSource || 'file_upload';

    /*
     * CAP-VID-01: which attempt this file is a view of.
     *
     * RESOLVED SERVER-SIDE FROM THE TAKE, never taken from the client. The
     * request supplies only capture_take_id; the recording session is read
     * back from that take within this organization. A client that could name
     * its own recording_session_id could attach a file to one session while
     * claiming a take from another, and the grouping would be a lie that looks
     * like data. An unknown or other-organization take is refused outright
     * rather than silently dropped, because a coach whose angle quietly failed
     * to join the take would never find out.
     */
    const captureTakeId = typeof captureTakeIdValue === 'string' ? captureTakeIdValue.trim() : '';
    let recordingSessionId: string | null = null;
    let captureTakeIdForRow: string | null = null;
    if (captureTakeId) {
      const take = await query<{ recording_session_id: string; state: string }>(
        `select t.recording_session_id, t.state
           from pilot.capture_takes t
           join pilot.recording_sessions s
             on s.recording_session_id = t.recording_session_id
          where t.capture_take_id = $1 and s.organization_id = $2`,
        [captureTakeId, principal.organizationId],
      );
      if (take.length === 0) {
        return NextResponse.json({ error: 'Not found: no such capture take' }, { status: 404 });
      }
      if (take[0].state !== 'open') {
        return NextResponse.json(
          { error: 'That attempt is already closed. Start the next take and record again.' },
          { status: 409 },
        );
      }
      recordingSessionId = take[0].recording_session_id;
      captureTakeIdForRow = captureTakeId;

    }

    /*
     * A CAPTURE RECORDING MUST NAME ITS SUBJECT. Refused here, on the server,
     * not merely required by the form.
     *
     * Without this the capture surfaces recreate a bypass that already exists
     * for ungrouped team uploads: videoScanSweep only asserts guardian consent
     * when a video carries an athlete_id, because a video with none "has no
     * guardian to ask". An ordinary unattributed upload is a known, accepted
     * gap. A dedicated recorder is not: it exists to film athletes, so footage
     * of a minor would enter the vision content screen with the consent check
     * skipped.
     *
     * "Not ML-eligible yet" does not answer that. The refusal does.
     *
     * KEYED ON WHAT PRODUCED THE BYTES, NOT ON WHETHER THERE IS A TAKE. This
     * used to test take-presence, which held only while the single in-app
     * recorder was the grouped Teach Shadow one. Film Study now has its own
     * recorder and sends NO take -- deliberately, because a takeless upload is
     * what keeps its footage out of the recognition corpus -- so a take-keyed
     * rule would let a dedicated capture UI store an unattributed recording of
     * a minor again, which is the exact defect this refusal exists to prevent.
     * capture_source says what the surface was; a file chosen from the
     * ordinary video library declares none and keeps its known, accepted gap.
     *
     * The consequence is deliberate and narrow: both recorders film ROSTERED
     * ATHLETES ONLY. Filming a coach demonstrating has no athlete to name and
     * is refused here rather than quietly stored as unattributed. Supporting
     * it needs a participant model that says who is in the frame, which is an
     * owner decision and is not invented here.
     */
    /*
     * TS-ANON-01: THE RULE NOW BRANCHES BY DESTINATION, because the two
     * recorders have opposite requirements.
     *
     * TEACHING MEDIA NAMES NOBODY. A take-backed upload is Teach Shadow
     * footage, and its row must carry no athlete. A client that sends one is
     * REFUSED rather than quietly stripped: silently accepting it would let a
     * stale client keep believing it had attributed the footage, and would
     * leave an identifier arriving at this boundary with nothing to say it was
     * ignored. Refusing is how a stale client finds out.
     *
     * The participant is resolved SERVER-SIDE from the capture session, which
     * is where clearance recorded it. It is never taken from the request: a
     * client that could name its own participant could attribute one child's
     * footage to another child's consent.
     *
     * FILM STUDY STILL NAMES ITS ATHLETE, and its recorder still refuses an
     * unnamed recording. The original reasoning holds unchanged there: the
     * scan sweep only asserts consent when a video carries an identity, so a
     * dedicated recorder storing an unattributed minor would enter the content
     * screen with the check skipped. What changed is only that teaching
     * footage now carries that identity on the restricted side instead.
     */
    if (captureTakeIdForRow && athleteId) {
      return NextResponse.json(
        {
          error:
            'Teach Shadow footage is anonymous and must not name an athlete. The participant is established at capture clearance, not sent with the upload.',
        },
        { status: 400 },
      );
    }

    if (!athleteId && !captureTakeIdForRow && captureSource === 'in_app_recording') {
      return NextResponse.json(
        {
          error:
            'A recording must say which athlete it is of. Choose an athlete before recording.',
        },
        { status: 400 },
      );
    }

    /*
     * WHO THIS TEACHING FOOTAGE IS OF, and whether it may be used at all.
     *
     * Read from the session rather than the request, then consent is checked
     * again HERE -- clearance happened before filming and a guardian may have
     * withdrawn in between. A take with no participant is refused: footage
     * that cannot be resolved to a guardian must not enter the teaching
     * corpus, and "I could not tell" is not "allowed".
     */
    let teachingParticipantIds: string[] = [];
    if (captureTakeIdForRow) {
      teachingParticipantIds = await participantsForSession(
        principal.organizationId,
        recordingSessionId as string,
      );

      if (teachingParticipantIds.length === 0) {
        return NextResponse.json(
          {
            error:
              'This capture session has no cleared participant, so its footage cannot be accepted as teaching evidence. Clear the participant before filming.',
          },
          { status: 409 },
        );
      }

      try {
        for (const athlete of await athleteIdsForParticipants(
          principal.organizationId,
          teachingParticipantIds,
        )) {
          await assertTeachShadowConsent(principal.organizationId, athlete);
        }
      } catch (error) {
        if (error instanceof TeachShadowConsentMissingError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }

    // Free text and allowed to be unknown. "Rear phone camera" is a fact about
    // hardware; "rear view of the athlete" is a fact about the gym. Only a
    // human can say the second, so nothing here infers it.
    const cameraView = typeof cameraViewValue === 'string' && cameraViewValue.trim()
      ? cameraViewValue.trim().slice(0, 120)
      : null;

    /*
     * WHEN THE FOOTAGE WAS SHOT, which is not when the row was written. A
     * phone that recorded in a basement and uploaded on the drive home has
     * hours between the two, and the dataset wants the former.
     *
     * Validated against the calendar, not just Date.parse: V8 rolls an
     * out-of-range day over ("2026-02-30" becomes March 2) while the
     * timestamptz column refuses it, so an unchecked value either stores a
     * different instant than the client meant or surfaces as an opaque 500.
     */
    let recordedAt: string | null = null;
    if (typeof recordedAtValue === 'string' && recordedAtValue.trim()) {
      const raw = recordedAtValue.trim();
      const shape = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.exec(raw);
      const parsed = shape ? new Date(raw) : null;
      const roundTrips =
        parsed !== null
        && Number.isFinite(parsed.getTime())
        && parsed.getUTCFullYear() === Number(shape![1])
        && parsed.getUTCMonth() + 1 === Number(shape![2])
        && parsed.getUTCDate() === Number(shape![3]);
      if (!roundTrips) {
        return NextResponse.json(
          { error: 'Unsupported recorded_at: must be an ISO 8601 UTC timestamp naming a real calendar day.' },
          { status: 400 },
        );
      }
      recordedAt = raw;
    }


    const videoSessionId = randomUUID();
    const blobPath = `${principal.organizationId}/${videoSessionId}/${uploadDescriptor.generatedFileName}`;

    await uploadPilotVideoFile(blobPath, file);

    await query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes, blob_path, file_name, file_size_bytes, mime_type, status,
          recording_session_id, capture_take_id, camera_view_id, camera_view, recorded_at, capture_source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quarantined',
               $11, $12, $13, $14, $15, $16, now(), now())`,
      [
        videoSessionId,
        principal.organizationId,
        principal.accountId,
        // NULL for teaching media, by the rule above. The identity for a
        // take-backed video lives on the restricted side and is linked below.
        captureTakeIdForRow ? null : athleteId,
        title,
        notes,
        blobPath,
        uploadDescriptor.safeOriginalName,
        file.size,
        uploadDescriptor.contentType,
        recordingSessionId,
        captureTakeIdForRow,
        // A PPBF identity for this view, minted here. Never a browser device
        // id or hardware fingerprint: those follow a person's phone across
        // sessions, which this has no need to know. It only has to tell this
        // camera apart from the others in the same take.
        captureTakeIdForRow ? randomUUID() : null,
        cameraView,
        recordedAt,
        captureSource,
      ],
    );

    /*
     * The restricted link, written after the row exists because its foreign
     * key points at it. Every participant on the session is attached: a device
     * that joined by code is filming the same person from another angle, and
     * its file has to be resolvable to the same guardian.
     */
    for (const captureParticipantId of teachingParticipantIds) {
      await linkParticipantToVideo({
        organizationId: principal.organizationId,
        videoSessionId,
        captureParticipantId,
      });
    }

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'video.uploaded',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        title,
        // Absent for teaching media. An event stream carrying the athlete
        // would reintroduce the identity this slice just removed, in the one
        // place nobody thinks to look.
        athlete_id: captureTakeIdForRow ? null : athleteId,
        file_name: uploadDescriptor.safeOriginalName,
        file_size_bytes: file.size,
        status: 'quarantined',
      },
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'video.uploaded',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        mime_type: uploadDescriptor.contentType,
        video_session_id: videoSessionId,
        status: 'quarantined',
      },
    });

    // Say whether anything will actually review it. Until #49 the answer was
    // "no" in every environment -- nothing in the platform could move a video
    // off 'quarantined' -- while this response still reported it as accepted
    // for security review. The scan sweep is the reviewer now, but it is off
    // unless a gate is configured, so the uploader is told which case they are
    // in rather than being left to infer it from a video that never appears.
    const scanConfigured = isVideoScanConfigured(resolveVideoScanConfig());

    return NextResponse.json(
      {
        video_session_id: videoSessionId,
        title,
        status: 'quarantined',
        accepted_for_security_review: true,
        scan_pending: scanConfigured,
        message: scanConfigured
          ? 'Uploaded. The video stays quarantined until an automated scan clears it.'
          : 'Uploaded. No video scanner is configured in this environment, so this video will stay quarantined until an administrator enables one.',
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { error: shadowRateLimitMessage(error.retryAfterSeconds, 'video upload') },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
