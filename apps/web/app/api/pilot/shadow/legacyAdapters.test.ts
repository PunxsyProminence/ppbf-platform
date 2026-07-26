import { NextRequest, NextResponse } from 'next/server';

import { POST as athletePost } from '@/app/api/pilot/athlete/chat/route';
import { POST as boardPost } from '@/app/api/pilot/board/chat/route';
import { POST as coachPost } from '@/app/api/pilot/coach/chat/route';
import { POST as individualPost } from '@/app/api/pilot/individual/chat/route';
import { POST as canonicalPost } from '@/app/api/pilot/shadow/chat/route';
import { requireRole } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/app/api/pilot/shadow/chat/route', () => ({
  POST: jest.fn(),
}));
jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  jsonError: jest.fn(() => NextResponse.json({ error: 'denied' }, { status: 403 })),
}));
jest.mock('@/src/server/pilot/access', () => ({
  requireRole: jest.fn(),
}));

const mockedCanonicalPost = canonicalPost as jest.MockedFunction<typeof canonicalPost>;
const mockedRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockedRequireRole = requireRole as jest.MockedFunction<typeof requireRole>;

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/legacy/chat', {
    method: 'POST',
    headers: { cookie: 'ppbf_pilot_session=test-session' },
    body: JSON.stringify(body),
  });
}

describe('legacy SHADOW chat compatibility adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRequirePrincipal.mockResolvedValue({
      accountId: 'account-a',
      organizationId: 'org-a',
      athleteId: 'athlete-a',
      role: 'coach',
      sessionToken: 'session',
      authProvider: 'ppbf_local',
    });
    mockedCanonicalPost.mockResolvedValue(
      NextResponse.json({ success: true, state: 'ok' }) as never,
    );
  });

  it('routes coach and individual traffic through the canonical handler', async () => {
    await coachPost(request({ message: 'coach question' }));
    expect(mockedCanonicalPost).toHaveBeenCalledTimes(1);
    expect(mockedRequireRole).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-a' }),
      ['organization_admin', 'admin', 'coach'],
    );

    mockedRequirePrincipal.mockResolvedValueOnce({
      accountId: 'parent-a',
      organizationId: 'org-a',
      athleteId: null,
      role: 'parent',
      sessionToken: 'session',
      authProvider: 'ppbf_local',
    });
    await individualPost(request({ message: 'parent question' }));
    expect(mockedCanonicalPost).toHaveBeenCalledTimes(2);
  });

  it('drops client organization scope and overwrites athlete scope with the authenticated identity', async () => {
    mockedRequirePrincipal.mockResolvedValueOnce({
      accountId: 'account-a',
      organizationId: 'org-a',
      athleteId: 'athlete-a',
      role: 'athlete',
      sessionToken: 'session',
      authProvider: 'ppbf_local',
    });

    await athletePost(request({
      message: 'my training',
      athleteId: 'athlete-b',
      organizationId: 'org-b',
    }));

    const forwarded = mockedCanonicalPost.mock.calls[0][0];
    await expect(forwarded.json()).resolves.toEqual({
      message: 'my training',
      athleteId: 'athlete-a',
    });
  });

  it('forces the old board endpoint through board-summary mode', async () => {
    mockedRequirePrincipal.mockResolvedValueOnce({
      accountId: 'admin-a',
      organizationId: 'org-a',
      athleteId: null,
      role: 'organization_admin',
      sessionToken: 'session',
      authProvider: 'ppbf_local',
    });

    await boardPost(request({ message: 'governance summary', sessionType: 'heavy_bag' }));

    const forwarded = mockedCanonicalPost.mock.calls[0][0];
    await expect(forwarded.json()).resolves.toMatchObject({
      message: 'governance summary',
      sessionType: 'board_summary',
    });
  });
});
