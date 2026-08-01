/**
 * @jest-environment jsdom
 */

// The capability console persists governance in the background, so a refused or
// failed request has no visible symptom of its own: the screen keeps showing the
// edit that was never stored. These cover the two ways that goes wrong.

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import AdminCapabilitiesPage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/RevenueFundingCenter', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/ShadowChatButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
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

function callsTo(fetchMock: jest.Mock, path: string, method: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(path) && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock, role: PilotSessionState['role'] = 'organization_admin') {
  mockUsePilotSession.mockReturnValue(session(role));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminCapabilitiesPage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

it('reports a refused capability load and stops saving over the stored registry', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403);
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  await screen.findByText(/Forbidden: role not allowed\. The list below is a starting template/);
  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'GET')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);
});

it('reports a capability save that the server refused', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'Capability registry could not be saved' }, false, 500);
      }
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  await screen.findByText(/Capability registry could not be saved\. This change is not saved/);
});

it('saves the capability registry for a platform owner', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock, 'platform_owner');

  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
});

// The console used to merge its seed blueprints into whatever the registry
// returned, then immediately save the merged list back. That made deletion
// impossible: an archived capability came back on the next load and was written
// to the registry again, so the stored governance record drifted toward the
// template no matter what an administrator did to it.
it('does not resurrect capabilities an administrator archived', async () => {
  const stored = {
    id: 1,
    capabilityId: 'CAP-001',
    name: 'Safety Gate',
    group: 'Safety',
    status: 'ACTIVE',
    owner: 'Operations',
    assignedRoles: ['coach'],
    description: 'The one capability this gym kept.',
  };

  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [stored] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(1));

  const [, init] = callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')[0];
  const saved = JSON.parse(String((init as RequestInit).body)) as { capabilities: Array<{ capabilityId: string }> };

  // What the gym stored is what gets written back -- not the template.
  expect(saved.capabilities.map((item) => item.capabilityId)).toEqual(['CAP-001']);
  expect(saved.capabilities).toHaveLength(1);
});

it('hides the compliance center from a platform owner and keeps it for a gym admin', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));

  await renderPage(fetchMock, 'platform_owner');
  expect(screen.queryByRole('link', { name: /compliance/i })).toBeNull();

  jest.clearAllMocks();
  await renderPage(fetchMock, 'organization_admin');
  expect(screen.getAllByRole('link', { name: /compliance/i }).length).toBeGreaterThan(0);
});
