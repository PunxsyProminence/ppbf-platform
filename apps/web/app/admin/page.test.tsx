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
  expect(screen.queryByText(/Gym admins can not yet toggle this capability/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disabled' })).toBeNull();
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

  const buttons = await screen.findAllByRole('button', { name: 'Disabled' });
  expect(buttons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByRole('button', { name: 'Unknown' })).toBeNull();
  expect(screen.queryByText('Gym admin access could not be read.')).toBeNull();
});

// WHO TRAINS ON WHAT (OD-2026-10-07-010 ruling 3): tracks are set for real
// athletes of this gym, picked by name. The control used to hold three made-up
// athletes and save on load and on every click; it now reads the roster and
// the stored map, and writes only when Save tracks is pressed.
const TRACKS_URL = '/api/pilot/admin/track-assignments';
const ROSTER_URL = '/api/pilot/athletes/list';

interface TrackServer {
  roster: Array<{ athlete_id: string; full_name: string }>;
  /** What GET answers. A POST that is not intercepted replaces it, as the route does. */
  stored: Record<string, string[]>;
  post?: (assignments: Record<string, string[]>) => Response | Promise<Response>;
  rosterResponse?: () => Response;
  mapResponse?: () => Response;
}

const ADA = { athlete_id: 'ath-ada', full_name: 'Ada Lopez' };
const BEN = { athlete_id: 'ath-ben', full_name: 'Ben Okafor' };

function trackFetch(server: TrackServer) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes(ROSTER_URL)) {
      return server.rosterResponse ? server.rosterResponse() : jsonResponse({ items: server.roster });
    }
    if (String(url).includes(TRACKS_URL)) {
      if (method === 'POST') {
        const { assignments } = JSON.parse(String(init?.body)) as { assignments: Record<string, string[]> };
        if (server.post) {
          return server.post(assignments);
        }
        server.stored = assignments;
        return jsonResponse({ ok: true });
      }
      return server.mapResponse ? server.mapResponse() : jsonResponse({ ok: true, assignments: server.stored });
    }
    if (String(url).includes('/api/pilot/admin/capabilities')) {
      return jsonResponse({ ok: true, capabilities: [] });
    }
    return jsonResponse({ ok: true });
  });
}

function postedMaps(fetchMock: jest.Mock): Array<Record<string, string[]>> {
  return callsTo(fetchMock, TRACKS_URL, 'POST').map(
    ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { assignments: Record<string, string[]> }).assignments,
  );
}

async function chooseAthlete(athleteId: string) {
  const picker = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
  fireEvent.change(picker, { target: { value: athleteId } });
}

const trackButton = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const saveButton = () => screen.getByRole('button', { name: 'Save tracks' }) as HTMLButtonElement;

describe('Who Trains On What', () => {
  it("lists the gym's real athletes by name, and writes nothing on load", async () => {
    const fetchMock = trackFetch({ roster: [BEN, ADA], stored: {} });

    await renderPage(fetchMock);

    const picker = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.text)).toEqual(['Choose an athlete', 'Ada Lopez', 'Ben Okafor']);
    expect([...picker.options].map((option) => option.value)).toEqual(['', 'ath-ada', 'ath-ben']);
    // Nobody is picked for the admin, and no made-up athlete is on the page.
    expect(picker.value).toBe('');
    expect(document.body.textContent).not.toMatch(/athlete-00\d|Athlete 00\d/);

    expect(callsTo(fetchMock, ROSTER_URL, 'GET')).toHaveLength(1);
    expect(callsTo(fetchMock, TRACKS_URL, 'GET')).toHaveLength(1);
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
  });

  it('a track cannot be toggled, and nothing can be saved, before an athlete is chosen', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {} });

    await renderPage(fetchMock);
    await screen.findByLabelText('Athlete');

    expect(trackButton(/USA Boxing Track/).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('a click does not save; Save tracks sends the real athlete id and says Saved', async () => {
    const server: TrackServer = { roster: [ADA, BEN], stored: {} };
    const fetchMock = trackFetch(server);

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));

    expect(trackButton(/USA Boxing Track/).getAttribute('aria-pressed')).toBe('true');
    expect(trackButton(/USA Boxing Track/).textContent).toContain('Status: Assigned (not saved)');
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);

    fireEvent.click(saveButton());

    await screen.findByText('Saved.');
    expect(postedMaps(fetchMock)).toEqual([{ 'ath-ada': ['usa_boxing'] }]);
    expect(screen.queryByText(/Not saved yet/)).toBeNull();
    expect(trackButton(/USA Boxing Track/).textContent).toContain('Status: Assigned');
    expect(trackButton(/USA Boxing Track/).textContent).not.toContain('(not saved)');
    expect(saveButton().disabled).toBe(true);
  });

  it('shows the stored tracks of the athlete chosen, and no track nobody set', async () => {
    const fetchMock = trackFetch({ roster: [ADA, BEN], stored: { 'ath-ben': ['collegiate', 'non_contact'] } });

    await renderPage(fetchMock);

    await chooseAthlete('ath-ben');
    expect(trackButton(/Collegiate Track/).getAttribute('aria-pressed')).toBe('true');
    expect(trackButton(/Non-Contact Track/).getAttribute('aria-pressed')).toBe('true');
    expect(trackButton(/USA Boxing Track/).getAttribute('aria-pressed')).toBe('false');

    // Ada has no entry: she is on no track, not on a default one.
    await chooseAthlete('ath-ada');
    const cards = screen.getAllByRole('button').filter((item) => item.hasAttribute('aria-pressed') && /Track/.test(item.textContent ?? ''));
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card.getAttribute('aria-pressed')).toBe('false');
    }
    expect(saveButton().disabled).toBe(true);
  });

  it('toggling a track back to what is stored leaves nothing to save', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: { 'ath-ada': ['pro'] } });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/Collegiate Track/));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(trackButton(/Collegiate Track/));

    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText(/Not saved yet/)).toBeNull();
  });

  it('an athlete left with no track is left out of the map; none is invented', async () => {
    const fetchMock = trackFetch({ roster: [ADA, BEN], stored: { 'ath-ada': ['pro'], 'ath-ben': ['a2p'] } });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/^Pro Track/));
    fireEvent.click(saveButton());

    await screen.findByText('Saved.');
    expect(postedMaps(fetchMock)).toEqual([{ 'ath-ben': ['a2p'] }]);
  });

  // The route replaces the gym's whole map. A screen left open would otherwise
  // put back whatever another admin changed since it loaded.
  it('a stale screen saves only its own changes over what is stored now', async () => {
    const server: TrackServer = { roster: [ADA, BEN], stored: { 'ath-ada': ['pro'] } };
    const fetchMock = trackFetch(server);

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/Collegiate Track/));

    // Another admin, meanwhile: Ben goes on USA Boxing and Ada loses Pro.
    server.stored = { 'ath-ben': ['usa_boxing'] };

    fireEvent.click(saveButton());
    await screen.findByText('Saved.');

    // Ada is as THIS admin set her; Ben is as the other admin left him.
    expect(postedMaps(fetchMock)).toEqual([{ 'ath-ada': ['pro', 'collegiate'], 'ath-ben': ['usa_boxing'] }]);
    expect(callsTo(fetchMock, TRACKS_URL, 'GET')).toHaveLength(2);

    // And the screen now shows Ben as stored, not as it was when it loaded.
    await chooseAthlete('ath-ben');
    expect(trackButton(/USA Boxing Track/).getAttribute('aria-pressed')).toBe('true');
  });

  it("a refused save shows the route's own message and keeps the change as unsaved", async () => {
    const refusal = 'Unsupported assignments: 1 athlete id(s) are not athletes of this gym. Nothing was saved.';
    const fetchMock = trackFetch({
      roster: [ADA],
      stored: {},
      post: () => jsonResponse({ error: refusal }, false, 400),
    });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    fireEvent.click(saveButton());

    await screen.findByText(`Refused: ${refusal}`);
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
    expect(trackButton(/USA Boxing Track/).textContent).toContain('(not saved)');
    expect(saveButton().disabled).toBe(false);
  });

  it.each([
    ['the connection drops', () => Promise.reject(new Error('Network request failed')), /^Failed: Network request failed\. The save was not confirmed/],
    ['the server errors', () => jsonResponse({ error: 'Internal server error' }, false, 500), /^Failed: Internal server error\. The save was not confirmed/],
  ])('when %s the save is reported as failed and unconfirmed, never as saved or refused', async (_label, post, expected) => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {}, post: post as TrackServer['post'] });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    fireEvent.click(saveButton());

    await screen.findByText(expected);
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.queryByText(/^Refused:/)).toBeNull();
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
  });

  it('if the stored map cannot be read again at save time, nothing is sent', async () => {
    const server: TrackServer = { roster: [ADA], stored: {} };
    const fetchMock = trackFetch(server);

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    server.mapResponse = () => jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403);
    fireEvent.click(saveButton());

    await screen.findByText('Failed: Forbidden: role not allowed. Nothing was sent, so nothing is saved.');
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
  });

  it.each([
    ['the stored map', { mapResponse: () => jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403) }, /Forbidden: role not allowed\. Tracks cannot be shown or saved/],
    ['the roster', { rosterResponse: () => jsonResponse({ error: 'Server error' }, false, 500) }, /Server error\. Tracks cannot be shown or saved/],
  ])('a failed read of %s says so and offers nothing to save', async (_label, failure, expected) => {
    const fetchMock = trackFetch({ roster: [ADA], stored: { 'ath-ada': ['pro'] }, ...failure });

    await renderPage(fetchMock);

    await screen.findByText(expected);
    expect(screen.queryByLabelText('Athlete')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save tracks' })).toBeNull();
    expect(screen.queryByRole('button', { name: /USA Boxing Track/ })).toBeNull();
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
  });

  it('a gym with no athletes says so and offers nothing to save', async () => {
    const fetchMock = trackFetch({ roster: [], stored: {} });

    await renderPage(fetchMock);

    await screen.findByText(/No athletes are on this gym's roster yet/);
    expect(screen.queryByRole('button', { name: 'Save tracks' })).toBeNull();
  });

  it('two athletes with the same name are told apart by id', async () => {
    const fetchMock = trackFetch({
      roster: [ADA, { athlete_id: 'ath-ada-2', full_name: 'Ada Lopez' }, BEN],
      stored: {},
    });

    await renderPage(fetchMock);

    const picker = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.text)).toEqual([
      'Choose an athlete',
      'Ada Lopez (ath-ada)',
      'Ada Lopez (ath-ada-2)',
      'Ben Okafor',
    ]);
  });

  // The control sits on the Overview tab and holds its unsaved changes itself.
  // Unmounting it on a tab change would drop them without a word.
  it('unsaved track changes survive a walk to another tab and back', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {} });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));

    fireEvent.click(screen.getByRole('button', { name: 'Capability Library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));

    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
    expect(trackButton(/USA Boxing Track/).getAttribute('aria-pressed')).toBe('true');
    // Still one read of each: coming back did not start the control over.
    expect(callsTo(fetchMock, TRACKS_URL, 'GET')).toHaveLength(1);
    expect(callsTo(fetchMock, ROSTER_URL, 'GET')).toHaveLength(1);
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
  });

  it('two presses of Save tracks before the screen redraws start one save, not two', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {} });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));

    // Both presses inside one act: React has not yet redrawn the button as
    // disabled, so only the control's own guard can stop the second.
    const button = saveButton();
    await act(async () => {
      button.click();
      button.click();
    });

    await screen.findByText('Saved.');
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(1);
    expect(callsTo(fetchMock, TRACKS_URL, 'GET')).toHaveLength(2);
  });

  // The route refuses platform_owner on both verbs (OD-2026-10-08-003 R2), and
  // the roster route does not serve it either: neither is asked.
  it("a platform owner is told tracks are the gym admin's, and no track or roster call is made", async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: { 'ath-ada': ['pro'] } });

    await renderPage(fetchMock, 'platform_owner');

    await screen.findByText(/Tracks are set from the gym's own admin sign-in/);
    await waitFor(() => expect(callsTo(fetchMock, '/api/pilot/admin/capabilities', 'GET')).toHaveLength(1));
    expect(callsTo(fetchMock, TRACKS_URL, 'GET')).toHaveLength(0);
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
    expect(callsTo(fetchMock, ROSTER_URL, 'GET')).toHaveLength(0);
    expect(screen.queryByLabelText('Athlete')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save tracks' })).toBeNull();
  });
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
  await renderPage(fetchMock, 'platform_owner');
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

    await screen.findByRole('heading', { name: 'The Capability Room' });
    expect(screen.queryByText(/authority console/i)).toBeNull();
    expect(screen.getByText('PPBF ADMIN DESK').className).toContain('t-eyebrow');
  });
});
