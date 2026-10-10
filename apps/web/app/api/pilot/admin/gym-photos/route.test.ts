// The gym wall is gym work, done from the gym's own account. This suite pins
// who may reach each verb: the gym's admin may, the platform owner may not
// (OD-2026-10-02-015 D3, "platform for platform, gym for gym";
// OD-2026-10-08-003 R2 and PLAN-3, every verb in this file).

import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
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
import { requirePrincipal } from '@/src/server/pilot/http';
import { GYM_PHOTO_SLOTS } from '@/src/shared/gymPhotos';

// requireRole and jsonError stay real: the role gate is what this suite proves.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/blob', () => ({
  deletePilotGymWallPhoto: jest.fn(),
  listPilotGymWallSlotKeys: jest.fn(),
  uploadPilotGymWallPhoto: jest.fn(),
}));
// The image checks have their own suite; here they pass, so the only thing
// that can refuse a request is the gate.
jest.mock('@/src/server/pilot/gymWallPolicy', () => ({
  describeGymWallUpload: jest.fn(),
  stripGymWallMetadata: jest.fn(),
  validateGymWallContent: jest.fn(),
  validateGymWallTransport: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockList = jest.mocked(listPilotGymWallSlotKeys);
const mockUpload = jest.mocked(uploadPilotGymWallPhoto);
const mockDelete = jest.mocked(deletePilotGymWallPhoto);

const SLOT = GYM_PHOTO_SLOTS[0].key;
const URL_BASE = 'http://localhost/api/pilot/admin/gym-photos';

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: 'org-1', role,
  } as never);
}

function get() {
  return new NextRequest(URL_BASE);
}

function upload() {
  const form = new FormData();
  form.set('slot', SLOT);
  form.set('photo', new File([new Uint8Array([1, 2, 3, 4])], 'wall.jpg', { type: 'image/jpeg' }));
  return new NextRequest(URL_BASE, { method: 'POST', body: form });
}

function remove() {
  return new NextRequest(`${URL_BASE}?slot=${SLOT}`, { method: 'DELETE' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([SLOT] as never);
  mockUpload.mockResolvedValue(undefined as never);
  mockDelete.mockResolvedValue(undefined as never);
  mockAudit.mockResolvedValue(undefined as never);
  jest.mocked(validateGymWallTransport).mockReturnValue({ ok: true } as never);
  jest.mocked(describeGymWallUpload).mockReturnValue({ contentType: 'image/jpeg' } as never);
  jest.mocked(validateGymWallContent).mockReturnValue({
    ok: true, dimensions: { width: 1200, height: 800 },
  } as never);
  jest.mocked(stripGymWallMetadata).mockImplementation((_type, bytes) => bytes);
});

describe('platform owner is kept off the gym wall', () => {
  test('GET is refused before the wall is listed', async () => {
    as('platform_owner');

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('POST is refused before anything is stored or audited', async () => {
    as('platform_owner');

    const response = await POST(upload());

    expect(response.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('DELETE is refused before anything is taken down or audited', async () => {
    as('platform_owner');

    const response = await DELETE(remove());

    expect(response.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe.each(['organization_admin', 'admin'])('the gym admin (%s) works the wall', (role) => {
  test('GET lists the uploaded slots of the caller\'s own gym', async () => {
    as(role);

    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, uploaded: [SLOT] });
    expect(mockList).toHaveBeenCalledWith('org-1');
  });

  test('POST stores the photo in the caller\'s own gym and audits it', async () => {
    as(role);

    const response = await POST(upload());

    expect(response.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledWith('org-1', SLOT, expect.any(Uint8Array), 'image/jpeg');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      entity_type: 'gym_wall_photo',
      entity_id: SLOT,
      details: expect.objectContaining({ action: 'gym_wall_photo_uploaded' }),
    }));
  });

  test('DELETE takes the photo down from the caller\'s own gym and audits it', async () => {
    as(role);

    const response = await DELETE(remove());

    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith('org-1', SLOT);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      entity_type: 'gym_wall_photo',
      details: { action: 'gym_wall_photo_removed' },
    }));
  });
});

// Unchanged by this lane, pinned so the narrowed list is seen to have dropped
// one role and admitted none.
test.each(['coach', 'athlete', 'parent', 'board'])('role %s is refused on every verb', async (role) => {
  as(role);

  expect((await GET(get())).status).toBe(403);
  expect((await POST(upload())).status).toBe(403);
  expect((await DELETE(remove())).status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});
