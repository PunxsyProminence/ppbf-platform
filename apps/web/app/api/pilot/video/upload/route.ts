import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { uploadPilotVideoFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';

export const runtime = 'nodejs';

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/mpeg',
]);

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const formData = await request.formData();
    const file = formData.get('file');
    const athleteIdValue = formData.get('athlete_id');
    const titleValue = formData.get('title');
    const notesValue = formData.get('notes');

    if (!(file instanceof File)) {
      return jsonError('Missing video file', 400);
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return jsonError(`Unsupported file type: ${file.type}`, 415);
    }
    if (file.size > MAX_BYTES) {
      return jsonError('File exceeds 500 MB limit', 413);
    }

    const athleteId = typeof athleteIdValue === 'string' ? athleteIdValue.trim() : null;
    const title = typeof titleValue === 'string' ? titleValue.trim() : file.name;
    const notes = typeof notesValue === 'string' ? notesValue.trim() : '';

    const videoSessionId = randomUUID();
    const blobPath = `${principal.organizationId}/${videoSessionId}/${file.name}`;

    await uploadPilotVideoFile(blobPath, file);

    await query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes, blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploaded', now(), now())`,
      [
        videoSessionId,
        principal.organizationId,
        principal.accountId,
        athleteId,
        title,
        notes,
        blobPath,
        file.name,
        file.size,
        file.type,
      ],
    );

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'video.uploaded',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: { title, athlete_id: athleteId, file_name: file.name, file_size_bytes: file.size },
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      eventName: 'video.uploaded',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: { mime_type: file.type, blob_path: blobPath },
    });

    return NextResponse.json({ video_session_id: videoSessionId, title, blob_path: blobPath }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Video upload failed', 500);
  }
}
