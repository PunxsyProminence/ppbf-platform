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

    const videoSessionId = randomUUID();
    const blobPath = `${principal.organizationId}/${videoSessionId}/${uploadDescriptor.generatedFileName}`;

    await uploadPilotVideoFile(blobPath, file);

    await query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes, blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quarantined', now(), now())`,
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
