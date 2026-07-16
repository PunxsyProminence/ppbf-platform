import { NextResponse, type NextRequest } from 'next/server';

import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { queryOne } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  organization_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  athlete_id: string | null;
  blob_path: string;
  uploaded_by_account_id: string;
  created_at: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    const { videoId } = await params;

    const row = await queryOne<VideoSessionRow>(
      `select video_session_id, organization_id, title, notes, file_name, file_size_bytes, mime_type, status, athlete_id, blob_path, uploaded_by_account_id, created_at
       from pilot.video_sessions
       where video_session_id = $1 and organization_id = $2`,
      [videoId, principal.organizationId],
    );

    if (!row) {
      return jsonError('Video session not found', 404);
    }

    // Athletes may only access their own videos
    if (principal.role === 'athlete') {
      const athleteRow = await queryOne<{ athlete_id: string }>(
        'select athlete_id from pilot.athletes where account_id = $1 and organization_id = $2 limit 1',
        [principal.accountId, principal.organizationId],
      );
      if (!athleteRow || row.athlete_id !== athleteRow.athlete_id) {
        return jsonError('Forbidden', 403);
      }
    }

    const sasUrl = getPilotVideoSasUrl(row.blob_path, 60);

    return NextResponse.json({
      ...row,
      blob_path: undefined,
      stream_url: sasUrl,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Failed to retrieve video session', 500);
  }
}
