/**
 * @jest-environment jsdom
 */

// Who Trains On What (OD-2026-10-07-010 ruling 3). These tests moved here from
// app/admin/page.test.tsx with the control itself (lane AS-10, PR AS10-4; app
// scrub OFF-13), unchanged but for how the control is put on screen: it is
// rendered on its own, with the sign-in's answer handed in as `canAssign`.
// Three page-level cases did not move: the walk between Capabilities tabs (the
// control is no longer on a tabbed page), and the two that depended on the
// Capabilities page's own session wait; Athlete Records covers who reaches the
// control (app/admin/athletes/page.test.tsx).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import TrackAssignmentControl from './TrackAssignmentControl';

const originalFetch = global.fetch;

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

/** The control as Athlete Records shows it: to the gym's own admin (`canAssign`). */
async function renderPage(fetchMock: jest.Mock, canAssign: boolean | null = true) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<TrackAssignmentControl canAssign={canAssign} />);
  if (canAssign === true) await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

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
    expect(screen.getByText('Not confirmed saved: Ada Lopez')).toBeTruthy();
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

  // The save lays this admin's changes over the map as re-read and sends the
  // whole of it. A re-read that comes back 2xx with no map in it must stop
  // the save: sent as an empty map it would remove every other athlete's tracks.
  it('a re-read at save time that carries no map sends nothing, so nobody else is wiped', async () => {
    const server: TrackServer = { roster: [ADA, BEN], stored: { 'ath-ben': ['a2p'] } };
    const fetchMock = trackFetch(server);

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    server.mapResponse = () => jsonResponse({ ok: true });
    fireEvent.click(saveButton());

    await screen.findByText('Failed: Track assignments could not be read. Nothing was sent, so nothing is saved.');
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
  });

  it.each([
    ['the stored map', { mapResponse: () => jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403) }, /Forbidden: role not allowed\. Tracks cannot be shown or saved/],
    ['the roster', { rosterResponse: () => jsonResponse({ error: 'Server error' }, false, 500) }, /Server error\. Tracks cannot be shown or saved/],
    // A 2xx that carries no map or no list is a read that did not work. Read
    // as "nobody is on a track" it would let Save wipe the gym's stored map.
    ['a stored map the reply does not carry', { mapResponse: () => jsonResponse({ ok: true }) }, /Track assignments could not be read\. Tracks cannot be shown or saved/],
    ['a roster the reply does not carry', { rosterResponse: () => jsonResponse({ ok: true }) }, /The roster could not be read\. Tracks cannot be shown or saved/],
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

  // The line between "the route said no" and "nobody knows": every 4xx is a
  // refusal with the route's message, every 5xx is unconfirmed.
  it.each([
    [400, 'refused'],
    [403, 'refused'],
    [409, 'refused'],
    [499, 'refused'],
    [500, 'unconfirmed'],
    [503, 'unconfirmed'],
  ] as const)('a %i answer to the save is reported as %s', async (status, kind) => {
    const fetchMock = trackFetch({
      roster: [ADA],
      stored: {},
      post: () => jsonResponse({ error: 'The route said this' }, false, status),
    });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    fireEvent.click(saveButton());

    if (kind === 'refused') {
      await screen.findByText('Refused: The route said this');
      expect(screen.queryByText(/^Failed:/)).toBeNull();
    } else {
      await screen.findByText(/^Failed: The route said this\. The save was not confirmed/);
      expect(screen.queryByText(/^Refused:/)).toBeNull();
    }
  });

  // After a save that was sent and never answered, the change may be stored.
  // Calling it "not saved" would be a claim nobody can back.
  it('an unconfirmed save calls the change not confirmed, never not saved', async () => {
    const fetchMock = trackFetch({
      roster: [ADA],
      stored: {},
      post: () => Promise.reject(new Error('Network request failed')),
    });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
    fireEvent.click(saveButton());

    await screen.findByText(/^Failed: Network request failed\. The save was not confirmed/);
    expect(screen.getByText('Not confirmed saved: Ada Lopez')).toBeTruthy();
    expect(screen.queryByText(/Not saved yet/)).toBeNull();
    expect(trackButton(/USA Boxing Track/).textContent).toContain('Status: Assigned (not confirmed)');
    expect(trackButton(/USA Boxing Track/).textContent).not.toContain('(not saved)');
    // It can be sent again.
    expect(saveButton().disabled).toBe(false);
  });

  it('if the re-read at save time drops, the control says nothing was sent, not that the save is unconfirmed', async () => {
    const server: TrackServer = { roster: [ADA], stored: {} };
    const fetchMock = trackFetch(server);

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    server.mapResponse = () => {
      throw new Error('Network request failed');
    };
    fireEvent.click(saveButton());

    await screen.findByText('Failed: Network request failed. Nothing was sent, so nothing is saved.');
    expect(screen.queryByText(/not confirmed/i)).toBeNull();
    expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(0);
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
  });

  // A toggle or a change of athlete while the save is out would be wiped when
  // the save lands and clears the changes it sent.
  it('while a save is out, the picker and the tracks are locked', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = trackFetch({
      roster: [ADA, BEN],
      stored: {},
      post: () => new Promise<Response>((resolve) => {
        release = resolve;
      }),
    });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    fireEvent.click(saveButton());

    const saving = (await screen.findByRole('button', { name: 'Saving…' })) as HTMLButtonElement;
    await waitFor(() => expect(callsTo(fetchMock, TRACKS_URL, 'POST')).toHaveLength(1));
    expect(saving.disabled).toBe(true);
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).disabled).toBe(true);
    expect(trackButton(/Collegiate Track/).disabled).toBe(true);
    expect(trackButton(/USA Boxing Track/).disabled).toBe(true);

    await act(async () => {
      release(jsonResponse({ ok: true }));
    });
    await screen.findByText('Saved.');
    expect(trackButton(/Collegiate Track/).disabled).toBe(false);
  });

  it('"Saved." does not sit beside a new unsaved change', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {} });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    fireEvent.click(trackButton(/USA Boxing Track/));
    fireEvent.click(saveButton());
    await screen.findByText('Saved.');

    fireEvent.click(trackButton(/Collegiate Track/));

    expect(screen.queryByText('Saved.')).toBeNull();
    expect(screen.getByText('Not saved yet: Ada Lopez')).toBeTruthy();
  });

  // The route refuses a map holding an id it does not know, so one stale id
  // in a stored entry would refuse every later save. It is read out.
  it('a stored id that is not a track this app knows is neither shown nor sent back', async () => {
    const fetchMock = trackFetch({ roster: [ADA, BEN], stored: { 'ath-ada': ['made_up_track', 'pro'], 'ath-ben': ['retired_track'] } });

    await renderPage(fetchMock);
    await chooseAthlete('ath-ada');
    expect(trackButton(/^Pro Track/).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(trackButton(/Collegiate Track/));
    fireEvent.click(saveButton());

    await screen.findByText('Saved.');
    expect(postedMaps(fetchMock)).toEqual([{ 'ath-ada': ['pro', 'collegiate'] }]);
  });

  it('with nobody chosen, no card says Assigned or Unassigned about anyone', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: { 'ath-ada': ['pro'] } });

    await renderPage(fetchMock);
    await screen.findByLabelText('Athlete');

    expect(trackButton(/^Pro Track/).textContent).not.toMatch(/Status:|Review Needed/);
    await chooseAthlete('ath-ada');
    expect(trackButton(/^Pro Track/).textContent).toContain('Status: Assigned');
    expect(trackButton(/USA Boxing Track/).textContent).toContain('Status: Unassigned');
  });

});

// What the control does with each answer about the sign-in, on its own.
describe('who may set tracks', () => {
  it('a sign-in that could not be read makes no call and is not told it cannot', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: {} });

    await renderPage(fetchMock, null);

    expect(screen.getByRole('heading', { name: 'Who Trains On What' })).toBeTruthy();
    expect(screen.queryByText(/This sign-in cannot read or change them/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Athlete')).toBeNull();
  });

  it('a sign-in that may not set tracks is told so, and makes no call', async () => {
    const fetchMock = trackFetch({ roster: [ADA], stored: { 'ath-ada': ['pro'] } });

    await renderPage(fetchMock, false);

    expect(screen.getByText(/This sign-in cannot read or change them/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Athlete')).toBeNull();
  });
});
