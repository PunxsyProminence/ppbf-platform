import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  SessionScriptAuthoringError,
  createSessionScriptFromTemplate,
  editSessionScript,
  type SessionScriptBlockEdit,
} from '@/src/server/pilot/sessionScriptAuthoring';
import {
  projectSessionScriptDetailForReader,
  projectSessionScriptsForReader,
} from '@/src/server/pilot/sessionScriptProjection';
import { getSessionScriptWithDetail, listSessionScripts } from '@/src/server/pilot/sessionScripts';

export const runtime = 'nodejs';

// Browse over pilot.session_scripts, and (POST, PATCH at the foot) a coach's
// own writes to it. GET without script_id lists
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
//
// WHAT EACH READER RECEIVES is a second question, answered after the gate: a
// coach or organization admin gets the stored rows, every other admitted role
// gets them without the author's account id, the source document or any of
// the coach's own text (sessionScriptProjection.ts). Both branches below go
// through it.
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
      return NextResponse.json({ script: projectSessionScriptDetailForReader(principal.role, script) });
    }

    const scripts = await listSessionScripts(principal.organizationId, {
      discipline: searchParams.get('discipline') ?? undefined,
      phase: searchParams.get('phase') ?? undefined,
      dayOfWeek: searchParams.get('day_of_week') ?? undefined,
      authoringState: searchParams.get('authoring_state') ?? undefined,
      includeRetired: searchParams.get('include_retired') === 'true',
    });
    return NextResponse.json({ scripts: projectSessionScriptsForReader(principal.role, scripts) });
  } catch (error) {
    return jsonError(error);
  }
}

// WRITING A SCRIPT is coach work: a coach or an organization admin of the gym
// and nobody else -- the wider reader policy above admits roles that only
// read, and platform_owner is refused here as it is for the drill and
// template writes (DRILL_AUTHOR_ROLES, the same three names). The list is
// declared here, as those are, and registered for this route in
// coachingContentAccess.test.ts, whose sweeps allow a route no other role
// list. The organization is always the principal's; no body field names one.
// Both verbs answer with the stored script, which is what these roles read
// anyway.
const SESSION_SCRIPT_AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

async function bodyRecord(request: NextRequest, allowed: readonly string[]): Promise<Record<string, unknown> | NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest('INVALID_BODY');
  }
  const extras = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
  }
  return body as Record<string, unknown>;
}

function isBlockEdit(value: unknown): value is SessionScriptBlockEdit {
  if (!value || typeof value !== 'object') return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.block_id === 'string'
    && typeof edit.block_label === 'string'
    && typeof edit.start_offset_min === 'number'
    && typeof edit.end_offset_min === 'number';
}

function authoringError(error: unknown): NextResponse {
  if (error instanceof SessionScriptAuthoringError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return jsonError(error);
}

// POST makes a script from one of the gym's workout templates: its steps, in
// its order, as timed blocks. { template_id, name? }.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SESSION_SCRIPT_AUTHOR_ROLES]);

    const record = await bodyRecord(request, ['template_id', 'name']);
    if (record instanceof NextResponse) return record;
    if (typeof record.template_id !== 'string' || record.template_id.trim() === '') {
      return badRequest('template_id');
    }
    if (record.name !== undefined && typeof record.name !== 'string') {
      return badRequest('name');
    }

    const created = await createSessionScriptFromTemplate({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      templateId: record.template_id.trim(),
      name: record.name,
    });
    const script = await getSessionScriptWithDetail(principal.organizationId, created.script_id);
    return NextResponse.json({ script }, { status: 201 });
  } catch (error) {
    return authoringError(error);
  }
}

// PATCH changes a script's name and its blocks' titles and minutes.
// { script_id, expected_updated_at, name?,
//   blocks?: [{ block_id, block_label, start_offset_min, end_offset_min }] }.
// A script that has been delivered is not changed: the edit becomes its next
// version, and `outcome` says which happened. expected_updated_at is the
// script's updated_at as the editor read it, and is required: a script another
// coach has saved since is refused (409 SESSION_SCRIPT_CHANGED) rather than
// overwritten.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SESSION_SCRIPT_AUTHOR_ROLES]);

    const record = await bodyRecord(request, ['script_id', 'expected_updated_at', 'name', 'blocks']);
    if (record instanceof NextResponse) return record;
    if (typeof record.script_id !== 'string' || record.script_id.trim() === '') {
      return badRequest('script_id');
    }
    if (typeof record.expected_updated_at !== 'string' || Number.isNaN(Date.parse(record.expected_updated_at))) {
      return badRequest('expected_updated_at');
    }
    if (record.name !== undefined && typeof record.name !== 'string') {
      return badRequest('name');
    }
    if (record.blocks !== undefined && !(Array.isArray(record.blocks) && record.blocks.every(isBlockEdit))) {
      return badRequest('blocks');
    }

    const edited = await editSessionScript({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      scriptId: record.script_id.trim(),
      name: record.name,
      blocks: record.blocks as SessionScriptBlockEdit[] | undefined,
      expectedUpdatedAt: record.expected_updated_at,
    });
    const script = await getSessionScriptWithDetail(principal.organizationId, edited.script_id);
    return NextResponse.json({ outcome: edited.outcome, script });
  } catch (error) {
    return authoringError(error);
  }
}
