import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  SessionScriptRunError,
  getLiveRunForCoach,
  startSessionScriptRun,
} from '@/src/server/pilot/sessionScriptRuns';

export const runtime = 'nodejs';

// Delivering a session script. The sibling route (/api/pilot/session-scripts) is the read-only
// browse over the PLAN and any authenticated role may use it; this is the record of a session
// being RUN, which is coach work and carries who was on the floor.
//
// GET answers "do I have a session in progress" -- the whole point of the run row existing. A
// coach whose phone locked or whose tab reloaded calls this and gets their session back, clock
// intact, because the server computed the elapsed time rather than the tab counting it.
//
// Returns { run: null } rather than 404 when there is no live session: "you have nothing running"
// is a successful answer to that question, not a missing resource.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'platform_owner']);

    const run = await getLiveRunForCoach(principal.organizationId, principal.accountId);
    return NextResponse.json({ run });
  } catch (error) {
    return jsonError(error);
  }
}

const START_FIELDS = ['script_id'] as const;
const START_OPTIONAL_FIELDS = ['activity_id', 'athletes_present', 'delivered_on'] as const;

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

// POST starts a run. The body is deliberately narrow: no run_state, no started_at, no elapsed
// time. Those are the server's to set, and accepting them from a client is how a coach's clock
// would become whatever their device believed.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'platform_owner']);

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('INVALID_BODY');
    }
    const record = body as Record<string, unknown>;

    const extras = Object.keys(record).filter(
      (key) =>
        !(START_FIELDS as readonly string[]).includes(key)
        && !(START_OPTIONAL_FIELDS as readonly string[]).includes(key),
    );
    if (extras.length > 0) {
      return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
    }

    if (typeof record.script_id !== 'string' || record.script_id.trim() === '') {
      return badRequest('script_id');
    }

    let athletesPresent: number | null = null;
    if (record.athletes_present !== undefined && record.athletes_present !== null) {
      if (
        typeof record.athletes_present !== 'number'
        || !Number.isInteger(record.athletes_present)
        || record.athletes_present < 0
      ) {
        return badRequest('athletes_present');
      }
      athletesPresent = record.athletes_present;
    }

    if (
      record.activity_id !== undefined
      && record.activity_id !== null
      && typeof record.activity_id !== 'string'
    ) {
      return badRequest('activity_id');
    }

    // A date, not a timestamp: delivered_on is which night this was, and accepting a full
    // timestamp here would invite it to be confused with the start time the server owns.
    if (record.delivered_on !== undefined && record.delivered_on !== null) {
      if (typeof record.delivered_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.delivered_on)) {
        return badRequest('delivered_on');
      }
    }

    const run = await startSessionScriptRun(principal.organizationId, principal.accountId, {
      scriptId: record.script_id.trim(),
      activityId: (record.activity_id as string | undefined) ?? null,
      athletesPresent,
      deliveredOn: (record.delivered_on as string | undefined) ?? undefined,
    });

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof SessionScriptRunError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
