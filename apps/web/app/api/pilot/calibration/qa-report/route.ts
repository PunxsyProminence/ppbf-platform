import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { loadCalibrationQaReport } from '@/src/server/pilot/calibration/qaReportLoader';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * WHAT A COACH SEES. Two owner answers (2026-10-02), each kept as one constant
 * so a later change of mind is a one-line change rather than a redesign.
 *
 * Coaches and organization administrators both read this report
 * (OD-2026-10-02-006).
 *
 * CLIP PROGRESS -- how many clips are waiting on a second labeller -- tells a
 * coach, in total, whether somebody else has started; blinding.ts withholds
 * exactly that clip by clip. He was told so and chose to show it: it is what
 * tells a coach which work is left, and it carries no label.
 *
 * COUNTS BELOW THE MINIMUM. "Counts but no percentages" below five compared
 * clips. The case against was put to him: with very few clips a count is close
 * to a per-clip statement, and a third coach who has not labelled that clip
 * yet would see it first. He kept the counts; with two labellers there is no
 * third coach. If a third labeller is added, this is the switch to revisit.
 */
const COACH_SEES_CLIP_PROGRESS = true;
const COACH_SEES_COUNTS_BELOW_MINIMUM = true;

/**
 * HOW THE LABELLING IS GOING, FOR ONE STUDY. Read-only, recomputed per request.
 *
 * Totals only. No reading, no set, no labeller and no athlete is in the
 * answer; qaReportLoader.ts holds that line and says why it may read what
 * blinding.ts would refuse.
 *
 * AND ONLY THE TOTALS THE SCREEN SHOWS. The report also holds signed
 * smallest and largest timing gaps and per-condition breakdowns. With one
 * compared clip a signed gap is one labeller's mark minus the other's, so
 * they are not sent to be left unused in a response body; `figures` below is
 * a list of what leaves, not a filter on what does not. The typical timing gap
 * is a figure computed from the sample, like a rate, and is withheld below the
 * minimum the same way.
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
    const { report } = result;
    const available = report.status === 'available';
    const showProgress = isAdmin || COACH_SEES_CLIP_PROGRESS;
    const showFigures = isAdmin || COACH_SEES_COUNTS_BELOW_MINIMUM || available;

    const gap = (field: keyof typeof report.boundaryDeltas) => ({
      count: report.boundaryDeltas[field].count,
      medianAbsoluteMs: available ? report.boundaryDeltas[field].medianAbsoluteMs : null,
    });
    const figures = {
      disagreementCounts: report.disagreementCounts,
      disagreementRates: report.disagreementRates,
      boundaryDeltas: { start_ms: gap('start_ms'), contact_ms: gap('contact_ms'), end_ms: gap('end_ms') },
      unknownRate: report.unknownRate,
      hedgedCertaintyRate: report.hedgedCertaintyRate,
      adjudicationRate: report.adjudicationRate,
    };

    return NextResponse.json({
      ok: true,
      project_name: result.projectName,
      status: report.status,
      comparison_count: report.comparisonCount,
      minimum_comparisons: report.minimumComparisons,
      report: showFigures ? figures : null,
      clip_progress: showProgress ? report.clipProgress : null,
      excluded_clips: showProgress ? result.excludedClips : null,
    }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
