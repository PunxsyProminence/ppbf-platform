import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getSessionScriptWithDetail, listSessionScripts } from '@/src/server/pilot/sessionScripts';

export const runtime = 'nodejs';

// Read-only browse over pilot.session_scripts. GET without script_id lists
// (filterable by discipline/phase/day_of_week/authoring_state); GET with
// script_id returns one script's detail, blocks assembled in running order
// together with every authored rendering -- the coach picks a format at
// delivery time, this route never picks one for them.
//
// Any authenticated role can browse: a script is the gym's own teaching plan
// and carries no athlete data. What happened on a given night does carry
// athlete data, and lives in pilot.session_script_runs, which this route does
// not touch.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

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
