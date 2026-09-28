import { query } from '@/src/server/pilot/db';
import { getVideoReleasePolicy, releasableScanStates } from '@/src/server/pilot/videoReleasePolicy';

/*
 * TEACHING FOOTAGE THAT IS STILL HELD, AND WHO CAN DO ANYTHING ABOUT IT.
 *
 * WHY THIS EXISTS AT ALL. Every upload is born 'quarantined'. With no scanner
 * configured the sweep parks it at 'unconfigured', which a coach may release
 * themselves -- that state exists precisely because leaving a no-scanner
 * environment with no way out except an administrator was a defect somebody
 * already fixed. But the only surface with a Release control was the Film
 * Study console, and separating the Film Study read hid teaching footage from
 * it. The footage then sat quarantined forever, calibration refused it for not
 * being 'ready', and the corpus pipeline stalled with nothing to see anywhere
 * a coach could look.
 *
 * SCOPED TO WHO MAY ACT, NOT TO WHO MAY LOOK. A coach sees the teaching
 * footage they uploaded; an organization admin sees the organization's. That
 * is the authority the release path already enforces, and a queue that listed
 * footage the reader cannot release would be a list of other people's
 * problems.
 *
 * DELIBERATELY NOT FILM STUDY'S BREADTH RULE. The coach branch of
 * /api/pilot/video/list also returns unassigned footage from any coach, which
 * the owner confirmed in 2026-08-08 for general gym film. Teaching captures
 * are attributed on purpose and their release is per-uploader, so that rule
 * does not carry over.
 *
 * THE CONSEQUENCE, WHICH IS INTENDED: in a take filmed on three phones, each
 * coach releases their own angle. One who has gone home leaves that angle
 * held, and an administrator is the recovery path. Released angles stay usable
 * on their own -- the corpus boundary is per source video, and nothing here
 * requires a take to be complete.
 *
 * NO ATHLETE NAME CROSSES THIS ROUTE, matching the rest of the Teach Shadow
 * area. A coach identifies their own footage by take, camera view and when it
 * was filmed, none of which names anybody.
 */

export interface HeldTeachingFootage {
  video_session_id: string;
  file_name: string;
  /** Human-facing within its session: "take 3", not an id nobody can say. */
  take_number: number | null;
  camera_view: string | null;
  recorded_at: string | null;
  created_at: string;
  status: string;
  scan_state: string;
  /**
   * Whether THIS organization's release policy allows a person to release this
   * row by hand. Computed here rather than handed to the page as a policy
   * string: the page should not be deciding what a scan verdict permits.
   */
  releasable: boolean;
  /** True for the one state a person can never clear: the screen refused it. */
  refused_by_scan: boolean;
}

export interface HeldTeachingFootageResult {
  items: HeldTeachingFootage[];
  release_policy: string;
}

interface HeldRow {
  video_session_id: string;
  file_name: string;
  take_number: number | null;
  camera_view: string | null;
  recorded_at: string | null;
  created_at: string;
  status: string;
  scan_state: string;
}

/**
 * @param uploaderAccountId Restricts to one coach's own uploads. Null means
 *   the whole organization, which only an organization admin may ask for.
 */
export async function readHeldTeachingFootage(
  organizationId: string,
  uploaderAccountId: string | null,
  limit: number,
): Promise<HeldTeachingFootageResult> {
  const params: (string | number)[] = [organizationId];
  let uploaderFilter = '';
  if (uploaderAccountId) {
    params.push(uploaderAccountId);
    uploaderFilter = `and v.uploaded_by_account_id = $${params.length}`;
  }
  params.push(limit);

  const rows = await query<HeldRow>(
    /*
     * 'quarantined' AND 'infected' BOTH, and that is not an oversight.
     * Infected footage can never be released by anyone, but leaving it out
     * would make the capture vanish from the only place its coach looks --
     * the "upload that silently never appeared" this whole surface exists to
     * prevent. It is listed and marked, not hidden.
     *
     * LEFT JOIN to the take: the take is what makes this teaching footage, but
     * a row whose take was deleted is still the coach's held upload and still
     * needs releasing. Filtering on the take's existence would strand it.
     */
    `select v.video_session_id, v.file_name, t.take_number, v.camera_view,
            v.recorded_at, v.created_at, v.status, v.scan_state
       from pilot.video_sessions v
       left join pilot.capture_takes t
         on t.capture_take_id = v.capture_take_id
        and t.organization_id = v.organization_id
      where v.organization_id = $1
        and v.capture_take_id is not null
        and v.status in ('quarantined', 'infected')
        ${uploaderFilter}
      order by v.created_at desc
      limit $${params.length}`,
    params,
  );

  const policy = await getVideoReleasePolicy(organizationId);
  const releasable = releasableScanStates(policy);

  return {
    release_policy: policy,
    items: rows.map((row) => ({
      ...row,
      releasable: row.status === 'quarantined' && releasable.includes(row.scan_state),
      refused_by_scan: row.scan_state === 'blocked' || row.status === 'infected',
    })),
  };
}
