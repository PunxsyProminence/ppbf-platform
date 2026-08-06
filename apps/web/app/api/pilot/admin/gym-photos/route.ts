import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  deletePilotGymWallPhoto,
  listPilotGymWallSlotKeys,
  uploadPilotGymWallPhoto,
} from '@/src/server/pilot/blob';
import {
  describeGymWallUpload,
  stripGymWallMetadata,
  validateGymWallContent,
  validateGymWallTransport,
} from '@/src/server/pilot/gymWallPolicy';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { GYM_PHOTO_SLOTS } from '@/src/shared/gymPhotos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE ADMIN'S SIDE OF THE GYM WALL -- upload and take down building
 * photographs from /admin/gym-photos.
 *
 * The release rule is the manifest's rule with a different verb: a person who
 * can see the picture decides it goes up. Clicking upload in front of the
 * actual photograph is that decision; this route just checks the person is an
 * admin of this gym and the bytes are what they claim to be.
 *
 * The organization is the principal's, full stop. There is no organization
 * parameter, so an admin of gym A cannot hang a photograph on gym B's wall,
 * and the organizationScope convention test has nothing here to flag.
 *
 * People rules are enforced by a person, not a classifier: the platform cannot
 * look at a photograph and know whether the person in it consented, so it does
 * not pretend to. What it CAN enforce it does -- EXIF/GPS stripped before
 * storage, format allowlist, private container, no signed URLs.
 */

const ADMIN_ROLES = ['platform_owner', 'organization_admin', 'admin'] as const;

function knownSlot(slot: unknown): slot is string {
  return typeof slot === 'string' && GYM_PHOTO_SLOTS.some((entry) => entry.key === slot);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);
    const uploaded = await listPilotGymWallSlotKeys(principal.organizationId);
    return NextResponse.json({ ok: true, uploaded });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const transport = validateGymWallTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ ok: false, error: transport.error }, { status: transport.status });
    }

    const formData = await request.formData();
    const slot = formData.get('slot');
    if (!knownSlot(slot)) {
      return NextResponse.json({ ok: false, error: 'Unknown wall slot.' }, { status: 400 });
    }
    const uploaded = formData.get('photo');
    if (!(uploaded instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Missing photo upload.' }, { status: 400 });
    }

    const descriptor = describeGymWallUpload(uploaded);
    if (!descriptor) {
      return NextResponse.json(
        { ok: false, error: 'Only bounded JPEG and PNG photos are accepted.' },
        { status: 415 },
      );
    }

    const uploadBytes = new Uint8Array(await uploaded.arrayBuffer());
    const validation = validateGymWallContent(descriptor.contentType, uploadBytes);
    if (!validation.ok || !validation.dimensions) {
      return NextResponse.json(
        { ok: false, error: validation.error },
        { status: validation.status ?? 415 },
      );
    }

    // Strip before storing, never after -- the room's photo still carries the
    // GPS of the phone that took it.
    const storedBytes = stripGymWallMetadata(descriptor.contentType, uploadBytes);

    await uploadPilotGymWallPhoto(principal.organizationId, slot, storedBytes, descriptor.contentType);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'gym_wall_photo',
      entity_id: slot,
      details: {
        action: 'gym_wall_photo_uploaded',
        content_type: descriptor.contentType,
        stored_bytes: storedBytes.byteLength,
        width: validation.dimensions.width,
        height: validation.dimensions.height,
        metadata_stripped_bytes: uploadBytes.byteLength - storedBytes.byteLength,
      },
      shadow_mirror: false,
    });

    return NextResponse.json({
      ok: true,
      slot,
      width: validation.dimensions.width,
      height: validation.dimensions.height,
      stored_bytes: storedBytes.byteLength,
      message: 'On the wall. It replaces the placeholder illustration everywhere this slot appears.',
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Take one down. The bytes go; the slot falls back to the manifest. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const slot = request.nextUrl.searchParams.get('slot');
    if (!knownSlot(slot)) {
      return NextResponse.json({ ok: false, error: 'Unknown wall slot.' }, { status: 400 });
    }

    await deletePilotGymWallPhoto(principal.organizationId, slot);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'gym_wall_photo',
      entity_id: slot,
      details: { action: 'gym_wall_photo_removed' },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, slot });
  } catch (error) {
    return jsonError(error);
  }
}
