import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import {
  DRILL_DIFFICULTIES,
  DrillNameTakenError,
  createDrill,
  isDrillDifficulty,
  listDrills,
  updateDrill,
  type DrillDifficulty,
  type DrillLibraryResponse,
} from '@/src/server/pilot/drills';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Who may read is no longer decided here. A drill is gym-wide coaching content
// and holds no athlete data; the same is true of the v3 drill library and the
// cue library, which used to answer this question differently. One owner
// decision now covers all three -- see coachingContentAccess.ts.
//
// What changed for THIS route: the board is still excluded, for the reason
// this file already gave. The platform owner is no longer excluded. The
// rationale that excluded it -- "a gym's drills are the gym's" -- was answered
// rather than overruled: the read below is reached only through
// principal.organizationId, so an Omega read IS the gym's, one gym at a time.

// Coaches and admins are the people who know the drills, so they are the ones
// who write them.
const DRILL_AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const MAX_CUES = 12;

function requireText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return raw.trim();
}

function optionalText(raw: unknown, field: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return requireText(raw, field);
}

// Blank lines are dropped rather than stored: a cue nobody wrote is not a cue,
// and a reader that rendered it would be drawing an empty line of coaching copy.
function parseCues(raw: unknown): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!Array.isArray(raw) || raw.some((cue) => typeof cue !== 'string')) {
    throw new Error('Unsupported cues');
  }

  const cues = (raw as string[]).map((cue) => cue.trim()).filter((cue) => cue.length > 0);
  if (cues.length > MAX_CUES) {
    throw new Error(`Unsupported cues: at most ${MAX_CUES}`);
  }

  return cues;
}

function parseDifficulty(raw: unknown): DrillDifficulty | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  if (!isDrillDifficulty(raw)) {
    throw new Error(`Unsupported difficulty: one of ${DRILL_DIFFICULTIES.join(', ')}`);
  }

  return raw;
}

// The unique index is the only thing that can hold one-name-per-gym, so its
// violation arrives here as a real outcome: the coach has to be told the name
// is taken so they can find the drill that already carries it.
function nameTaken(error: DrillNameTakenError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: 409 });
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    // Only the authoring roles see what has been retired; to everyone else the
    // library is what the gym teaches now.
    const includeRetired =
      request.nextUrl.searchParams.get('include_retired') === 'true'
      && DRILL_AUTHOR_ROLES.some((role) => role === principal.role);

    const items = await listDrills(principal.organizationId, { includeRetired });

    // Typed against the shape both clients import, so renaming a key here is a
    // compile error there rather than a library that silently renders empty.
    // Typed against the shape both clients import, so renaming a key here is a
    // compile error there rather than a library that silently renders empty.
    const body: DrillLibraryResponse = {
      ok: true,
      organization_id: principal.organizationId,
      items,
    };
    return NextResponse.json(body);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const drill = await createDrill({
      organizationId: principal.organizationId,
      name: requireText(body.name, 'name'),
      category: requireText(body.category, 'category'),
      focus: requireText(body.focus, 'focus'),
      cues: parseCues(body.cues),
      difficulty: parseDifficulty(body.difficulty),
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'drill',
      entity_id: drill.drill_id,
      details: { name: drill.name, category: drill.category, difficulty: drill.difficulty },
    });

    return NextResponse.json(
      { ok: true, organization_id: principal.organizationId, drill },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DrillNameTakenError) {
      return nameTaken(error);
    }
    return jsonError(error);
  }
}

// Edits a drill, and retires or restores one: `active: false` takes a drill out
// of the library and leaves every assignment that references it intact.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_AUTHOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const drillId = requireText(body.drill_id, 'drill_id');

    if (body.active !== undefined && typeof body.active !== 'boolean') {
      throw new Error('Unsupported active');
    }

    const drill = await updateDrill({
      organizationId: principal.organizationId,
      drillId,
      name: optionalText(body.name, 'name'),
      category: optionalText(body.category, 'category'),
      focus: optionalText(body.focus, 'focus'),
      cues: parseCues(body.cues),
      difficulty: parseDifficulty(body.difficulty),
      active: body.active as boolean | undefined,
    });

    // An update that matched no row must not read as a successful edit, or the
    // coach walks away believing a drill was retired.
    if (!drill) {
      throw new Error('Not found');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'drill',
      entity_id: drill.drill_id,
      details: { name: drill.name, difficulty: drill.difficulty, active: drill.active },
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, drill });
  } catch (error) {
    if (error instanceof DrillNameTakenError) {
      return nameTaken(error);
    }
    return jsonError(error);
  }
}
