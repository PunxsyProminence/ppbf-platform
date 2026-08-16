import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listCueLibrary } from '@/src/server/pilot/drillLibraryV3';

export const runtime = 'nodejs';

// The cue library read (register module 114): the same access posture as the
// drill-library browse it is a view over -- any signed-in member of the
// organization reads coaching craft; org isolation comes from the principal.
// Read-only by design: cue authoring stays inside drill records, where the
// scaling manual's cue-family discipline lives.

const FOCUS_TYPES = new Set(['external', 'internal', 'analogy', 'constraint', 'unspecified']);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

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
