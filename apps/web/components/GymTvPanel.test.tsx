/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import GymTvPanel, { describeRefusal, type GymTvPanelLiveRun } from './GymTvPanel';
import type { GymTvListItem } from '@/src/server/pilot/gymTvs';

const LIST_URL = '/api/pilot/gym-tvs';
const ME = 'acct_coach_1';
const LIVE = { run_id: 'run_mine', show_on_wall: true };

function tv(overrides: Partial<GymTvListItem> = {}): GymTvListItem {
  return {
    tv_id: 'gymtv_1',
    tv_name: 'Ring wall',
    status: 'paired',
    created_by_account_id: ME,
    created_at: '2026-10-01T12:00:00.000Z',
    pair_code_expires_at: null,
    paired_at: '2026-10-01T12:05:00.000Z',
    last_seen_at: '2026-10-08T15:00:00.000Z',
    revoked_at: null,
    current_run_id: null,
    current_run_set_by_account_id: null,
    ...overrides,
  };
}

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[];

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Records every request; the assertions live in the test bodies, never in the
 * double, where a failed expect would be swallowed by the panel's own catch
 * and read as "unavailable".
 */
function serve(handler: Handler) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
}

const listOf = (rows: GymTvListItem[]): Handler => (call) => {
  if (call.method === 'GET') return respond({ tvs: rows });
  throw new Error(`Unexpected ${call.method} ${call.url}`);
};

const gets = () => calls.filter((c) => c.method === 'GET');
const writes = () => calls.filter((c) => c.method !== 'GET');

interface PanelProps {
  liveRun?: GymTvPanelLiveRun | null;
  liveRunKnown?: boolean;
  coachAccountId?: string;
  onRunStale?: () => void;
}

function panel(props: PanelProps = {}) {
  return (
    <GymTvPanel
      liveRun={props.liveRun ?? null}
      liveRunKnown={props.liveRunKnown ?? true}
      coachAccountId={props.coachAccountId ?? ME}
      onRunStale={props.onRunStale}
    />
  );
}

function openPanel(props: PanelProps = {}) {
  const view = render(panel(props));
  fireEvent.click(screen.getByRole('button', { name: 'Open Gym TVs' }));
  return view;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads nothing until a coach opens it, then reads the list once', async () => {
  serve(listOf([]));
  render(panel());
  expect(global.fetch).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Gym TVs' }).getAttribute('data-surface')).toBe('kiosk');
  fireEvent.click(screen.getByRole('button', { name: 'Open Gym TVs' }));
  await screen.findByText('No TV has been paired yet.');
  expect(calls).toEqual([{ url: LIST_URL, method: 'GET', body: null }]);
});

test('"Refresh the list" reads again and keeps the rows on screen while it does', async () => {
  let release: () => void = () => {};
  let reads = 0;
  serve(() => {
    reads += 1;
    if (reads === 1) return respond({ tvs: [tv()] });
    return new Promise<Response>((resolve) => {
      release = () => resolve(respond({ tvs: [tv({ tv_name: 'Ring wall (renamed)' })] }));
    });
  });
  openPanel();
  await screen.findByText('Ring wall');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh the list' }));
  // In flight: the old row is still there, the button says so and is disabled.
  expect(screen.getByText('Ring wall')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Refreshing...' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());
  await screen.findByText('Ring wall (renamed)');
  expect(gets()).toHaveLength(2);
});

test('lists every TV with its status, last seen and what it is showing', async () => {
  serve(
    listOf([
      tv({ tv_id: 'a', tv_name: 'Ring wall', current_run_id: 'run_mine', current_run_set_by_account_id: ME }),
      tv({ tv_id: 'b', tv_name: 'Bag row', current_run_id: 'run_other', current_run_set_by_account_id: 'acct_other' }),
      tv({ tv_id: 'c', tv_name: 'Lobby', status: 'pending', paired_at: null, last_seen_at: null, pair_code_expires_at: '2026-10-08T15:05:00.000Z' }),
      tv({ tv_id: 'd', tv_name: 'Old', status: 'expired', paired_at: null, last_seen_at: null }),
      tv({ tv_id: 'e', tv_name: 'Gone', status: 'disconnected', revoked_at: '2026-10-07T00:00:00.000Z' }),
      tv({ tv_id: 'f', tv_name: 'Odd', status: 'something_new' as GymTvListItem['status'] }),
    ]),
  );
  openPanel({ liveRun: LIVE });
  const list = await screen.findByRole('list', { name: 'Paired TVs' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(6);
  expect(within(items[0]).getByText('PAIRED')).toBeTruthy();
  expect(within(items[0]).getByText('Showing your session')).toBeTruthy();
  expect(within(items[1]).getByText("Showing another coach's session")).toBeTruthy();
  expect(within(items[2]).getByText('WAITING FOR CODE')).toBeTruthy();
  expect(within(items[2]).getByText('Last seen: never')).toBeTruthy();
  expect(within(items[3]).getByText('CODE EXPIRED')).toBeTruthy();
  expect(within(items[4]).getByText('DISCONNECTED')).toBeTruthy();
  // A status this build does not know renders as unknown rather than throwing the dashboard down.
  expect(within(items[5]).getByText('UNKNOWN STATE')).toBeTruthy();
  // A disconnected TV has no controls at all; a pending one can only be disconnected.
  expect(within(items[4]).queryAllByRole('button')).toHaveLength(0);
  expect(within(items[2]).getAllByRole('button').map((b) => b.textContent)).toEqual(['Disconnect Lobby']);
});

test('with the account id unknown, a session on a TV is not called another coach\'s', async () => {
  serve(listOf([tv({ current_run_id: 'run_x', current_run_set_by_account_id: ME })]));
  openPanel({ liveRun: null, coachAccountId: '' });
  await screen.findByText('Showing a live session');
  expect(screen.queryByText(/another coach/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Take off TV/ })).toBeNull();
});

test('a session this coach sent gets a take-off even when it is not the dashboard\'s live run', async () => {
  serve((call) => {
    if (call.method === 'DELETE') return respond({ tv: tv() });
    return respond({ tvs: [tv({ current_run_id: 'run_earlier', current_run_set_by_account_id: ME })] });
  });
  openPanel({ liveRun: null });
  await screen.findByText('Showing a session you sent');
  fireEvent.click(screen.getByRole('button', { name: 'Take off TV Ring wall' }));
  await screen.findByText('Showing nothing');
  expect(writes()).toEqual([{ url: `${LIST_URL}/gymtv_1/session`, method: 'DELETE', body: null }]);
});

test('a failed list read says so rather than showing an empty gym', async () => {
  serve(() => respond({ error: 'Forbidden' }, 403));
  openPanel();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('The TV list could not be read');
  expect(screen.queryByText('No TV has been paired yet.')).toBeNull();
});

test('pairing posts the name, shows the code once, and refreshes the list', async () => {
  let minted = false;
  serve((call) => {
    if (call.method === 'POST') {
      minted = true;
      return respond({ tv: { tv_id: 'gymtv_new', tv_name: 'Ring wall', code: 'ABC234', expires_at: '2026-10-08T15:05:00.000Z' } }, 201);
    }
    return respond({ tvs: minted ? [tv({ tv_id: 'gymtv_new', status: 'pending', paired_at: null, last_seen_at: null })] : [] });
  });
  openPanel();
  await screen.findByText('No TV has been paired yet.');

  const make = screen.getByRole('button', { name: 'Make a pairing code' }) as HTMLButtonElement;
  expect(make.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: '  Ring wall ' } });
  expect(make.disabled).toBe(false);
  fireEvent.click(make);

  await screen.findByText('ABC234');
  expect(writes()).toEqual([{ url: LIST_URL, method: 'POST', body: { tv_name: '  Ring wall ' } }]);
  expect(screen.getByRole('group', { name: 'Pairing code for Ring wall: A B C 2 3 4' })).toBeTruthy();
  const note = screen.getByText(/Type this code on the TV/).textContent ?? '';
  expect(note).toContain('shown only this once');
  expect(note).toContain('stay on this screen until the TV is paired');
  await screen.findByText('WAITING FOR CODE');
  expect((screen.getByLabelText('TV name') as HTMLInputElement).value).toBe('');

  fireEvent.click(screen.getByRole('button', { name: 'Done, hide the code' }));
  expect(screen.queryByText('ABC234')).toBeNull();
  expect(screen.queryByRole('group', { name: /Pairing code/ })).toBeNull();
});

test('two taps on "Make a pairing code" mint one code', async () => {
  let release: () => void = () => {};
  serve((call) => {
    if (call.method === 'POST') {
      return new Promise<Response>((resolve) => {
        release = () => resolve(respond({ tv: { tv_id: 'n', tv_name: 'Lobby', code: 'QQQ222', expires_at: '2026-10-08T15:05:00.000Z' } }, 201));
      });
    }
    return respond({ tvs: [] });
  });
  openPanel();
  await screen.findByText('No TV has been paired yet.');
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: 'Lobby' } });
  const make = screen.getByRole('button', { name: 'Make a pairing code' });
  fireEvent.click(make);
  fireEvent.click(make);
  await act(async () => release());
  await screen.findByText('QQQ222');
  expect(writes()).toHaveLength(1);
});

test('a refused pairing is written on screen and no code is shown', async () => {
  serve((call) => (call.method === 'POST' ? respond({ error: 'TV_PAIR_CODE_RATE_LIMITED' }, 429) : respond({ tvs: [] })));
  openPanel();
  await screen.findByText('No TV has been paired yet.');
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: 'Lobby' } });
  fireEvent.click(screen.getByRole('button', { name: 'Make a pairing code' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Too many codes in the last 10 minutes');
  expect(screen.queryByRole('group', { name: /Pairing code/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Done, hide the code' })).toBeNull();
  // Editing the name clears the old refusal.
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: 'Lobby 2' } });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('TV_NAME_LENGTH and a server answer without a code are both written on screen', async () => {
  let attempt = 0;
  serve((call) => {
    if (call.method === 'POST') {
      attempt += 1;
      return attempt === 1 ? respond({ error: 'TV_NAME_LENGTH' }, 400) : respond({ tv: { tv_id: 'n', tv_name: 'x' } }, 201);
    }
    return respond({ tvs: [] });
  });
  openPanel();
  await screen.findByText('No TV has been paired yet.');
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: 'Lobby' } });
  fireEvent.click(screen.getByRole('button', { name: 'Make a pairing code' }));
  await screen.findByText(/must be 1 to 60 characters/);
  fireEvent.click(screen.getByRole('button', { name: 'Make a pairing code' }));
  await screen.findByText(/answered without a code/);
  expect(screen.queryByRole('group', { name: /Pairing code/ })).toBeNull();
});

test('a network failure while pairing says the outcome is unknown, not "no code was made"', async () => {
  serve((call) => {
    if (call.method === 'POST') throw new Error('offline');
    return respond({ tvs: [] });
  });
  openPanel();
  await screen.findByText('No TV has been paired yet.');
  fireEvent.change(screen.getByLabelText('TV name'), { target: { value: 'Lobby' } });
  fireEvent.click(screen.getByRole('button', { name: 'Make a pairing code' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('could not confirm whether a code was made');
});

test('disconnect asks once, and "Keep it connected" sends nothing', async () => {
  serve(listOf([tv()]));
  openPanel();
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Ring wall' }));
  expect(screen.getByText(/Disconnect Ring wall\? It stops showing anything now/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep it connected' }));
  expect(screen.queryByText(/Disconnect Ring wall\?/)).toBeNull();
  expect(writes()).toEqual([]);
});

test('the disconnect confirm names another coach\'s session when one is on the TV', async () => {
  serve(listOf([tv({ current_run_id: 'run_other', current_run_set_by_account_id: 'acct_other' })]));
  openPanel({ liveRun: LIVE });
  await screen.findByText("Showing another coach's session");
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Ring wall' }));
  expect(screen.getByText(/including the session another coach has on it/)).toBeTruthy();
});

test('confirming the disconnect posts to that TV and shows the server\'s row', async () => {
  serve((call) => {
    if (call.method === 'POST') {
      return respond({ tv: tv({ status: 'disconnected', revoked_at: '2026-10-08T15:10:00.000Z' }) });
    }
    return respond({ tvs: [tv()] });
  });
  openPanel();
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Ring wall' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect it' }));
  await screen.findByText('DISCONNECTED');
  expect(writes()).toEqual([{ url: `${LIST_URL}/gymtv_1/disconnect`, method: 'POST', body: null }]);
  expect(screen.queryByText('PAIRED')).toBeNull();
});

test('a refused disconnect (TV_NOT_FOUND) is kept on screen even when the re-read drops the TV', async () => {
  let reads = 0;
  serve((call) => {
    if (call.method === 'POST') return respond({ error: 'TV_NOT_FOUND' }, 404);
    reads += 1;
    return respond({ tvs: reads === 1 ? [tv()] : [] });
  });
  openPanel();
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Ring wall' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect it' }));
  await screen.findByText('No TV has been paired yet.');
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Ring wall: This TV is no longer listed');
  expect(screen.queryByText(/Disconnect Ring wall\?/)).toBeNull();
});

test('a refusal survives a re-read that fails', async () => {
  let reads = 0;
  serve((call) => {
    if (call.method === 'POST') return respond({ error: 'TV_IN_USE' }, 409);
    reads += 1;
    return reads === 1 ? respond({ tvs: [tv()] }) : respond({ error: 'boom' }, 500);
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByText(/The TV list could not be read/);
  const alerts = screen.getAllByRole('alert').map((a) => a.textContent ?? '');
  expect(alerts.some((t) => t.includes('Ring wall: This TV is in use by another coach'))).toBe(true);
});

test('without a live session there is no send control and the panel says why', async () => {
  serve(listOf([tv()]));
  openPanel({ liveRun: null });
  await screen.findByText('PAIRED');
  expect(screen.queryByRole('button', { name: /Send to TV/ })).toBeNull();
  expect(screen.getByText('Start a session to send it to a TV.')).toBeTruthy();
});

test('when the live run could not be read, the panel says so instead of "start a session"', async () => {
  serve(listOf([tv()]));
  openPanel({ liveRun: null, liveRunKnown: false });
  await screen.findByText('PAIRED');
  expect(screen.queryByText('Start a session to send it to a TV.')).toBeNull();
  expect(screen.getByText(/Whether you have a session in progress could not be checked/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Send to TV/ })).toBeNull();
});

test('"Send to TV" posts the live run id and the row shows the session', async () => {
  serve((call) => {
    if (call.method === 'POST') {
      return respond({ tv: tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME }) });
    }
    return respond({ tvs: [tv()] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByText('Showing your session');
  expect(writes()).toEqual([{ url: `${LIST_URL}/gymtv_1/session`, method: 'POST', body: { run_id: 'run_mine' } }]);
  // Now it is on the TV, the control flips to take-off.
  expect(screen.queryByRole('button', { name: 'Send to TV Ring wall' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Take off TV Ring wall' })).toBeTruthy();
});

test('two taps on "Send to TV" send once, and every control waits while it is in flight', async () => {
  let release: () => void = () => {};
  serve((call) => {
    if (call.method === 'POST') {
      return new Promise<Response>((resolve) => {
        release = () => resolve(respond({ tv: tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME }) }));
      });
    }
    return respond({ tvs: [tv(), tv({ tv_id: 'b', tv_name: 'Bag row' })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('Bag row');
  const send = screen.getByRole('button', { name: 'Send to TV Ring wall' });
  fireEvent.click(send);
  fireEvent.click(send);
  expect((screen.getByRole('button', { name: 'Sending...' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Send to TV Bag row' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Disconnect Bag row' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());
  await screen.findByText('Showing your session');
  expect(writes()).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Send to TV Bag row' }) as HTMLButtonElement).disabled).toBe(false);
});

test('TV_IN_USE is answered as "in use by another coach" and the list is re-read', async () => {
  serve((call) => {
    if (call.method === 'POST') return respond({ error: 'TV_IN_USE' }, 409);
    return respond({ tvs: [tv({ current_run_id: 'run_other', current_run_set_by_account_id: 'acct_other' })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText("Showing another coach's session");
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('This TV is in use by another coach');
  await waitFor(() => expect(gets()).toHaveLength(2));
});

test('a session with "Show on TV" off is refused in words, and the panel says so beforehand', async () => {
  serve((call) => (call.method === 'POST' ? respond({ error: 'SESSION_RUN_NOT_ON_TV' }, 409) : respond({ tvs: [tv()] })));
  openPanel({ liveRun: { run_id: 'run_mine', show_on_wall: false } });
  await screen.findByText('PAIRED');
  expect(screen.getByText(/"Show on TV" switch is off/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Switch "Show on TV" on for your session first');
});

test('a run the server says is no longer live is written on screen and the dashboard is told to re-read it', async () => {
  const onRunStale = jest.fn();
  serve((call) => (call.method === 'POST' ? respond({ error: 'SESSION_RUN_NOT_LIVE' }, 409) : respond({ tvs: [tv()] })));
  openPanel({ liveRun: LIVE, onRunStale });
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByText(/Your session is no longer live/);
  expect(onRunStale).toHaveBeenCalledTimes(1);
});

test('SESSION_RUN_NOT_FOUND is written on screen and also tells the dashboard', async () => {
  const onRunStale = jest.fn();
  serve((call) => (call.method === 'POST' ? respond({ error: 'SESSION_RUN_NOT_FOUND' }, 404) : respond({ tvs: [tv()] })));
  openPanel({ liveRun: LIVE, onRunStale });
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByText(/Your session could not be found/);
  expect(onRunStale).toHaveBeenCalledTimes(1);
});

test('when the live run changes under an open list, the list is re-read', async () => {
  let reads = 0;
  serve(() => {
    reads += 1;
    return respond({ tvs: reads === 1 ? [tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME })] : [tv()] });
  });
  const view = openPanel({ liveRun: LIVE });
  await screen.findByText('Showing your session');
  view.rerender(panel({ liveRun: null }));
  await screen.findByText('Showing nothing');
  expect(gets()).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /Take off TV/ })).toBeNull();
});

test('a live run change while the panel is closed reads nothing', () => {
  serve(listOf([]));
  const view = render(panel({ liveRun: LIVE }));
  view.rerender(panel({ liveRun: null }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('"Take off TV" sends DELETE and the row shows nothing', async () => {
  serve((call) => {
    if (call.method === 'DELETE') return respond({ tv: tv() });
    return respond({ tvs: [tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('Showing your session');
  fireEvent.click(screen.getByRole('button', { name: 'Take off TV Ring wall' }));
  await screen.findByText('Showing nothing');
  expect(writes()).toEqual([{ url: `${LIST_URL}/gymtv_1/session`, method: 'DELETE', body: null }]);
  expect(screen.getByRole('button', { name: 'Send to TV Ring wall' })).toBeTruthy();
});

test('a refused take-off is written under the TV', async () => {
  serve((call) => {
    if (call.method === 'DELETE') return respond({ error: 'TV_IN_USE' }, 409);
    return respond({ tvs: [tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('Showing your session');
  fireEvent.click(screen.getByRole('button', { name: 'Take off TV Ring wall' }));
  await screen.findByText(/This TV is in use by another coach/);
});

test('every other refusal is written under the TV it was about', async () => {
  serve((call) => {
    if (call.method === 'POST') return respond({ error: 'TV_NOT_PAIRED' }, 409);
    return respond({ tvs: [tv({ tv_id: 'a', tv_name: 'A' }), tv({ tv_id: 'b', tv_name: 'B' })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('A');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV B' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('This TV is not paired yet');
  const items = within(screen.getByRole('list', { name: 'Paired TVs' })).getAllByRole('listitem');
  expect(within(items[1]).getByRole('alert')).toBe(alert);
  expect(within(items[0]).queryByRole('alert')).toBeNull();
});

test('a sign-in that expired mid-action is said in words', async () => {
  serve((call) => (call.method === 'POST' ? respond({ error: 'Unauthorized: session expired' }, 401) : respond({ tvs: [tv()] })));
  openPanel({ liveRun: LIVE });
  await screen.findByText('PAIRED');
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV Ring wall' }));
  await screen.findByText(/Your sign-in has expired/);
});

test('a network failure on an action says the outcome is unknown and re-reads the list', async () => {
  let reads = 0;
  serve((call) => {
    if (call.method === 'DELETE') throw new Error('offline');
    reads += 1;
    return respond({ tvs: [reads === 1 ? tv({ current_run_id: 'run_mine', current_run_set_by_account_id: ME }) : tv()] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('Showing your session');
  fireEvent.click(screen.getByRole('button', { name: 'Take off TV Ring wall' }));
  await screen.findByText('Showing nothing');
  expect(screen.getByRole('alert').textContent).toContain('could not confirm whether it went through');
  expect(gets()).toHaveLength(2);
});

test('an action on one TV does not close the disconnect prompt open on another', async () => {
  serve((call) => {
    if (call.method === 'POST') return respond({ tv: tv({ tv_id: 'a', tv_name: 'A', current_run_id: 'run_mine', current_run_set_by_account_id: ME }) });
    return respond({ tvs: [tv({ tv_id: 'a', tv_name: 'A' }), tv({ tv_id: 'b', tv_name: 'B' })] });
  });
  openPanel({ liveRun: LIVE });
  await screen.findByText('B');
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect B' }));
  expect(screen.getByText(/Disconnect B\?/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send to TV A' }));
  await screen.findByText('Showing your session');
  expect(screen.getByText(/Disconnect B\?/)).toBeTruthy();
});

test('the refusal dictionary says the right sentence for every code the gym-tvs routes can answer', () => {
  const table: Array<[string, number, RegExp]> = [
    ['TV_IN_USE', 409, /in use by another coach/],
    ['TV_NOT_PAIRED', 409, /not paired yet/],
    ['TV_NOT_FOUND', 404, /no longer listed/],
    ['SESSION_RUN_NOT_ON_TV', 409, /Switch "Show on TV" on/],
    ['SESSION_RUN_NOT_LIVE', 409, /no longer live/],
    ['SESSION_RUN_NOT_FOUND', 404, /could not be found/],
    ['TV_NAME_REQUIRED', 400, /Give the TV a name/],
    ['TV_NAME_LENGTH', 400, /1 to 60 characters/],
    ['TV_PAIR_CODE_RATE_LIMITED', 429, /Too many codes/],
    ['Unauthorized: session expired', 401, /sign-in has expired/],
    ['Forbidden', 403, /not allowed to manage gym TVs/],
  ];
  for (const [code, status, expected] of table) {
    expect(describeRefusal(code, status)).toMatch(expected);
  }
  expect(describeRefusal('SOMETHING_NEW', 409)).toBe('The server refused: SOMETHING_NEW');
  expect(describeRefusal(undefined, 500)).toBe('The server refused the request (500).');
});
