import { NextRequest } from 'next/server';

import { GET } from './route';
import { listAnnouncements } from '@/src/server/pilot/announcements';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';

jest.mock('@/src/server/pilot/announcements', () => ({
  listAnnouncements: jest.fn(),
}));

jest.mock('@/src/server/pilot/env', () => ({
  getPilotDefaultOrganizationId: jest.fn(() => 'ppbf-default-org'),
}));

const mockListAnnouncements = listAnnouncements as jest.MockedFunction<typeof listAnnouncements>;
const mockGetDefaultOrg = getPilotDefaultOrganizationId as jest.MockedFunction<
  typeof getPilotDefaultOrganizationId
>;

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/announcements/public', () => {
  test('returns announcements for the default org without requiring auth', async () => {
    mockListAnnouncements.mockResolvedValueOnce([
      {
        announcement_id: 'a1',
        organization_id: 'ppbf-default-org',
        message: 'Gloves on at 5.',
        author_name: 'Coach M.',
        author_role: 'coach',
        created_at: '2026-07-30T12:00:00.000Z',
      },
    ]);

    const res = await GET(new NextRequest('http://localhost/api/pilot/announcements/public?limit=3'));

    expect(res.status).toBe(200);
    expect(mockGetDefaultOrg).toHaveBeenCalled();
    expect(mockListAnnouncements).toHaveBeenCalledWith('ppbf-default-org', 3);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      organization_id: 'ppbf-default-org',
      announcements: [{ message: 'Gloves on at 5.' }],
    });
  });

  test('clamps limit to 1–8 and never reads a caller org id', async () => {
    mockListAnnouncements.mockResolvedValueOnce([]);

    const res = await GET(
      new NextRequest('http://localhost/api/pilot/announcements/public?limit=99&organization_id=evil-org'),
    );

    expect(res.status).toBe(200);
    expect(mockListAnnouncements).toHaveBeenCalledWith('ppbf-default-org', 8);
  });
});
