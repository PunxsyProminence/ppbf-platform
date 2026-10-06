import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { deletePilotProfilePhoto, uploadPilotProfilePhoto } from '@/src/server/pilot/blob';
import { getAccountProfile, setPhoto } from '@/src/server/pilot/profileDb';
import { describeProfilePhotoUpload } from '@/src/server/pilot/profilePhotoPolicy';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/blob', () => ({
  uploadPilotProfilePhoto: jest.fn().mockResolvedValue(undefined),
  deletePilotProfilePhoto: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/profileDb', () => ({
  getAccountProfile: jest.fn(),
  setPhoto: jest.fn().mockResolvedValue(undefined),
  clearPhoto: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn().mockResolvedValue(undefined) };
});

/* The image checks have their own suite (profilePhotoPolicy.test.ts). Here the
   descriptor stays REAL -- it picks the stored name, which is the whole of
   CL-B9 -- and only the byte-level checks are doubled. */
jest.mock('@/src/server/pilot/profilePhotoPolicy', () => {
  const actual = jest.requireActual('@/src/server/pilot/profilePhotoPolicy');
  return {
    ...actual,
    validateProfilePhotoTransport: jest.fn().mockReturnValue({ ok: true }),
    validateProfilePhotoContent: jest.fn().mockReturnValue({ ok: true, dimensions: { width: 400, height: 400 } }),
    stripPhotoMetadata: jest.fn((_type: string, bytes: Uint8Array) => bytes),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAccountProfile = getAccountProfile as jest.Mock;
const mockSetPhoto = setPhoto as jest.Mock;
const mockDelete = deletePilotProfilePhoto as jest.Mock;
const mockUpload = uploadPilotProfilePhoto as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

const member: PilotPrincipal = {
  accountId: 'kid-1',
  role: 'athlete',
  organizationId: 'org-1',
  athleteId: 'ath-1',
  sessionToken: 'token',
  authProvider: 'ppbf_local',
};

function photoRequest(name: string, type: string) {
  const formData = new FormData();
  formData.append('photo', new File([new Uint8Array(64).fill(7)], name, { type }));
  return new NextRequest('http://localhost/api/pilot/profile/photo', { method: 'POST', body: formData });
}

function existingPhoto(blobPath: string | null) {
  mockGetAccountProfile.mockResolvedValue({ photoBlobPath: blobPath });
}

/*
 * Audit CL-B9. The stored name used to follow the type, so a JPEG replaced by
 * a PNG (or the reverse) wrote a second file and the first -- a child's
 * earlier face, possibly one a reviewer would have blocked -- stayed in the
 * container with nothing pointing at it. Now there is one name, and a
 * portrait stored under an old name is deleted once the row has moved off it.
 */
describe('POST /api/pilot/profile/photo -- replacing a portrait', () => {
  test('the stored name does not depend on the type, so a replacement always overwrites', () => {
    expect(describeProfilePhotoUpload({ name: 'a.jpg', type: 'image/jpeg', size: 10 })?.generatedFileName).toBe('portrait');
    expect(describeProfilePhotoUpload({ name: 'a.png', type: 'image/png', size: 10 })?.generatedFileName).toBe('portrait');
  });

  test('a PNG and a JPEG both land on the one path, with the type in the header', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member).mockResolvedValueOnce(member);
    existingPhoto(null);

    await POST(photoRequest('me.png', 'image/png'));
    await POST(photoRequest('me.jpg', 'image/jpeg'));

    expect(mockUpload).toHaveBeenNthCalledWith(1, 'portrait/org-1/kid-1/portrait', expect.anything(), 'image/png');
    expect(mockUpload).toHaveBeenNthCalledWith(2, 'portrait/org-1/kid-1/portrait', expect.anything(), 'image/jpeg');
    expect(mockSetPhoto).toHaveBeenLastCalledWith('org-1', 'kid-1', expect.objectContaining({
      blobPath: 'portrait/org-1/kid-1/portrait',
      contentType: 'image/jpeg',
    }));
  });

  test("the previous path is read for the uploader's own account, nobody else's", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto(null);

    await POST(photoRequest('me.png', 'image/png'));

    expect(mockGetAccountProfile).toHaveBeenCalledWith('org-1', 'kid-1');
  });

  test('a portrait stored under the old .jpg name is deleted after the row moves to the new name', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/kid-1/portrait.jpg');

    const res = await POST(photoRequest('me.png', 'image/png'));

    expect(res.status).toBe(202);
    expect(mockUpload).toHaveBeenCalledWith('portrait/org-1/kid-1/portrait', expect.anything(), 'image/png');
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('portrait/org-1/kid-1/portrait.jpg');
    // Order: the old file goes only once nothing points at it.
    expect(mockSetPhoto.mock.invocationCallOrder[0]).toBeLessThan(mockDelete.mock.invocationCallOrder[0]);
  });

  test('a portrait stored under the old .png name is deleted too', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/kid-1/portrait.png');

    await POST(photoRequest('me.jpg', 'image/jpeg'));

    expect(mockDelete).toHaveBeenCalledWith('portrait/org-1/kid-1/portrait.png');
  });

  test('already on the one name: the upload overwrote it, so nothing is deleted', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/kid-1/portrait');

    const res = await POST(photoRequest('me.png', 'image/png'));

    expect(res.status).toBe(202);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][0].details).not.toHaveProperty('previous_photo_deleted');
  });

  test('first portrait: nothing to delete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto(null);

    await POST(photoRequest('me.png', 'image/png'));

    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('a stored path outside this account\'s own folder is never deleted from here', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/someone-else/portrait.jpg');

    await POST(photoRequest('me.png', 'image/png'));

    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('if the old file cannot be deleted, the new portrait still stands and the audit says so', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/kid-1/portrait.jpg');
    mockDelete.mockRejectedValueOnce(new Error('storage down'));

    const res = await POST(photoRequest('me.png', 'image/png'));

    expect(res.status).toBe(202);
    expect(mockSetPhoto).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ previous_photo_deleted: false }),
    }));
  });

  test('a successful replacement records that the old file went', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(member);
    existingPhoto('portrait/org-1/kid-1/portrait.jpg');

    await POST(photoRequest('me.png', 'image/png'));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ previous_photo_deleted: true }),
    }));
  });
});
