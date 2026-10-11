/**
 * @jest-environment jsdom
 */

// Transfer check page. What these pin: a not-transferring flag renders
// with its RAW COUNTS (the coach sees the same facts the rule saw);
// untested-live renders as an honest unknown, not a failure; and nothing
// on the page renders a score or percentage.

import { act, fireEvent, render, screen } from '@testing-library/react';

import TransferCheckPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const READOUT = [
  {
    metric_kind: 'reps',
    controlled_makes: 8, controlled_misses: 1,
    live_makes: 1, live_misses: 5,
    state: 'not_transferring',
  },
  {
    metric_kind: 'time_seconds',
    controlled_makes: 5, controlled_misses: 1,
    live_makes: 0, live_misses: 0,
    state: 'untested_live',
  },
];

function mockFetch() {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/transfer-check')) {
      return { ok: true, json: async () => ({ items: READOUT }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('flags render with raw counts, and untested-live reads as unknown rather than failure', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<TransferCheckPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  expect(await screen.findByText('not transferring')).toBeTruthy();
  expect(screen.getByText(/practice: 8 of 9 made · live: 1 of 6 made/)).toBeTruthy();
  expect(screen.getByText(/the gain has not transferred yet/i)).toBeTruthy();

  expect(screen.getByText('untested live')).toBeTruthy();
  expect(screen.getByText(/untested, not failing/i)).toBeTruthy();

  // No score, no percentage, anywhere.
  expect(screen.queryByText(/%/)).toBeNull();
  expect(screen.getByText(/never a verdict/)).toBeTruthy();
});

// Lane N3-01. The picker lists the whole gym; the readout is per athlete and a
// coach is refused on an athlete who is not theirs (OD-2026-10-05-024 item 2).
// What these pin: the readout on screen always belongs to the athlete picked,
// and each of the four states says something true about the counts beside it.

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Jordan P.' },
  { athlete_id: 'ath-2', full_name: 'Casey R.' },
];

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function mockRosterFetch(readoutFor: (athleteId: string) => Response | Promise<Response>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return okJson({ items: ROSTER });
    return readoutFor(url.includes('athlete_id=ath-2') ? 'ath-2' : 'ath-1');
  }) as unknown as typeof fetch;
}

async function pick(athleteId: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: athleteId } });
  });
}

test('an athlete the server refuses shows nothing from the athlete before', async () => {
  global.fetch = mockRosterFetch((athleteId) => (athleteId === 'ath-1'
    ? okJson({ items: READOUT })
    : ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }) as Response));

  await act(async () => { render(<TransferCheckPage />); });
  await pick('ath-1');
  expect(await screen.findByText('not transferring')).toBeTruthy();

  await pick('ath-2');
  expect(await screen.findByText('Unable to load the transfer check.')).toBeTruthy();

  // Jordan's flags are not Casey's, and must not sit under Casey's name.
  expect(screen.queryByText('not transferring')).toBeNull();
  expect(screen.queryByText('untested live')).toBeNull();
  expect(screen.queryByText(/practice: 8 of 9 made/)).toBeNull();
});

test('a refusal for one athlete does not stay on screen once the coach picks nobody', async () => {
  global.fetch = mockRosterFetch(() => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }) as Response);

  await act(async () => { render(<TransferCheckPage />); });
  await pick('ath-2');
  expect(await screen.findByText('Unable to load the transfer check.')).toBeTruthy();

  await pick('');
  expect(screen.queryByText('Unable to load the transfer check.')).toBeNull();
});

// This mock does not honour the abort signal, so it models an answer that has
// already arrived when the coach switches. A real fetch rejects on abort and
// the effect drops it; the guard this pins is the belt to that brace.
test('a slow answer for the athlete before never renders under the athlete picked now', async () => {
  let answerJordan!: (response: Response) => void;
  const jordan = new Promise<Response>((resolve) => { answerJordan = resolve; });
  global.fetch = mockRosterFetch((athleteId) => (athleteId === 'ath-1'
    ? jordan
    : okJson({ items: [{ metric_kind: 'rounds', controlled_makes: 6, controlled_misses: 0, live_makes: 4, live_misses: 1, state: 'transferring' }] })));

  await act(async () => { render(<TransferCheckPage />); });
  await pick('ath-1');
  await pick('ath-2');
  expect(await screen.findByText('transferring')).toBeTruthy();

  await act(async () => { answerJordan(okJson({ items: READOUT })); });

  expect(screen.getByText('transferring')).toBeTruthy();
  expect(screen.queryByText('not transferring')).toBeNull();
});

test('each of the four states reads as itself, and insufficient evidence stays true when the counts are not thin', async () => {
  global.fetch = mockRosterFetch(() => okJson({
    items: [
      { metric_kind: 'reps', controlled_makes: 8, controlled_misses: 1, live_makes: 1, live_misses: 5, state: 'not_transferring' },
      { metric_kind: 'time_seconds', controlled_makes: 5, controlled_misses: 1, live_makes: 0, live_misses: 0, state: 'untested_live' },
      { metric_kind: 'rounds', controlled_makes: 6, controlled_misses: 0, live_makes: 4, live_misses: 1, state: 'transferring' },
      // Ten practice attempts, five live: nothing thin about it. The rule is
      // silent because practice is not yet holding (3 of 10).
      { metric_kind: 'load_kg', controlled_makes: 3, controlled_misses: 7, live_makes: 0, live_misses: 5, state: 'insufficient_evidence' },
    ],
  }));

  await act(async () => { render(<TransferCheckPage />); });
  await pick('ath-1');

  expect(await screen.findByText('not transferring')).toBeTruthy();
  expect(screen.getByText(/the gain has not transferred yet/i)).toBeTruthy();
  expect(screen.getByText('untested live')).toBeTruthy();
  expect(screen.getByText(/untested, not failing/i)).toBeTruthy();
  expect(screen.getByText('transferring')).toBeTruthy();
  expect(screen.getByText('Holding up under live conditions.')).toBeTruthy();

  expect(screen.getByText('insufficient evidence')).toBeTruthy();
  expect(screen.getByText(/practice: 3 of 10 made · live: 0 of 5 made/)).toBeTruthy();
  expect(screen.getByText(/too few targeted attempts on one side, or practice is not yet holding/)).toBeTruthy();
  // The old copy called every such record thin; this one is not.
  expect(screen.queryByText(/thin record/)).toBeNull();
  expect(screen.queryByText(/Not enough targeted attempts/)).toBeNull();
});

test('an athlete with nothing in the window gets the empty state, not a flag', async () => {
  global.fetch = mockRosterFetch(() => okJson({ items: [] }));

  await act(async () => { render(<TransferCheckPage />); });
  await pick('ath-1');

  expect(await screen.findByText('No targeted attempts in the window')).toBeTruthy();
  expect(screen.queryByText('insufficient evidence')).toBeNull();
});
