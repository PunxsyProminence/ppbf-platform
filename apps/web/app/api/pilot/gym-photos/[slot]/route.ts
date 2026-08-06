import { type NextRequest } from 'next/server';

import { downloadPilotGymWallPhoto } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { GYM_PHOTO_SLOTS } from '@/src/shared/gymPhotos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve one gym-wall photograph.
 *
 * An authenticated byte stream, not a link -- the same stance as portraits and
 * for the same structural reason: this container mints no SAS URLs, so there is
 * nothing here for a cache or a chat paste to hold onto. The photograph is a
 * picture of the building, but it was uploaded by a person who may later want
 * it gone, and no-store is what makes a takedown mean something.
 *
 * The organization comes from the principal only. A member of gym A asking for
 * gym B's wall is not an addressable request in this route's vocabulary.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slot: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    const { slot } = await params;

    if (!GYM_PHOTO_SLOTS.some((entry) => entry.key === slot)) return hiddenNotFound();

    const photo = await downloadPilotGymWallPhoto(principal.organizationId, slot);
    if (!photo) return hiddenNotFound();

    return new Response(new Uint8Array(photo.bytes), {
      status: 200,
      headers: {
        'Content-Type': photo.contentType,
        'Content-Length': String(photo.bytes.byteLength),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
