import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readTeachShadowCoverage } from '@/src/server/pilot/teachShadow/coverage';

import { requireAnnotator } from '../../calibration/annotatorGate';

export const runtime = 'nodejs';

/**
 * How much evidence Shadow has been shown, and of what.
 *
 * READ ONLY, and org-scoped from the session -- never from the caller. It
 * counts rows that already exist in this organization: recording sessions,
 * takes, captured files, cut clips, submitted annotation sets, adjudications,
 * gold records, and labelled events per vocabulary term.
 *
 * IT MAKES NO CLAIM ABOUT A MODEL, because there is no model. Nothing here is
 * an accuracy, a confidence, a readiness score or a percentage of anything.
 * The surface that renders it says "No evaluated recognition model yet" in
 * those words, and this route gives it nothing it could use to say otherwise.
 *
 * GATED AS AN ANNOTATOR SURFACE -- coach or organization admin, via the same
 * gate every calibration route passes through, so the legacy 'admin' spelling
 * is aliased correctly. These are counts of the gym's own teaching work, not
 * athlete records: no footage, no athlete name, and no annotation content
 * crosses this route, which is also why it writes no audit row. An audit write
 * on every page load would bury the writes that matter.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const coverage = await readTeachShadowCoverage(principal.organizationId);

    return NextResponse.json({ ok: true, coverage });
  } catch (error) {
    return jsonError(error);
  }
}
