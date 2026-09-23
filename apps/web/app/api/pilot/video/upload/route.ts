import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { uploadPilotVideoFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
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
        athleteId,
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
        captureTakeIdForRow ? 'in_app_recording' : 'file_upload',
      ],
    );

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'video.uploaded',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        title,
        athlete_id: athleteId,
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
