/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import MinorLimitsPanel, { LIMIT_TYPES, describeLimit } from './MinorLimitsPanel';
// athleteMinorLimits.ts imports pg through db.ts, which jsdom cannot load, so
// its three constants are pinned here; the server module's values are the
// same strings (MINOR_LIMIT_TYPES, SUPERVISION_TEXT_MAX = 500, NOTE_MAX = 1000).
const MINOR_LIMIT_TYPES = ['heat_exposure_minutes_per_session', 'weight_cut_max_percent_body_weight', 'supervision'];
const SUPERVISION_TEXT_MAX = 500;
const NOTE_MAX = 1000;

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const HEAT = {
  limit_id: 'lim-heat',
  athlete_id: 'ath-1',
  limit_type: 'heat_exposure_minutes_per_session',
  value_number: 20,
  value_text: null,
  unit: 'minutes',
  note: 'Asthma; parent asked',
  set_by_account_id: 'acct-coach',
  set_by_role: 'coach',
  set_by_name: 'Coach Jason',
  set_at: '2026-10-07T12:00:00.000Z',
};
const SUPERVISION = {
  ...HEAT,
  limit_id: 'lim-sup',
  limit_type: 'supervision',
  value_number: null,
  value_text: 'Coach within arm’s reach for all pad work',
  unit: 'text',
  note: '',
};
const CLEARED_CUT = {
  ...HEAT,
  limit_id: 'lim-cut-cleared',
  limit_type: 'weight_cut_max_percent_body_weight',
  value_number: null,
  unit: 'percent_body_weight',
  note: 'No longer cutting',
};

const NONE = { heat_exposure_minutes_per_session: null, weight_cut_max_percent_body_weight: null, supervision: null };
const LIMITS_URL = '/api/pilot/coach/athlete-minor-limits';
const CAPS_URL = '/api/pilot/coach/athlete-contact-caps';

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; init?: RequestInit }
let calls: Call[];
let bodies: Array<Record<string, unknown>>;

/** Records every request; assertions happen in the test body, never inside the double. */
function serve(handlers: {
  limits?: () => Response;
  caps?: () => Response;
  post?: () => Response;
} = {}) {
  calls = [];
  bodies = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)));
      return handlers.post ? handlers.post() : respond({ ok: true, limit: HEAT, written: HEAT });
    }
    if (url.includes(CAPS_URL)) return handlers.caps ? handlers.caps() : respond({ ok: true, cap: null, history: [] });
    return handlers.limits
      ? handlers.limits()
      : respond({ ok: true, athlete_is_minor: true, limit_types: MINOR_LIMIT_TYPES, limits: NONE, history: [] });
  }) as unknown as typeof fetch;
}

function openPanel() {
  render(<MinorLimitsPanel athleteId="ath-1" athleteName="Sam" />);
  fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the panel’s three types are the server’s three, in its order', () => {
  expect([...LIMIT_TYPES]).toEqual([...MINOR_LIMIT_TYPES]);
});

test('reads nothing until opened, then reads limits and the contact cap for that athlete with credentials', async () => {
  serve();
  render(<MinorLimitsPanel athleteId="ath-1" athleteName="Sam" />);
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
  await screen.findByText(/Minor — these limits/);
  const urls = calls.map((c) => c.url);
  expect(urls).toContain(`${LIMITS_URL}?athlete_id=ath-1`);
  expect(urls).toContain(`${CAPS_URL}?athlete_id=ath-1`);
  expect(calls.every((c) => c.init?.credentials === 'include')).toBe(true);
});

test('with no limit set, every type says so, no field holds a suggested value, and Clear is not offered', async () => {
  serve();
  openPanel();
  await screen.findByText(/Minor — these limits/);
  expect(screen.getAllByText(/No limit set\. The app never picks one/)).toHaveLength(3);
  for (const id of ['ath-1-heat_exposure_minutes_per_session', 'ath-1-weight_cut_max_percent_body_weight', 'ath-1-supervision']) {
    expect((document.getElementById(`minor-limits-${id}`) as HTMLInputElement).value).toBe('');
  }
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  expect(screen.getByText('No sparring cap set.')).toBeTruthy();
});

test('an adult is labelled adult, from the server, and limits still show', async () => {
  serve({
    limits: () => respond({ ok: true, athlete_is_minor: false, limits: { ...NONE, heat_exposure_minutes_per_session: HEAT }, history: [HEAT] }),
  });
  openPanel();
  await screen.findByText(/Adult — limits are recorded/);
  expect(screen.getByText('Heat exposure: at most 20 minutes per session')).toBeTruthy();
  expect(screen.getByText('Reason: Asthma; parent asked')).toBeTruthy();
  expect(screen.getByText(/Set by Coach Jason on/)).toBeTruthy();
  // The form starts from the coach's own number.
  expect((document.getElementById('minor-limits-ath-1-heat_exposure_minutes_per_session') as HTMLInputElement).value).toBe('20');
  expect(screen.getAllByRole('button', { name: 'Clear' })).toHaveLength(1);
});

test('the contact cap is shown read-only with a link to its own page, and is never set here', async () => {
  serve({
    caps: () => respond({ ok: true, cap: { cap_id: 'cap-1', highest_allowed_stage: 'controlled_sparring', max_hard_open_sessions_per_7_days: 1 }, history: [] }),
  });
  openPanel();
  await screen.findByText(/Cap in force: highest stage/);
  expect(screen.getByText(/at most 1 hard or open sessions in any 7 days/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Sparring Caps' }).getAttribute('href')).toBe('/coach/sparring-caps');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getAllByRole('button').map((b) => b.textContent)).not.toContain('Save cap');
});

test('saving a heat limit posts that ONE type with the number and the reason; the form reloads after', async () => {
  serve();
  openPanel();
  await screen.findByText(/Minor — these limits/);
  fireEvent.change(document.getElementById('minor-limits-ath-1-heat_exposure_minutes_per_session')!, { target: { value: '20' } });
  fireEvent.change(document.getElementById('minor-limits-ath-1-heat_exposure_minutes_per_session-note')!, { target: { value: 'Asthma' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save limit' })[0]);
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({ athlete_id: 'ath-1', limit_type: 'heat_exposure_minutes_per_session', value: 20, note: 'Asthma' });
  await waitFor(() => expect(calls.filter((c) => c.url === `${LIMITS_URL}?athlete_id=ath-1`)).toHaveLength(2));
});

test('saving supervision posts the coach’s words as text', async () => {
  serve();
  openPanel();
  await screen.findByText(/Minor — these limits/);
  fireEvent.change(document.getElementById('minor-limits-ath-1-supervision')!, { target: { value: '  Within arm’s reach  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save supervision' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({ athlete_id: 'ath-1', limit_type: 'supervision', value: 'Within arm’s reach', note: '' });
});

test('Clear sends value null for that one type and keeps the reason typed', async () => {
  serve({
    limits: () => respond({ ok: true, athlete_is_minor: true, limits: { ...NONE, supervision: SUPERVISION }, history: [SUPERVISION] }),
  });
  openPanel();
  await screen.findByRole('button', { name: 'Clear' });
  fireEvent.change(document.getElementById('minor-limits-ath-1-supervision-note')!, { target: { value: 'Now 16 and cleared by coach' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({ athlete_id: 'ath-1', limit_type: 'supervision', value: null, note: 'Now 16 and cleared by coach' });
});

test.each([
  ['a blank number', 'heat_exposure_minutes_per_session', '', /Enter a number, 0 or more/],
  ['a non-number', 'weight_cut_max_percent_body_weight', '1e2', /Enter a number, 0 or more/],
  ['three decimals', 'weight_cut_max_percent_body_weight', '2.555', /at most two decimal places/],
  ['a negative', 'heat_exposure_minutes_per_session', '-5', /Enter a number, 0 or more/],
  ['blank supervision', 'supervision', '   ', /Write the supervision you require/],
])('refuses %s on screen and sends nothing', async (_label, type, typed, message) => {
  serve();
  openPanel();
  await screen.findByText(/Minor — these limits/);
  fireEvent.change(document.getElementById(`minor-limits-ath-1-${type}`)!, { target: { value: typed } });
  const label = type === 'supervision' ? 'Save supervision' : 'Save limit';
  const index = type === 'heat_exposure_minutes_per_session' ? 0 : 1;
  fireEvent.click(screen.getAllByRole('button', { name: label })[type === 'supervision' ? 0 : index]);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText('NOT SAVED')).toBeTruthy();
  expect(bodies).toHaveLength(0);
});

test('the server’s refusal is shown under the type it refused, in its own words', async () => {
  serve({ post: () => respond({ ok: false, error: 'a percentage of body weight cannot be more than 100' }, 400) });
  openPanel();
  await screen.findByText(/Minor — these limits/);
  fireEvent.change(document.getElementById('minor-limits-ath-1-weight_cut_max_percent_body_weight')!, { target: { value: '150' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save limit' })[1]);
  expect(await screen.findByText('a percentage of body weight cannot be more than 100')).toBeTruthy();
  expect(bodies).toHaveLength(1);
});

test('a failed connection says nothing changed', async () => {
  serve({ post: () => { throw new Error('offline'); } });
  openPanel();
  await screen.findByText(/Minor — these limits/);
  fireEvent.change(document.getElementById('minor-limits-ath-1-heat_exposure_minutes_per_session')!, { target: { value: '10' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save limit' })[0]);
  expect(await screen.findByText(/connection failed\. Nothing changed/)).toBeTruthy();
});

test.each([
  ['a 403', () => respond({ error: 'no' }, 403)],
  ['a malformed body', () => respond({ ok: true, limits: {} })],
  ['a type missing', () => respond({ ok: true, athlete_is_minor: true, limits: { supervision: null }, history: [] })],
  ['an in-force row with no value', () => respond({ ok: true, athlete_is_minor: true, limits: { ...NONE, supervision: CLEARED_CUT }, history: [] })],
])('%s reads as unavailable, never as "no limit set"', async (_label, limits) => {
  serve({ limits });
  openPanel();
  expect(await screen.findByText(/could not be read just now\. Unknown is not “no limit set”/)).toBeTruthy();
  expect(screen.queryByText(/No limit set/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(calls.filter((c) => c.url.startsWith(LIMITS_URL))).toHaveLength(2));
});

test('a cap that cannot be read says so without hiding the limits', async () => {
  serve({ caps: () => respond({}, 500) });
  openPanel();
  await screen.findByText(/Minor — these limits/);
  expect(await screen.findByText(/The sparring cap could not be read just now/)).toBeTruthy();
  expect(screen.queryByText('No sparring cap set.')).toBeNull();
});

test('history lists every write newest first, cleared rows included, with the reason', async () => {
  serve({
    limits: () => respond({ ok: true, athlete_is_minor: true, limits: { ...NONE, heat_exposure_minutes_per_session: HEAT }, history: [CLEARED_CUT, HEAT, SUPERVISION] }),
  });
  openPanel();
  await screen.findByText('Limit history (3)');
  const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
  expect(items[0]).toContain('Weight cut limit cleared');
  expect(items[0]).toContain('No longer cutting');
  expect(items[1]).toContain('Heat exposure: at most 20 minutes per session');
  expect(items[2]).toContain('Supervision: Coach within arm’s reach');
});

test('closing the panel drops a read that lands late, so it never reopens itself', async () => {
  let release: (() => void) | null = null;
  serve({
    limits: () => {
      // Returned through a promise the test releases after the panel closes.
      return new Promise<Response>((resolve) => {
        release = () => resolve(respond({ ok: true, athlete_is_minor: true, limits: NONE, history: [] }));
      }) as unknown as Response;
    },
  });
  openPanel();
  expect(screen.getByText('Reading…')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide limits' }));
  release!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/No limit set/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Limits' })).toBeTruthy();
});

test('field lengths mirror the server’s bounds', async () => {
  serve();
  openPanel();
  await screen.findByText(/Minor — these limits/);
  expect((document.getElementById('minor-limits-ath-1-supervision') as HTMLInputElement).maxLength).toBe(SUPERVISION_TEXT_MAX);
  expect((document.getElementById('minor-limits-ath-1-supervision-note') as HTMLInputElement).maxLength).toBe(NOTE_MAX);
});

test('describeLimit names each type and its clearing', () => {
  expect(describeLimit(HEAT as never)).toBe('Heat exposure: at most 20 minutes per session');
  expect(describeLimit(SUPERVISION as never)).toBe('Supervision: Coach within arm’s reach for all pad work');
  expect(describeLimit(CLEARED_CUT as never)).toBe('Weight cut limit cleared');
  expect(describeLimit({ ...HEAT, value_number: 2.5, limit_type: 'weight_cut_max_percent_body_weight' } as never)).toBe('Weight cut: at most 2.5% of body weight');
});
