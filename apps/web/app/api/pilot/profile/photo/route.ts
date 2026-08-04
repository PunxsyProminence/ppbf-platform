import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { deletePilotProfilePhoto, uploadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { clearPhoto, getAccountProfile, setPhoto } from '@/src/server/pilot/profileDb';
import {
  describeProfilePhotoUpload,
  stripPhotoMetadata,
  validateProfilePhotoContent,
  validateProfilePhotoTransport,
} from '@/src/server/pilot/profilePhotoPolicy';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from '@/src/server/pilot/shadowRateLimit';

export const runtime = 'nodejs';

/**
 * Upload your own portrait.
 *
 * The route deliberately takes no account id. A member uploads their own face
 * and nobody else's -- a coach cannot upload a photograph of an athlete, and a
 * guardian cannot upload one of their child. That is a policy decision, not an
 * oversight: a portrait is a thing you put up about yourself, and letting an
 * adult publish a picture of a child from a form that never showed the child
 * the picture is the wrong shape for this platform. Staff can TAKE ONE DOWN
 * (see DELETE and /photo/review), which is the direction that needs to be easy.
 *
 * Every role uploads through here -- coach, parent, athlete, staff, admin --
 * because "who's in your corner" only works if the coach has a face too.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const transport = validateProfilePhotoTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ ok: false, error: transport.error }, { status: transport.status });
    }

    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...resolveShadowRateLimit('shadow_upload'),
    });

    const formData = await request.formData();
    const uploaded = formData.get('photo');
    if (!(uploaded instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Missing photo upload.' }, { status: 400 });
    }

    const descriptor = describeProfilePhotoUpload(uploaded);
    if (!descriptor) {
      return NextResponse.json(
        { ok: false, error: 'Only bounded JPEG and PNG photos are accepted.' },
        { status: 415 },
      );
    }

    const uploadBytes = new Uint8Array(await uploaded.arrayBuffer());
    const validation = validateProfilePhotoContent(descriptor, uploadBytes);
    if (!validation.ok || !validation.dimensions) {
      return NextResponse.json(
        { ok: false, error: validation.error },
        { status: validation.status ?? 415 },
      );
    }

    // Strip before storing, never after. A portrait that reaches the container
    // with its EXIF intact has already leaked the coordinates it was taken at,
    // and a later cleanup pass cannot un-store it.
    const storedBytes = stripPhotoMetadata(descriptor.contentType, uploadBytes);
    const contentSha256 = createHash('sha256').update(storedBytes).digest('hex');

    // Path is derived from the account, not from a random id, so one account
    // holds exactly one portrait and a replacement overwrites rather than
    // accumulating a history of a child's faces in a container.
    const blobPath = `portrait/${principal.organizationId}/${principal.accountId}/${descriptor.generatedFileName}`;

    await uploadPilotProfilePhoto(blobPath, storedBytes, descriptor.contentType);
    await setPhoto(principal.organizationId, principal.accountId, {
      blobPath,
      contentType: descriptor.contentType,
      bytes: storedBytes.byteLength,
      width: validation.dimensions.width,
      height: validation.dimensions.height,
      sha256: contentSha256,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile_photo',
      entity_id: principal.accountId,
      details: {
        action: 'photo_uploaded',
        content_type: descriptor.contentType,
        stored_bytes: storedBytes.byteLength,
        width: validation.dimensions.width,
        height: validation.dimensions.height,
        metadata_stripped_bytes: uploadBytes.byteLength - storedBytes.byteLength,
        review_state: 'pending_review',
      },
      shadow_mirror: false,
    });

    return NextResponse.json(
      {
        ok: true,
        review_state: 'pending_review',
        width: validation.dimensions.width,
        height: validation.dimensions.height,
        stored_bytes: storedBytes.byteLength,
        // Say what actually happens next, rather than reporting success and
        // leaving the member to work out why nobody can see it.
        message: 'Uploaded. Only you can see it until a coach or an administrator releases it.',
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'photo upload') },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}

/** Remove your own portrait. The bytes go, not a flag. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    const profile = await getAccountProfile(principal.organizationId, principal.accountId);
    if (profile.photoBlobPath) {
      await deletePilotProfilePhoto(profile.photoBlobPath);
    }
    await clearPhoto(principal.organizationId, principal.accountId, 'removed', principal.accountId);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'account_profile_photo',
      entity_id: principal.accountId,
      details: { action: 'photo_removed_by_self' },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
