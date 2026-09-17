import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listAthleteCueLibrary, listCueLibrary } from '@/src/server/pilot/drillLibraryV3';

export const runtime = 'nodejs';

// The cue library read (register module 114): the same access posture as the
// drill-library browse it is a view over -- which is now a shared constant
// rather than a shared intention. Module 114's "Roles that may read / write"
// checklist was still unticked while this file asserted a posture; it is
// ticked by coachingContentAccess.ts, and "any signed-in member of the
// organization" turned out to mean one role fewer than this route admitted:
// the board is oversight, not coaching craft. Org isolation is unchanged and
// still comes from the principal.
// Read-only by design: cue authoring stays inside drill records, where the
// scaling manual's cue-family discipline lives.

const FOCUS_TYPES = new Set(['external', 'internal', 'analogy', 'constraint', 'unspecified']);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    const { searchParams } = new URL(request.url);
    const focusType = searchParams.get('focus_type') ?? undefined;
    if (focusType !== undefined && !FOCUS_TYPES.has(focusType)) {
      throw new ValidationError('Unknown focus_type.');
    }

    // W-D2, owner rule of 2026-09-17. This route is the SECOND door into
    // pilot.drill_library instructional content, and it is gated on the same
    // eight-role reader list as the drill-library browse -- so narrowing that
    // route alone would have left "athletes read reference content only after
    // promotion" false here, through cues, with the cue's grounding note
    // attached. The narrowing therefore travels with the content, not with the
    // route name.
    //
    // For an athlete: only cues belonging to a reference drill this gym has
    // adopted and still runs, and evidence_note and source_ref are not selected
    // at all. Every other reader role gets the full cue library unchanged.
    const filter = { focusType, search: searchParams.get('search') ?? undefined };
    const items = principal.role === 'athlete'
      ? await listAthleteCueLibrary(principal.organizationId, filter)
      : await listCueLibrary(principal.organizationId, filter);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
