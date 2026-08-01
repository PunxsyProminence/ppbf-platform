/**
 * @jest-environment jsdom
 */

// The capability console persists governance in the background, so a refused or
// failed request has no visible symptom of its own: the screen keeps showing the
// edit that was never stored. These cover that, and the sharper hazard on the
// same page -- a registry that writes built-in example rows into a real gym's
// database as a side effect of someone opening the console.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

function postedCapabilities(fetchMock: jest.Mock): unknown[] {
  const calls = callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST');
  const last = calls[calls.length - 1];
  const body = JSON.parse(String((last?.[1] as RequestInit | undefined)?.body ?? '{}')) as { capabilities?: unknown[] };
  return body.capabilities ?? [];
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

function storeFetchMock(capabilities: unknown[] = []) {
  return jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities });
    }
    return jsonResponse({ ok: true });
  });
}

it('writes nothing to the registry when an admin only opens the page', async () => {
  const fetchMock = storeFetchMock([]);

  await renderPage(fetchMock);

  await screen.findByText('No capabilities recorded yet');
  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'GET')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);
  expect(callsTo(fetchMock, '/api/pilot/admin/gym-capabilities', 'POST')).toHaveLength(0);
  expect(callsTo(fetchMock, '/api/pilot/admin/track-assignments', 'POST')).toHaveLength(0);
});

it('shows an empty registry as empty rather than filling it with the example template', async () => {
  const fetchMock = storeFetchMock([]);

  await renderPage(fetchMock);

  await screen.findByText('No capabilities recorded yet');
  expect(screen.getByRole('button', { name: /ADD THE FIRST CAPABILITY/ })).toBeTruthy();
  expect(screen.queryByText(/Locker Rooms for Every Role/)).toBeNull();
  expect(screen.queryByText(/SHADOW Chats Command Surface/)).toBeNull();
});

it('applies the example template only when the admin confirms it, and saves what it applied', async () => {
  const fetchMock = storeFetchMock([]);

  await renderPage(fetchMock);
  await screen.findByText('No capabilities recorded yet');

  fireEvent.click(screen.getByRole('button', { name: /START FROM THE EXAMPLE TEMPLATE/ }));
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: /APPLY ALL \d+ EXAMPLE CAPABILITIES/ }));

  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(1));
  expect(postedCapabilities(fetchMock).length).toBeGreaterThan(0);
});

it('keeps a stored registry exactly as stored instead of topping it up with example rows', async () => {
  const fetchMock = storeFetchMock([
    {
      id: 4,
      capabilityId: 'CAP-004',
      name: 'Front Desk Check-In',
      group: 'Program Operations',
      status: 'ACTIVE',
      visibility: 'Role-Bound',
      owner: 'Operations',
      assignedRoles: ['Admin'],
      description: 'Real capability entered by an admin.',
      dependencies: '',
      notes: '',
      reviewNeeded: false,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ]);

  await renderPage(fetchMock);

  await screen.findAllByText(/Front Desk Check-In/);
  expect(screen.queryByText(/Locker Rooms for Every Role/)).toBeNull();
  expect(screen.queryByText(/Payment Service \(Gated\)/)).toBeNull();
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);
});

it('reports a refused capability load and stops saving over the stored registry', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403);
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  await screen.findByText(/Forbidden: role not allowed\. No capabilities are listed because the registry could not be read/);
  await screen.findByText('Capability registry could not be read');
  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'GET')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);
  expect(screen.queryByText('No capabilities recorded yet')).toBeNull();
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
  await screen.findByText('No capabilities recorded yet');

  fireEvent.click(screen.getByRole('button', { name: /START FROM THE EXAMPLE TEMPLATE/ }));
  fireEvent.click(screen.getByRole('button', { name: /APPLY ALL \d+ EXAMPLE CAPABILITIES/ }));

  await screen.findByText(/Capability registry could not be saved\. This change is not saved/);
});

it('reports a refused track assignment save instead of dropping it silently', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/admin/track-assignments')) {
      if (init?.method === 'POST') {
        return jsonResponse({ error: 'Track assignments could not be saved' }, false, 500);
      }
      return jsonResponse({ ok: true, assignments: {} });
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);
  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/track-assignments', 'GET')).toHaveLength(1));

  fireEvent.click(await screen.findByRole('button', { name: /Non-Contact Track/ }));

  await screen.findByText(/Track assignments could not be saved\. This change is not saved/);
});

it('saves the capability registry for a platform owner once they change something', async () => {
  const fetchMock = storeFetchMock([]);

  await renderPage(fetchMock, 'platform_owner');
  await screen.findByText('No capabilities recorded yet');
  expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: /START FROM THE EXAMPLE TEMPLATE/ }));
  fireEvent.click(screen.getByRole('button', { name: /APPLY ALL \d+ EXAMPLE CAPABILITIES/ }));

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
  const fetchMock = storeFetchMock([]);

  await renderPage(fetchMock, 'platform_owner');
  expect(screen.queryByRole('link', { name: /compliance/i })).toBeNull();

  jest.clearAllMocks();
  await renderPage(fetchMock, 'organization_admin');
  expect(screen.getAllByRole('link', { name: /compliance/i }).length).toBeGreaterThan(0);
});
