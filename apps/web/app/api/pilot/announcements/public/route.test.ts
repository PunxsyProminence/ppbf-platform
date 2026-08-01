import { NextRequest } from 'next/server';

import { GET } from './route';
import { listLiveAnnouncements } from '@/src/server/pilot/announcements';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';

jest.mock('@/src/server/pilot/announcements', () => ({
  listLiveAnnouncements: jest.fn(),
}));

jest.mock('@/src/server/pilot/env', () => ({
  getPilotDefaultOrganizationId: jest.fn(() => 'ppbf-default-org'),
}));

const mockListLiveAnnouncements = listLiveAnnouncements as jest.MockedFunction<typeof listLiveAnnouncements>;
const mockGetDefaultOrg = getPilotDefaultOrganizationId as jest.MockedFunction<
  typeof getPilotDefaultOrganizationId
>;

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/announcements/public', () => {
  test('returns announcements for the default org without requiring auth', async () => {
    mockListLiveAnnouncements.mockResolvedValueOnce([
      {
        announcement_id: 'a1',
        organization_id: 'ppbf-default-org',
        message: 'Gloves on at 5.',
        author_name: 'Coach M.',
        author_role: 'coach',
        created_at: '2026-07-30T12:00:00.000Z',
        placement: 'gym_notices',
        kind: 'notice',
        active: true,
        starts_at: null,
        ends_at: null,
      },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/pilot/announcements/public?limit=3'));

    expect(res.status).toBe(200);
    expect(mockGetDefaultOrg).toHaveBeenCalled();
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('ppbf-default-org', {
      placement: 'gym_notices',
      kind: 'notice',
      limit: 3,
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      organization_id: 'ppbf-default-org',
      announcements: [{ message: 'Gloves on at 5.' }],
    });
  });

  test('clamps limit to 1–8 and never reads a caller org id', async () => {
    mockListLiveAnnouncements.mockResolvedValueOnce([]);

    const res = await GET(
      new NextRequest('http://localhost/api/pilot/announcements/public?limit=99&organization_id=evil-org'),
    );

    expect(res.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('ppbf-default-org', {
      placement: 'gym_notices',
      kind: 'notice',
      limit: 8,
    });
  });

  // The signed-out feed is the one announcement read an anonymous caller can
  // reach, so the surface it serves is fixed here and not selectable.
  test('a caller-supplied placement or kind cannot widen the anonymous read', async () => {
    mockListLiveAnnouncements.mockResolvedValueOnce([]);

    const res = await GET(
      new NextRequest(
        'http://localhost/api/pilot/announcements/public?placement=coach_workspace&kind=motivation',
      ),
    );

    expect(res.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledWith('ppbf-default-org', {
      placement: 'gym_notices',
      kind: 'notice',
      limit: 3,
    });
  });
});
