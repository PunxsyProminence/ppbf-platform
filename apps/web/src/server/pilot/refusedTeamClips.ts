/**
 * REFUSED TEAM CLIPS: ONE SET, TWO READS (#1445; OD-2026-10-08-006 A-Q22
 * "Top-bar count"; Overwatch on #1508, Q2 B).
 *
 * When the content screen refuses a clip, the sweep files a critical
 * escalation against the clip's athlete, and the safety badge counts it. A
 * team clip has no athlete (OD-2026-10-08-014 keeps those scanned), and
 * safety_escalations.athlete_id is not null, so a refused team clip files
 * nothing. The top bar counts these instead, and the review page lists them.
 *
 * THE SET: a clip with no athlete that the content screen refused
 * (scan_state 'blocked'), still quarantined, that no administrator has decided
 * yet. An approve makes it ready; a block records scan_detail.human_review
 * (videoSessions.ts reviewVideoSessionScan). Either takes it out. The sweep
 * never rewrites a blocked row (settleVideoSessionScan skips scan_state
 * 'blocked'), so a recorded decision stays recorded.
 *
 * Clips the malware scanner flagged are not in it: "refused" is the content
 * screen (#1445 Q2.2, default A).
 *
 * The count and the list read the same predicate, so the number on the badge
 * is the number of rows the review page shows behind it -- the gap the first
 * version had, counting a capped page of the general list (#1508 Codex P1s).
 */
import { query, queryOne } from './db';

export const REFUSED_TEAM_CLIP_SQL = `athlete_id is null
  and status = 'quarantined'
  and scan_state = 'blocked'
  and not (scan_detail ? 'human_review')`;

export async function countRefusedTeamClips(organizationId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `select count(*)::int as count
     from pilot.video_sessions
     where organization_id = $1 and ${REFUSED_TEAM_CLIP_SQL}`,
    [organizationId],
  );
  return row?.count ?? 0;
}

export interface RefusedTeamClipRow {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  scan_state: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
  created_at: string;
}

export async function listRefusedTeamClips(organizationId: string, limit: number): Promise<RefusedTeamClipRow[]> {
  return query<RefusedTeamClipRow>(
    `select video_session_id, title, notes, file_name, file_size_bytes, mime_type, status, scan_state,
            athlete_id, uploaded_by_account_id, created_at
     from pilot.video_sessions
     where organization_id = $1 and ${REFUSED_TEAM_CLIP_SQL}
     order by created_at desc limit $2`,
    [organizationId, limit],
  );
}
