import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getSessionScriptWithDetail, listSessionScripts } from '@/src/server/pilot/sessionScripts';

export const runtime = 'nodejs';

// Read-only browse over pilot.session_scripts. GET without script_id lists
// (filterable by discipline/phase/day_of_week/authoring_state); GET with
// script_id returns one script's detail, blocks assembled in running order
// together with every authored rendering -- the coach picks a format at
// delivery time, this route never picks one for them.
//
// WHO MAY BROWSE was an open question this route used to answer alone, with
// "any authenticated role can browse: a script is the gym's own teaching plan
// and carries no athlete data". The second half of that is still true and is
// why the answer is as wide as it is. The first half is now decided centrally:
// on 2026-08-28 the owner ruled that the 2026-08-27 coaching-content read
// policy governs the CONTENT CLASS rather than only the three routes it
// happened to name, and a session script is that class. So this route reaches
// the one policy in coachingContentAccess.ts, and the board -- oversight, not
// coaching craft -- is excluded from it. Isolation is unchanged either way:
// the reads below take the principal's organization and accept no other.
//
// The gate sits ABOVE the query parse deliberately. Below it, the answer to
// "may I read this?" would depend on how well-formed the request was; that was
// measured on the cue-library sibling rather than argued.
//
// What happened on a given night DOES carry athlete data. It lives in
// pilot.session_script_runs, which this route does not touch and which holds a
// narrower gate of its own -- a different class, separately decided.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    const { searchParams } = new URL(request.url);
    const scriptId = searchParams.get('script_id');

    if (scriptId) {
      const script = await getSessionScriptWithDetail(principal.organizationId, scriptId);
      if (!script) {
        return NextResponse.json({ error: 'SESSION_SCRIPT_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ script });
    }

    const scripts = await listSessionScripts(principal.organizationId, {
      discipline: searchParams.get('discipline') ?? undefined,
      phase: searchParams.get('phase') ?? undefined,
      dayOfWeek: searchParams.get('day_of_week') ?? undefined,
      authoringState: searchParams.get('authoring_state') ?? undefined,
      includeRetired: searchParams.get('include_retired') === 'true',
    });
    return NextResponse.json({ scripts });
  } catch (error) {
    return jsonError(error);
  }
}
