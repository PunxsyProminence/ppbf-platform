import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { loadCalibrationQaReport } from '@/src/server/pilot/calibration/qaReportLoader';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * WHAT A COACH SEES, WHERE THE OWNER HAS NOT YET SAID.
 *
 * Coaches and organization administrators both read this report
 * (OD-2026-10-02-006). Two details of the coach's view are open questions with
 * the owner, and each is one constant so his answer is a one-line change
 * rather than a redesign.
 *
 * CLIP PROGRESS -- how many clips are waiting on a second labeller -- tells a
 * coach, in total, whether somebody else has started. blinding.ts withholds
 * exactly that clip by clip. Off until he answers.
 *
 * COUNTS BELOW THE MINIMUM. He approved "counts but no percentages" below five
 * compared clips, so this is on. The case against, which he is being asked
 * about: with very few clips a count is close to a per-clip statement, and a
 * coach who has not labelled that clip yet would see it first.
 */
const COACH_SEES_CLIP_PROGRESS = false;
const COACH_SEES_COUNTS_BELOW_MINIMUM = true;

/**
 * HOW THE LABELLING IS GOING, FOR ONE STUDY. Read-only, recomputed per request.
 *
 * Totals only. No reading, no set, no labeller and no athlete is in the
 * answer; qaReportLoader.ts holds that line and says why it may read what
 * blinding.ts would refuse.
 *
 * requireAnnotator, not the adjudication gate: this is not the surface that
 * settles a disagreement, so an administrator who labelled a clip is not
 * refused here (OD-2026-08-29-002 is about adjudicating, and still holds
 * there). platform_owner is absent for the reason it is absent from every
 * route in this directory.
 *
 * NO AUDIT ROW, as comparison/route.ts: the audit vocabulary has no read
 * member and recording a read as an 'update' would be a false statement.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const projectId = new URL(request.url).searchParams.get('calibration_project_id')?.trim() ?? '';
    if (!projectId) {
      throw new Error('Missing calibration_project_id');
    }

    // Organization from the session, never from the caller. A study in another
    // organization is indistinguishable here from one that never existed.
    const result = await loadCalibrationQaReport(principal.organizationId, projectId);
    if (!result) {
      throw new Error('Not found: no such calibration study in this organization');
    }

    const isAdmin = isOrganizationAdminRole(principal.role);
    const { clipProgress, ...figures } = result.report;
    const showProgress = isAdmin || COACH_SEES_CLIP_PROGRESS;
    const showFigures =
      isAdmin || COACH_SEES_COUNTS_BELOW_MINIMUM || result.report.status === 'available';

    return NextResponse.json({
      ok: true,
      project_name: result.projectName,
      status: result.report.status,
      comparison_count: result.report.comparisonCount,
      minimum_comparisons: result.report.minimumComparisons,
      report: showFigures ? figures : null,
      clip_progress: showProgress ? clipProgress : null,
      excluded_clips: showProgress ? result.excludedClips : null,
    }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
