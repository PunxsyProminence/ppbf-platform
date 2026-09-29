import { query } from '@/src/server/pilot/db';

/*
 * TEACHING FOOTAGE THAT IS IN CIRCULATION, AND WHAT IS ATTACHED TO IT.
 *
 * WHY THIS EXISTS. Nothing listed released teaching footage anywhere. The held
 * queue reads 'quarantined' and 'infected' only; /api/pilot/video/list is Film
 * Study by default and refuses take-backed rows; coverage.ts COUNTS teaching
 * footage but returns no ids. So the moment a capture was released it left every
 * surface a person can look at, and the only way to find out what the corpus
 * was built from was to query the database.
 *
 * That is what made the first piece of unwanted footage unremovable. There was
 * no delete path, but more basically there was no LIST -- an archive button
 * would have had nowhere to live.
 *
 * ARCHIVED ROWS ARE LISTED TOO, not filtered out. Archive is reversible
 * (videoArchive.ts), and a reversible action whose result disappears from the
 * only screen that offers it cannot be reversed by anybody who is not willing
 * to write SQL. It is shown, marked, and restorable.
 *
 * SCOPED TO WHO MAY ACT, matching the held queue and the release path: a coach
 * sees the teaching footage they uploaded, an organization admin sees the
 * organization's. Archive enforces the same rule server-side, so this is the
 * list of what the reader can actually do something about rather than a list of
 * other people's footage.
 *
 * NO ATHLETE NAME CROSSES THIS ROUTE. Teaching media names nobody; a coach
 * finds their own footage by take, camera view and when it was filmed. The
 * athlete_id column on a take-backed row is NULL by design and is not selected
 * here even so, because a surface that reads a column it must never show is one
 * refactor away from showing it.
 *
 * CLIP COUNTS ARE THE POINT OF THE READ, not decoration. Archiving a source
 * video retracts every clip and label cut from it -- assertVideoClippable
 * refuses to reopen them and coverage stops counting them. Somebody deciding
 * whether to pull footage has to see that it carries forty labelled clips
 * BEFORE they click, not discover it afterwards from a coverage figure that
 * dropped.
 */

export interface ReleasedTeachingFootage {
  video_session_id: string;
  file_name: string;
  /** Human-facing within its session: "take 3", not an id nobody can say. */
  take_number: number | null;
  camera_view: string | null;
  recorded_at: string | null;
  created_at: string;
  /** 'ready' or 'archived' -- this read returns no other status. */
  status: string;
  scan_state: string;
  /** How many calibration clips were cut from this footage. */
  clips_cut: number;
  /** How many of those clips carry at least one submitted annotation set. */
  clips_labelled: number;
  /** True when archived: the platform serves, clips and counts none of it. */
  archived: boolean;
  /** Present only on an archived row: why, and who decided. */
  archive_reason: string | null;
}

interface ReleasedRow {
  video_session_id: string;
  file_name: string;
  take_number: number | null;
  camera_view: string | null;
  recorded_at: string | null;
  created_at: string;
  status: string;
  scan_state: string;
  clips_cut: number;
  clips_labelled: number;
  archive_reason: string | null;
}

/**
 * @param uploaderAccountId Restricts to one coach's own uploads. Null means
 *   the whole organization, which only an organization admin may ask for.
 */
export async function readReleasedTeachingFootage(
  organizationId: string,
  uploaderAccountId: string | null,
  limit: number,
): Promise<{ items: ReleasedTeachingFootage[] }> {
  const params: (string | number)[] = [organizationId];
  let uploaderFilter = '';
  if (uploaderAccountId) {
    params.push(uploaderAccountId);
    uploaderFilter = `and v.uploaded_by_account_id = $${params.length}`;
  }
  params.push(limit);

  const rows = await query<ReleasedRow>(
    /*
     * LATERAL rather than a GROUP BY over two joins. Counting clips and
     * labelled clips in one grouped query means the clip rows fan out across
     * the annotation sets and clips_cut comes back multiplied -- the classic
     * double-count, and one that would read as plausible (a video "with 9
     * clips" that has 3) rather than as an obvious fault.
     *
     * LEFT JOIN to the take for the same reason the held queue gives: a row
     * whose take was deleted is still this coach's footage and still needs to
     * be actionable. Filtering on the take's existence would strand it.
     */
    `select v.video_session_id, v.file_name, t.take_number, v.camera_view,
            v.recorded_at, v.created_at, v.status, v.scan_state,
            coalesce(c.clips_cut, 0)::int as clips_cut,
            coalesce(c.clips_labelled, 0)::int as clips_labelled,
            v.scan_detail #>> '{archive,reason}' as archive_reason
       from pilot.video_sessions v
       left join pilot.capture_takes t
         on t.capture_take_id = v.capture_take_id
        and t.organization_id = v.organization_id
       left join lateral (
         select count(*)::int as clips_cut,
                count(*) filter (
                  where exists (
                    select 1
                      from pilot.calibration_annotation_sets s
                     where s.organization_id = cc.organization_id
                       and s.calibration_clip_id = cc.calibration_clip_id
                       and s.status = 'submitted'
                  )
                )::int as clips_labelled
           from pilot.calibration_clips cc
          where cc.organization_id = v.organization_id
            and cc.video_session_id = v.video_session_id
       ) c on true
      where v.organization_id = $1
        and v.capture_take_id is not null
        and v.status in ('ready', 'archived')
        ${uploaderFilter}
      order by v.created_at desc
      limit $${params.length}`,
    params,
  );

  return {
    items: rows.map((row) => ({
      ...row,
      archived: row.status === 'archived',
      // A reason only means anything on an archived row. A row that was
      // archived and then restored still carries the jsonb key, and reporting
      // that as the reason this live footage is withdrawn would be a false
      // statement about the current state.
      archive_reason: row.status === 'archived' ? row.archive_reason : null,
    })),
  };
}
