/**
 * @jest-environment jsdom
 */

// The capability console persists governance in the background, so a refused or
// failed request has no visible symptom of its own: the screen keeps showing the
// edit that was never stored. These cover the two ways that goes wrong.

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

// The track-assignments hydrate effect used to mark itself hydrated even when
// the GET failed, which released the save effect to POST the in-memory seed
// over the stored record -- the exact overwrite the capabilities effect
// guards against, one effect down.
it('reports a refused track-assignments load and stops saving over the stored record', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/track-assignments')) {
      return jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403);
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  await screen.findByText(/Forbidden: role not allowed\. The tracks shown are the defaults and track changes are not being saved/);
  await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/track-assignments', 'GET')).toHaveLength(1));
  expect(callsTo(fetchMock, '/api/pilot/admin/track-assignments', 'POST')).toHaveLength(0);
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

// A table filtered down to nothing used to render as nothing at all, which
// reads as "the data is gone" rather than "your filters are narrow". The two
// causes have to stay distinguishable, and the recoverable one has to offer the
// recovery -- an empty state that does not say which case it is, or that leaves
// the administrator to hunt down seven filter controls, is the original defect
// wearing a panel.
it('tells a filtered-empty library apart from an empty one, and clears back', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true }));

  await renderPage(fetchMock);

  fireEvent.click(screen.getByRole('button', { name: 'Capability Library' }));
  fireEvent.change(screen.getByPlaceholderText('SEARCH CAPABILITIES'), {
    target: { value: 'no-capability-is-named-this' },
  });

  await screen.findByText('No capability matches those filters');
  expect(screen.queryByText('The library is empty')).toBeNull();
  expect(document.body.textContent).toContain('Showing 0 of 20 on file.');

  fireEvent.click(screen.getAllByRole('button', { name: 'CLEAR ALL FILTERS' })[0]);

  await waitFor(() => expect(screen.queryByText('No capability matches those filters')).toBeNull());
  expect(document.body.textContent).toContain('Showing 20 of 20 on file.');
});

// Background colour alone carried the selection, so the row read as five
// identical chips. The visual treatment is not assertable here; the programmatic
// half of the same signal is, and it is what a screen reader gets.
it('marks the open section on the tab that opened it', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true }));

  await renderPage(fetchMock);

  expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('button', { name: 'Assignment Board' }).getAttribute('aria-current')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Assignment Board' }));

  expect(screen.getByRole('button', { name: 'Assignment Board' }).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
});

it('hides the compliance center from a platform owner and keeps it for a gym admin', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));

  await renderPage(fetchMock, 'platform_owner');
  expect(screen.queryByRole('link', { name: /compliance/i })).toBeNull();

  jest.clearAllMocks();
  await renderPage(fetchMock, 'organization_admin');
  expect(screen.getAllByRole('link', { name: /compliance/i }).length).toBeGreaterThan(0);
});

/**
 * THE SESSION LOG IS AN OFFICE RECORD, IN AN OFFICE HAND.
 *
 * "Show what changed this session" used to print `[{timestamp}] {action} -
 * {detail}` in font-mono on a dark slab, newest first -- the same shape the
 * After Hours event feed prints, inside .room--office. ROOM-PURPOSE-DNA names
 * night telemetry as forbidden chrome in the front office. The record it keeps
 * is genuinely the office's own, so the record stays and the hand changes:
 * .ledger, which ppbf.css defines as "a ruled paper record ... because every
 * row is auditable".
 *
 * The eyebrow above it is here for the same reason: it read "PPBF ADMIN
 * AUTHORITY CONSOLE", and "console" is the word the night room uses for itself.
 */
describe('the office writes its own record in its own hand', () => {
  async function openTheLog() {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/admin/capabilities')) {
        return jsonResponse({ ok: true, capabilities: [] });
      }
      return jsonResponse({ ok: true });
    });
    await renderPage(fetchMock);
    // Any tracked action writes a row; a filter change is the cheapest.
    fireEvent.click(await screen.findByRole('button', { name: 'Assignment Board' }));
    fireEvent.click(screen.getByRole('button', { name: /Show what changed this session/i }));
  }

  it('prints the session log as a ruled ledger, not a bracketed mono line', async () => {
    await openTheLog();

    const caption = await screen.findByText('This session');
    const table = caption.closest('table');
    expect(table).not.toBeNull();
    expect(table?.className).toContain('ledger');
    expect(table?.parentElement?.className).toContain('mat-paper');
    expect(screen.getByRole('columnheader', { name: 'Time' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'What changed' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\[\d{1,2}:\d{2}/);
  });

  it('keeps the clerk-voiced empty state it already had', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/admin/capabilities')) {
        return jsonResponse({ ok: true, capabilities: [] });
      }
      return jsonResponse({ ok: true });
    });
    await renderPage(fetchMock);

    fireEvent.click(await screen.findByRole('button', { name: /Show what changed this session/i }));
    expect(screen.getByText('Nothing logged yet')).toBeTruthy();
  });

  it('does not call the desk a console', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/admin/capabilities')) {
        return jsonResponse({ ok: true, capabilities: [] });
      }
      return jsonResponse({ ok: true });
    });
    await renderPage(fetchMock);

    await screen.findByRole('heading', { name: 'The Capability Room' });
    expect(screen.queryByText(/authority console/i)).toBeNull();
    expect(screen.getByText('PPBF ADMIN DESK').className).toContain('t-eyebrow');
  });
});
