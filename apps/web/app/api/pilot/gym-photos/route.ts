import { NextResponse, type NextRequest } from 'next/server';

import { listPilotGymWallSlotKeys } from '@/src/server/pilot/blob';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { GYM_PHOTO_SLOTS } from '@/src/shared/gymPhotos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which gym-wall slots hold an admin-uploaded photograph for the caller's
 * organization, and where to fetch each one.
 *
 * Any signed-in member may ask: the wall is a shared dashboard surface shown to
 * everyone in the gym, so its existence answer is not a disclosure the way a
 * portrait's is. The organization comes from the principal and nowhere else --
 * there is no organization parameter to name another gym with.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const knownKeys = new Set(GYM_PHOTO_SLOTS.map((slot) => slot.key));
    const uploadedKeys = await listPilotGymWallSlotKeys(principal.organizationId);

    const uploads: Record<string, string> = {};
    for (const key of uploadedKeys) {
      // A blob for a slot the manifest no longer names is an orphan, not a
      // frame; it is skipped rather than invented a frame for.
      if (knownKeys.has(key)) uploads[key] = `/api/pilot/gym-photos/${key}`;
    }

    return NextResponse.json({ ok: true, uploads });
  } catch (error) {
    return jsonError(error);
  }
}
