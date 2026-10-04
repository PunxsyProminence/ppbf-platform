import { NextRequest } from 'next/server';

import { GET } from './route';
import { listDevelopmentBlockTemplatesForAthlete } from '@/src/server/pilot/developmentBlockTemplates';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/developmentBlockTemplates', () => ({
  listDevelopmentBlockTemplatesForAthlete: jest.fn(async () => ({
    athlete_is_adult: true,
    templates: [],
    withheld_reason: null,
  })),
}));

const mockedPrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockedList = listDevelopmentBlockTemplatesForAthlete as jest.MockedFunction<
  typeof listDevelopmentBlockTemplatesForAthlete
>;

function principal(role: string): PilotPrincipal {
  return { accountId: 'acct-1', organizationId: 'org-1', role } as unknown as PilotPrincipal;
}

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/coach/development-block-templates${query}`);
}

beforeEach(() => {
  mockedPrincipal.mockReset();
  mockedList.mockClear();
});

describe('GET /api/pilot/coach/development-block-templates', () => {
  it('hands the session principal and athlete to the gated module, opt-in off by default', async () => {
    const coach = principal('coach');
    mockedPrincipal.mockResolvedValue(coach);
    const response = await GET(request('?athlete_id=ath-1'));
    expect(response.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith(coach, 'ath-1', { minorOptIn: false });
  });

  it('passes the opt-in only when it is exactly 1', async () => {
    mockedPrincipal.mockResolvedValue(principal('coach'));
    await GET(request('?athlete_id=ath-1&minor_opt_in=1'));
    expect(mockedList.mock.calls[0][2]).toEqual({ minorOptIn: true });
    await GET(request('?athlete_id=ath-1&minor_opt_in=true'));
    expect(mockedList.mock.calls[1][2]).toEqual({ minorOptIn: false });
  });

  it('refuses without an athlete', async () => {
    mockedPrincipal.mockResolvedValue(principal('coach'));
    const response = await GET(request(''));
    expect(response.status).toBe(400);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it.each(['athlete', 'parent', 'platform_owner', 'board'])('refuses role %s', async (role) => {
    mockedPrincipal.mockResolvedValue(principal(role));
    const response = await GET(request('?athlete_id=ath-1'));
    expect(response.status).toBe(403);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('declares no write verb', async () => {
    const route = await import('./route');
    for (const verb of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect((route as Record<string, unknown>)[verb]).toBeUndefined();
    }
  });
});
