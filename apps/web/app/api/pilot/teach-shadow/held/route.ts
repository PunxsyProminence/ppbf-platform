import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { readHeldTeachingFootage } from '@/src/server/pilot/teachShadow/heldFootage';

import { requireAnnotator } from '../../calibration/annotatorGate';

export const runtime = 'nodejs';

/**
 * Teaching footage this reader can release, and has not.
 *
 * READ ONLY, and org-scoped from the session -- never from the caller.
 *
 * SCOPED TO THE READER'S OWN UPLOADS unless they are an organization admin.
 * That matches the authority the release path enforces rather than the
 * breadth the Film Study list offers: a coach may release what they uploaded,
 * an admin may resolve anyone's, and listing footage the reader cannot act on
 * would be a queue of other people's problems.
 *
 * ITS OWN ROUTE RATHER THAN A MODE OF /api/pilot/video/list, which is now
 * Film-Study-by-default. Teaching that route a second meaning is how the
 * separation got lost the first time. This one reads the same canonical
 * pilot.video_sessions; it is not another media model, it answers a different
 * question.
 *
 * NO ATHLETE NAME CROSSES IT, like the rest of this area. A coach finds their
 * own footage by take, camera view and time.
 *
 * NO AUDIT ROW: this is a list read of the reader's own held uploads. An audit
 * write on every page load would bury the writes that matter.
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

    /*
     * The scope is decided HERE, from the session, and the caller cannot ask
     * for anything else. A parameter that widened a coach to the whole
     * organization would hand them a release queue for footage they may not
     * release.
     */
    const uploaderAccountId = isOrganizationAdminRole(principal.role)
      ? null
      : principal.accountId;

    const held = await readHeldTeachingFootage(principal.organizationId, uploaderAccountId, limit);

    return NextResponse.json({ ok: true, ...held });
  } catch (error) {
    return jsonError(error);
  }
}
