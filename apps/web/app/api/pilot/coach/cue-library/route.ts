import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listCueLibrary } from '@/src/server/pilot/drillLibraryV3';

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

    const items = await listCueLibrary(principal.organizationId, {
      focusType,
      search: searchParams.get('search') ?? undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
