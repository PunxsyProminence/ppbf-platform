import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { readReleasedTeachingFootage } from '@/src/server/pilot/teachShadow/releasedFootage';

import { requireAnnotator } from '../../calibration/annotatorGate';

export const runtime = 'nodejs';

/**
 * Teaching footage that is in circulation, and what labelling hangs off it.
 *
 * READ ONLY, and org-scoped from the session -- never from the caller.
 *
 * ITS OWN ROUTE RATHER THAN A SECOND MODE OF .../held, which is named for, and
 * documented as, footage that has NOT been released. Teaching one route two
 * meanings is how the Film Study separation got lost the first time, and a
 * route whose name contradicts its payload costs more later than a second
 * twenty-line file costs now.
 *
 * SCOPED TO THE READER'S OWN UPLOADS unless they are an organization admin --
 * the same authority the archive path enforces, so this is a list of what the
 * reader can act on rather than a catalogue of other people's footage.
 *
 * NO ATHLETE NAME CROSSES IT, like the rest of this area.
 *
 * NO AUDIT ROW: a list read of the reader's own footage. An audit write on
 * every page load would bury the writes that matter.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const { searchParams } = new URL(request.url);
    const limit = parseSafeLimit(searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    // Decided HERE, from the session. A parameter that widened a coach to the
    // whole organization would hand them an archive queue for footage they may
    // not archive.
    const uploaderAccountId = isOrganizationAdminRole(principal.role)
      ? null
      : principal.accountId;

    const released = await readReleasedTeachingFootage(principal.organizationId, uploaderAccountId, limit);

    return NextResponse.json({ ok: true, ...released });
  } catch (error) {
    return jsonError(error);
  }
}
