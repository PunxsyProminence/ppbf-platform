/**
 * @jest-environment jsdom
 */

// The gate this page used to have was a client-side `router.replace` driven by
// `readRoleSession()`, which reads an IN-MEMORY cache and nothing else. On any
// cold load -- a new tab, a hard refresh, a pasted link -- that cache is empty,
// so every user including an admin was bounced to /login and could not recover
// (`userRole` was a `useState` with no setter). And because the redirect WAS
// the refusal, a denied role saw the header and the "Generate scout report"
// control render first.
//
// Both are asserted here against the real RoleSessionGate, so the cold-load
// path is exercised the way a browser exercises it: nothing in the module
// cache, everything decided by the server's session response.

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import ScoutReportPage from './page';
import { clearRoleSession } from '@/components/roleSession';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;

const originalFetch = global.fetch;

function session(role: PilotSessionState['role']): PilotSessionState {
  return {
    role,
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'someone@punxsyprominence.org',
    mustChangePin: false,
    loading: false,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function scoutFetchMock(sessionRole: string) {
  return jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/auth/session')) {
      return jsonResponse({
        authenticated: true,
        role: sessionRole,
        auth_provider: 'microsoft',
        organization_id: 'org-1',
        account_id: 'someone@punxsyprominence.org',
      });
    }
    if (target.includes('/shadow/jobs')) {
      return jsonResponse({ ok: true, jobs: [] });
    }
    return jsonResponse({ ok: true, metrics: null });
  });
}

beforeEach(() => {
  // A cold load: no role has ever been cached in this module instance.
  clearRoleSession();
  replace.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

it('opens on a cold load for an admin instead of redirecting to /login', async () => {
  global.fetch = scoutFetchMock('organization_admin') as unknown as typeof fetch;
  mockUsePilotSession.mockReturnValue(session('organization_admin'));

  render(<ScoutReportPage />);

  await screen.findByRole('heading', { level: 1, name: 'Scout Reports' });
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /generate scout report/i })).toBeTruthy();
});

it('refuses in place rather than showing the generate control to a role the report is not scoped for', async () => {
  global.fetch = scoutFetchMock('board') as unknown as typeof fetch;
  mockUsePilotSession.mockReturnValue(session('board'));

  render(<ScoutReportPage />);

  const stamp = await screen.findByText('WRONG DOOR');
  expect(stamp).toBeTruthy();
  expect(screen.queryByRole('button', { name: /generate scout report/i })).toBeNull();
  expect(screen.queryByRole('heading', { level: 1, name: 'Scout Reports' })).toBeNull();
});

it('carries the authority boundary onto the report surface', async () => {
  global.fetch = scoutFetchMock('admin') as unknown as typeof fetch;
  mockUsePilotSession.mockReturnValue(session('admin'));

  render(<ScoutReportPage />);

  await waitFor(() => expect(
    screen.getByText(/SHADOW cannot clear, diagnose, prescribe, or override human authority\./),
  ).toBeTruthy());
});

it('keeps the medical red off a failed load', async () => {
  // Thrown synchronously: loadData wraps its requests in Promise.allSettled, so
  // only a fetch that fails before the array is built reaches its catch.
  global.fetch = jest.fn((url: string) => {
    const target = String(url);
    if (target.includes('/auth/session')) {
      return Promise.resolve(jsonResponse({ authenticated: true, role: 'admin', auth_provider: 'microsoft' }));
    }
    throw new Error('network down');
  }) as unknown as typeof fetch;
  mockUsePilotSession.mockReturnValue(session('admin'));

  render(<ScoutReportPage />);

  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('var(--restricted)');
  expect(alert.className).not.toContain('var(--locked)');
  expect(alert.querySelector('.badge--restricted')).toBeTruthy();
  expect(alert.querySelector('.badge--locked')).toBeNull();
});

// #991 class (Lane 14 batch 8, C8). The jobs read had no else: a refused or
// rejected read left the list empty and the page said "Scout Reports (0)" and
// "No Scout Reports yet" over a read that never answered.
describe('a failed Scout Reports read', () => {
  function failJobs(jobs: () => Promise<Response>) {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/auth/session')) {
        return jsonResponse({ authenticated: true, role: 'admin', auth_provider: 'microsoft' });
      }
      if (target.includes('/shadow/jobs')) return jobs();
      return jsonResponse({ ok: true, metrics: null });
    }) as unknown as typeof fetch;
    mockUsePilotSession.mockReturnValue(session('admin'));
  }

  it.each([
    ['refused', async () => jsonResponse({ error: 'nope' }, false, 500)],
    ['rejected', async (): Promise<Response> => { throw new TypeError('Failed to fetch'); }],
  ])('when %s, says so and claims neither "none" nor a zero', async (_name, jobs) => {
    failJobs(jobs);

    render(<ScoutReportPage />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Scout Reports could not be loaded.'));
    expect(screen.queryByText(/No Scout Reports yet/)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Scout Reports (--)' })).toBeTruthy();
    expect(screen.getByText('Not available -- the reports could not be read.')).toBeTruthy();
  });

  it('a metrics failure does not hide reports that loaded', async () => {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/auth/session')) {
        return jsonResponse({ authenticated: true, role: 'admin', auth_provider: 'microsoft' });
      }
      if (target.includes('/shadow/jobs')) return jsonResponse({ ok: true, jobs: [] });
      // A 2xx whose body does not parse: the metrics read throws after jobs landed.
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON'); } } as unknown as Response;
    }) as unknown as typeof fetch;
    mockUsePilotSession.mockReturnValue(session('admin'));

    render(<ScoutReportPage />);

    expect(await screen.findByText(/No Scout Reports yet/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Scout Reports (0)' })).toBeTruthy();
    expect(screen.queryByText('Not available -- the reports could not be read.')).toBeNull();
  });

  it('a read that answered empty still says there are none yet', async () => {
    failJobs(async () => jsonResponse({ ok: true, jobs: [] }));

    render(<ScoutReportPage />);

    expect(await screen.findByText(/No Scout Reports yet/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Scout Reports (0)' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// #991 class, batch 9: the metrics read had no else either. A refused or
// unreadable read hid both scorecard sections and said nothing.
describe('a failed Scorecard read', () => {
  function withMetrics(metrics: () => Promise<Response>) {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/auth/session')) {
        return jsonResponse({ authenticated: true, role: 'admin', auth_provider: 'microsoft' });
      }
      if (target.includes('/shadow/jobs')) return jsonResponse({ ok: true, jobs: [] });
      return metrics();
    }) as unknown as typeof fetch;
    mockUsePilotSession.mockReturnValue(session('admin'));
  }

  it.each([
    ['refused', async () => jsonResponse({ error: 'nope' }, false, 500)],
    ['rejected', async (): Promise<Response> => { throw new TypeError('Failed to fetch'); }],
    ['unreadable', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response],
  ])('when %s, says the Scorecard could not be read', async (_name, metrics) => {
    withMetrics(metrics);

    render(<ScoutReportPage />);

    expect(await screen.findByText('Not available -- The Scorecard could not be read.')).toBeTruthy();
  });

  it('a throw before the metrics answer is read still says so', async () => {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/auth/session')) {
        return jsonResponse({ authenticated: true, role: 'admin', auth_provider: 'microsoft' });
      }
      // The jobs body does not parse, so the metrics block is never reached.
      if (target.includes('/shadow/jobs')) {
        return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } } as unknown as Response;
      }
      return jsonResponse({ ok: true, metrics: null });
    }) as unknown as typeof fetch;
    mockUsePilotSession.mockReturnValue(session('admin'));

    render(<ScoutReportPage />);

    expect(await screen.findByText('Not available -- The Scorecard could not be read.')).toBeTruthy();
    expect(screen.getByText('Not available -- the reports could not be read.')).toBeTruthy();
  });

  it('a read that answered says nothing about being unavailable', async () => {
    withMetrics(async () => jsonResponse({ ok: true, metrics: null }));

    render(<ScoutReportPage />);

    expect(await screen.findByText(/No Scout Reports yet/)).toBeTruthy();
    expect(screen.queryByText(/The Scorecard could not be read/)).toBeNull();
  });

  it('a coach, who does not read metrics, is told nothing about them', async () => {
    global.fetch = scoutFetchMock('coach') as unknown as typeof fetch;
    mockUsePilotSession.mockReturnValue(session('coach'));

    render(<ScoutReportPage />);

    expect(await screen.findByText(/No Scout Reports yet/)).toBeTruthy();
    expect(screen.queryByText(/The Scorecard could not be read/)).toBeNull();
  });
});
