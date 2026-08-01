import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  // Why a video is still quarantined (#49). 'pending'/'scanning' while the
  // scan is in flight, 'needs_human_review' or 'blocked' when it will not
  // clear on its own. Without this a coach could only ever see 'quarantined'
  // and had no way to tell a scan in progress from one that gave up.
  scan_state: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent']);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id');
    const limit = parseSafeLimit(searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    let rows: VideoSessionRow[];

    if (principal.role === 'athlete') {
      if (!principal.athleteId) {
        return NextResponse.json({ items: [] });
      }
      rows = await query<VideoSessionRow>(
        `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state, athlete_id, uploaded_by_account_id, created_at
         from pilot.video_sessions
         where organization_id = $1
           and athlete_id = $2
           and status = 'ready'
         order by created_at desc limit $3`,
        [principal.organizationId, principal.athleteId, limit],
      );
    } else if (principal.role === 'parent') {
      if (!athleteId) {
        throw new Error('Missing athlete_id: parents must specify an athlete_id parameter');
      }
      await assertActorCanAccessAthlete(principal, athleteId);
      rows = await query<VideoSessionRow>(
        `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state, athlete_id, uploaded_by_account_id, created_at
         from pilot.video_sessions
         where organization_id = $1 and athlete_id = $2 and status = 'ready'
         order by created_at desc limit $3`,
        [principal.organizationId, athleteId, limit],
      );
    } else if (principal.role === 'coach') {
      if (athleteId) {
        await assertActorCanAccessAthlete(principal, athleteId);
        rows = await query<VideoSessionRow>(
          `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state, athlete_id, uploaded_by_account_id, created_at
           from pilot.video_sessions
           where organization_id = $1 and athlete_id = $2
           order by created_at desc limit $3`,
          [principal.organizationId, athleteId, limit],
        );
      } else {
        rows = await query<VideoSessionRow>(
          `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state, athlete_id, uploaded_by_account_id, created_at
           from pilot.video_sessions
           where organization_id = $1
             and (athlete_id is null or athlete_id in (
               select athlete_id from pilot.athletes where coach_id = $2 and organization_id = $1
             ))
           order by created_at desc limit $3`,
          [principal.organizationId, principal.accountId, limit],
        );
      }
    } else if (isOrganizationAdminRole(principal.role)) {
      const params: (string | number)[] = [principal.organizationId, limit];
      let athleteFilter = '';
      if (athleteId) {
        params.push(athleteId);
        athleteFilter = `and athlete_id = $${params.length}`;
      }
      rows = await query<VideoSessionRow>(
        `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state, athlete_id, uploaded_by_account_id, created_at
         from pilot.video_sessions
         where organization_id = $1 ${athleteFilter}
         order by created_at desc limit $2`,
        params,
      );
    } else {
      throw new Error('Forbidden: your role does not have permission to list videos');
    }

    return NextResponse.json({ items: rows });
  } catch (error) {
    return jsonError(error);
  }
}
