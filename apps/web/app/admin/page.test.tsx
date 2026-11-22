/**
 * @jest-environment jsdom
 */

// The capability console persists governance in the background, so a refused or
// failed request has no visible symptom of its own: the screen keeps showing the
// edit that was never stored. These cover the two ways that goes wrong.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

// The platform owner's page sends nothing, so there is no call to wait on.
async function renderAsPlatformOwner(fetchMock: jest.Mock) {
  mockUsePilotSession.mockReturnValue(session('platform_owner'));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminCapabilitiesPage />);
  await screen.findByRole('heading', { name: 'Capabilities are set per gym' });
}

// Every read behind this room is refused to the platform owner
// (OD-2026-10-10-004 ruling 3): it is shown where its work is instead, and
// no gym read or save goes out on its behalf.
describe('the platform owner', () => {
  it('is pointed at the platform screens and sends no gym read or save', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));

    await renderAsPlatformOwner(fetchMock);
    // Give any mount effect a turn to run before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Platform Desk' }).getAttribute('href')).toBe('/admin/platform');
    expect(screen.getByRole('link', { name: 'Organization Provisioning' }).getAttribute('href')).toBe('/admin/organizations');
    expect(screen.queryByRole('button', { name: 'Capability Library' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Capabilities' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['organization_admin', 'admin'] as const)('%s still gets the console and both reads', async (role) => {
    const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));

    await renderPage(fetchMock, role);

    await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'GET')).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/gym-capabilities', 'GET')).toHaveLength(1));
    // The save path the platform owner lost is still the gym admin's.
    await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'POST')).toHaveLength(1));
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeTruthy();
    expect(screen.queryByText('Capabilities are set per gym')).toBeNull();
  });
});

/* Lane L31 (Overwatch Q2 A): no feature reads these switches, so the screen
   says so instead of promising to turn features on or off. */
it('the switchboard says it is a record only and promises no feature switching', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderPage(fetchMock, 'organization_admin');
  await screen.findByRole('heading', { name: 'The Switchboard' });

  expect(screen.getByText('Record Only')).toBeTruthy();
  expect(screen.getByText(/These switches are a record only: no feature reads them, and switching one off does not turn that feature off\./)).toBeTruthy();
  const page = document.body.textContent ?? '';
  expect(page).not.toMatch(/Turn platform capabilities on or off/);
  expect(page).not.toMatch(/Decide what this gym can do/);
  expect(page).not.toMatch(/let them flip it on or off/);
});

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

// A failed read of which capabilities gym admins may flip used to leave every
// row saying "not yet toggle" and "Disabled" -- a claim nobody read.
it('a failed gym-capability read shows each row as unknown, never "Disabled"', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/gym-capabilities')) {
      return jsonResponse({ error: 'Server error' }, false, 500);
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  const unread = await screen.findAllByText('Gym admin access could not be read.');
  expect(unread.length).toBeGreaterThan(0);
  expect(screen.queryByText(/Recorded as not marked for gym admins/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not Marked' })).toBeNull();
  for (const button of screen.getAllByRole('button', { name: 'Unknown' })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});

it('after a gym-capability read comes back, each row states its access and can be flipped', async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/gym-capabilities')) {
      return jsonResponse({ capabilityAccess: {} });
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);

  const buttons = await screen.findAllByRole('button', { name: 'Not Marked' });
  expect(buttons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByRole('button', { name: 'Unknown' })).toBeNull();
  expect(screen.queryByText('Gym admin access could not be read.')).toBeNull();
});

// THE AUTOSAVE LANE (useAutosaveLane), which still carries the capability
// registry and the gym-capability switches. These two cases used to ride on
// the tracks panel, back when tracks saved on every click; tracks now save on
// a button (components/trackAssignmentControl.test.tsx), so they ride on the gym-capability
// switches instead. What they assert about the lane is unchanged.
//
// Found by review on #618: every state change used to start its own
// overlapping whole-record POST, so an older request finishing last could
// write its snapshot over a newer one AND clear the banner a newer failed save
// had just earned. The lane serializes sends and lets only the newest speak.
it('a stale save cannot outrun a newer one or speak over its banner', async () => {
  let releaseFirstPost: (response: Response) => void = () => undefined;
  let postCount = 0;
  const postBodies: string[] = [];

  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/admin/gym-capabilities')) {
      if ((init?.method ?? 'GET') === 'POST') {
        postCount += 1;
        postBodies.push(String(init?.body));
        if (postCount === 1) {
          // The hydration echo, held open so the clicks below land while a
          // request is genuinely in flight.
          return new Promise<Response>((resolve) => {
            releaseFirstPost = resolve;
          });
        }
        return jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403);
      }
      return jsonResponse({ capabilityAccess: {} });
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);
  await waitFor(() => expect(postCount).toBe(1));

  // Two clicks while the first POST is still out: both must wait, and only
  // the NEWEST combined snapshot may be sent when the lane frees up.
  const [first, second] = await screen.findAllByRole('button', { name: 'Not Marked' });
  fireEvent.click(first);
  fireEvent.click(second);
  expect(postCount).toBe(1);

  // The stale echo now succeeds -- its outcome is superseded, so it must not
  // clear or set anything; the queued newest snapshot goes out and is refused.
  releaseFirstPost(jsonResponse({ ok: true }));

  await screen.findByText(/Forbidden: role not allowed\. This change is not saved and will be lost on reload/);
  expect(postCount).toBe(2);
  const finalBody = JSON.parse(postBodies[1]) as { capabilityAccess: Record<string, boolean> };
  // Both clicks are in the one snapshot that went out, not one each in two.
  expect(Object.values(finalBody.capabilityAccess).filter((allowed) => allowed === true)).toHaveLength(2);
});

it('a network error reports an unconfirmed save, never a definite loss', async () => {
  // A thrown fetch has no response: the server may have committed the write
  // before the connection died. The banner may only claim what is known.
  let posted = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/admin/gym-capabilities')) {
      if ((init?.method ?? 'GET') === 'POST') {
        posted += 1;
        if (posted > 1) {
          throw new Error('Network request failed');
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ capabilityAccess: {} });
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });

  await renderPage(fetchMock);
  await waitFor(() => expect(posted).toBe(1));

  fireEvent.click((await screen.findAllByRole('button', { name: 'Not Marked' }))[0]);

  await screen.findByText(/Network request failed\. The save was not confirmed -- it may or may not have been stored/);
  expect(screen.queryByText(/will be lost on reload/)).toBeNull();
});

/* OFF-12 (lane U1). Controls that did not do what they said: a "Tutorial
   Access" card whose button opens SHADOW chat, a "Manage Login Announcements"
   link to /login (which sends a signed-in admin home; the sign-in page shows no
   announcements), and the working Compliance Center filed as "Planned". */
it('the overview names SHADOW Chat, links no sign-in page, and files the Compliance Center in its note only', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderPage(fetchMock, 'organization_admin');
  await screen.findByRole('heading', { name: 'SHADOW Chat' });

  expect(screen.getByText('Questions about a screen? Open SHADOW Chat with this button.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Tutorial Access' })).toBeNull();
  expect(screen.queryByText(/tutorial center/i)).toBeNull();
  expect(screen.queryByText('Manage Login Announcements')).toBeNull();
  expect(document.querySelector('a[href="/login"]')).toBeNull();
  // AS10-2b (OFF-05, Q4 A): the header's Compliance Center link moved to Gym Office, under Safety.
  expect(document.querySelectorAll('a[href="/admin/compliance-center"]')).toHaveLength(0);
  expect(screen.queryByText('Automated Compliance Monitoring Surface')).toBeNull();
  expect(screen.getByText('Automated compliance monitoring: not built yet. Violations are filed by hand from Video Analysis; the Compliance Center is where they are reviewed and closed.')).toBeTruthy();
  expect(screen.queryByText(/records violations by hand/)).toBeNull();
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

it('shows a platform owner no compliance center link; a gym admin finds it on Gym Office now (AS10-2b)', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));

  await renderAsPlatformOwner(fetchMock);
  expect(screen.queryByRole('link', { name: /compliance/i })).toBeNull();

  // The gym admin's link moved to Gym Office (app/admin/people/officeLauncher.test.tsx), which a
  // platform owner is not shown.
  jest.clearAllMocks();
  await renderPage(fetchMock, 'organization_admin');
  expect(screen.queryAllByRole('link', { name: /compliance/i })).toHaveLength(0);
});

/*
 * AS10-2b (lane AS-10; app scrub OFF-05; plan #2018 Q4 A, Q19 A). The header's launcher moved to
 * Gym Office: grouped by the admin's job sections, then Video Analysis, Drill Library, Waivers &
 * Consent and System in one row (they sit in no section). Gym Setup was already linked from Gym
 * Office's header (AS10-1), so it is not repeated there. Gym Office (the way back) and Export JSON
 * (this page's own export) stay.
 */
it('the header no longer launches the office pages that moved to Gym Office', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderPage(fetchMock, 'organization_admin');
  await screen.findByRole('heading', { name: 'Capabilities' });

  for (const href of [
    '/admin/setup', '/admin/athletes', '/admin/export', '/admin/import', '/admin/gear', '/admin/customize', '/operations',
    '/admin/compliance-center', '/coach/video-analysis', '/coach/drills', '/admin/consent', '/admin/system',
  ]) {
    expect(document.querySelectorAll(`a[href="${href}"]`)).toHaveLength(0);
  }
  expect(document.querySelectorAll('a[href="/admin/people"]')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'EXPORT JSON' })).toBeTruthy();
});

// The plan named a kept label that did not say its page's title (OFF-15; admin:1473 on c27c581c):
// PEOPLE opens Gym Office. (CONSENT, :1554, moved to Gym Office under Q19 A, worded by its door.)
it('the kept Gym Office link says the title of the page it opens', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderPage(fetchMock, 'organization_admin');
  await screen.findByRole('heading', { name: 'Capabilities' });
  expect(document.querySelector('a[href="/admin/people"]')?.textContent?.trim()).toBe('Gym Office');
});

// R2-F-004: /admin/organizations admits the platform owner only, so an
// organization admin shown either provisioning link was sent to a refusal.
it.each(['organization_admin', 'admin'] as const)(
  'shows %s no link to organization provisioning',
  async (role) => {
    const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
    await renderPage(fetchMock, role);
    const provisioning = screen
      .queryAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/admin/organizations');
    expect(provisioning).toHaveLength(0);
  },
);

it('keeps the organization provisioning link for a platform owner', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderAsPlatformOwner(fetchMock);
  expect(screen.getByRole('link', { name: /organization provisioning/i }).getAttribute('href'))
    .toBe('/admin/organizations');
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

    await screen.findByRole('heading', { name: 'Capabilities' });
    expect(screen.queryByText(/authority console/i)).toBeNull();
    expect(screen.getByText('PPBF ADMIN DESK').className).toContain('t-eyebrow');
  });
});

// Lane AS-10, PR AS10-4 (app scrub OFF-13; Overwatch Q8 A): Who Trains On What
// moved to Athlete Records. Its own tests moved with it
// (components/trackAssignmentControl.test.tsx).
it('the Capabilities overview no longer carries Who Trains On What, and asks for no tracks or roster', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, capabilities: [] }));
  await renderPage(fetchMock, 'organization_admin');
  await screen.findByRole('heading', { name: 'SHADOW Chat' });

  expect(screen.queryByRole('heading', { name: 'Who Trains On What' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save tracks' })).toBeNull();
  expect(callsTo(fetchMock, '/api/pilot/admin/track-assignments', 'GET')).toHaveLength(0);
  expect(callsTo(fetchMock, '/api/pilot/athletes/list', 'GET')).toHaveLength(0);
});
