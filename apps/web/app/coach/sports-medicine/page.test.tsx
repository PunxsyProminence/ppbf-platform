/**
 * @jest-environment jsdom
 */

// The clearance board replaced a scaffold that showed org-wide SHADOW
// projections under a sports-medicine heading. What these pin: the board
// reads clearance + holds per roster athlete and NOTHING clinical; "no
// record" and a failed read are rendered as action states, never as quiet or
// as cleared; and the loading state withholds every claim.
//
// The second group pins the WRITE surface. Before it existed, POST
// /api/pilot/training-holds had zero client callers: a coach could read that a
// child was held and had no way to hold a child. These tests pin the payload
// the form sends, that a refused write lands as a Law 7 stamp rather than a
// crash or a toast, that a lift goes through, and -- deliberately -- that the
// board still learns the hold's state from the same GET it always used, not
// from the write's own response.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import SportsMedicinePage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const ATHLETE = { athlete_id: 'ath-1', full_name: 'Jordan Doe' };

const CLEARED_STATUS = {
  status_id: 'status-1',
  status: 'cleared',
  effective_at: '2026-08-01T10:00:00.000Z',
  // Fields the surface must never display, present in the payload on purpose
  // so the tests can pin their absence from the DOM.
  restriction_flags: { no_sparring: true },
  source_reference: 'physician-note-123',
};

const HOLD = {
  hold_id: 'hold-7',
  scope: 'sparring',
  athlete_explanation: 'Taking a week off contact while your headache settles.',
  lift_condition_text: 'A symptom-free week and a coach check-in.',
};

function mockFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, responder] of Object.entries(overrides)) {
      if (url.includes(fragment)) return responder();
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
    }
    if (url.includes('/shadow/medical-status')) {
      return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
    }
    if (url.includes('/training-holds')) {
      return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the roster is still loading', async () => {
  global.fetch = mockFetch({ '/athletes/list': () => new Promise<Response>(() => {}) });

  render(<SportsMedicinePage />);

  await screen.findByText(/Loading clearance board/);
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('a cleared athlete shows the badge and date, and no clinical detail leaks', async () => {
  global.fetch = mockFetch();

  render(<SportsMedicinePage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByText('cleared')).toBeTruthy();
  expect(screen.getByText(/since/)).toBeTruthy();

  // The payload carried restriction flags and a source reference; the surface
  // must not.
  expect(screen.queryByText(/no_sparring/)).toBeNull();
  expect(screen.queryByText(/physician-note-123/)).toBeNull();
});

test('no clearance record reads as an action state, not as quiet', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () => ({ ok: true, json: async () => ({ ok: true, status: null }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText('no record');
  expect(screen.getByText(/medical gate blocks recommendations/)).toBeTruthy();
});

test('a failed clearance read says unknown is not cleared', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () => ({ ok: false, json: async () => ({}) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText('unavailable');
  expect(screen.getByText(/Unknown is not cleared/)).toBeTruthy();
  expect(screen.queryByText('cleared')).toBeNull();
});

test('an active hold shows its athlete-safe explanation and lift condition', async () => {
  global.fetch = mockFetch({
    '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD] }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText(/Active Training Hold — sparring/);
  expect(screen.getByText(HOLD.athlete_explanation)).toBeTruthy();
  expect(screen.getByText(/A symptom-free week and a coach check-in/)).toBeTruthy();

  await waitFor(() => expect(screen.queryByText(/Loading clearance board/)).toBeNull());
});

/* ---------------------------------------------------------------------------
   The write surface: placing and lifting a hold.
   ------------------------------------------------------------------------- */

const PLACED = {
  hold_id: 'hold-9',
  scope: 'contact_only',
  athlete_explanation: 'No contact for now while your wrist settles.',
  lift_condition_text: 'A pain-free grip and a coach check-in.',
};

interface WriteHarness {
  posted: Array<Record<string, unknown>>;
  holdReads: () => number;
}

/**
 * A fetch double that distinguishes the hold GET from the hold POST -- they are
 * the same URL -- and lets each test decide what the GET returns on the first
 * read versus every read after it, which is how "the board re-read it" is
 * observable at all.
 */
function mockWriteFetch(options: {
  holdsBefore?: Array<Record<string, unknown>>;
  holdsAfter?: Array<Record<string, unknown>>;
  post?: () => Response;
}): WriteHarness {
  const posted: Array<Record<string, unknown>> = [];
  let holdReads = 0;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (options.post) return options.post();
      return { ok: true, json: async () => ({ ok: true, hold: PLACED }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
    }
    if (url.includes('/shadow/medical-status')) {
      return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
    }
    if (url.includes('/training-holds')) {
      holdReads += 1;
      const holds = holdReads === 1 ? (options.holdsBefore ?? []) : (options.holdsAfter ?? []);
      return { ok: true, json: async () => ({ ok: true, holds }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;

  return { posted, holdReads: () => holdReads };
}

async function openPlaceForm() {
  await screen.findByText('Jordan Doe');
  fireEvent.click(screen.getByRole('button', { name: 'Place a training hold' }));
  await screen.findByLabelText(/What this athlete reads/);
}

test('the place form sends the payload the route requires, and the board re-reads the hold', async () => {
  const harness = mockWriteFetch({ holdsBefore: [], holdsAfter: [PLACED] });

  render(<SportsMedicinePage />);
  await openPlaceForm();

  fireEvent.change(screen.getByLabelText('What stops'), { target: { value: 'contact_only' } });
  fireEvent.change(screen.getByLabelText(/Why \(category\)/), { target: { value: 'medical' } });
  fireEvent.change(screen.getByLabelText(/What this athlete reads/), {
    target: { value: PLACED.athlete_explanation },
  });
  fireEvent.change(screen.getByLabelText(/What lifts it/), {
    target: { value: PLACED.lift_condition_text },
  });
  fireEvent.change(screen.getByLabelText(/Staff note/), { target: { value: 'Right wrist, seen 08/16.' } });

  const readsBeforeWrite = harness.holdReads();
  fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

  await screen.findByText(/Active Training Hold — contact only/);

  expect(harness.posted).toEqual([
    {
      action: 'place',
      athlete_id: 'ath-1',
      scope: 'contact_only',
      reason_category: 'medical',
      athlete_explanation: PLACED.athlete_explanation,
      lift_condition_text: PLACED.lift_condition_text,
      reason_text: 'Right wrist, seen 08/16.',
    },
  ]);

  // The hold on screen came from a fresh GET, not from the POST response --
  // the read path stays the single source of truth for what is displayed.
  expect(harness.holdReads()).toBeGreaterThan(readsBeforeWrite);
  expect(screen.getByText(PLACED.athlete_explanation)).toBeTruthy();
});

test('a refused placement lands as a stamp carrying the server’s reason, and the page survives', async () => {
  const harness = mockWriteFetch({
    holdsBefore: [],
    holdsAfter: [],
    post: () =>
      ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Hold already exists: hold-3 is active for this athlete -- lift it first' }),
      }) as Response,
  });

  render(<SportsMedicinePage />);
  await openPlaceForm();

  fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

  const stamp = await screen.findByText('Hold Not Placed');
  expect(stamp.className).toContain('stamp');
  expect(screen.getByText(/lift it first/)).toBeTruthy();

  // A refusal is not a crash and not a false claim of protection.
  expect(screen.getByText('Jordan Doe')).toBeTruthy();
  expect(screen.queryByText(/Active Training Hold/)).toBeNull();
  expect(harness.posted).toHaveLength(1);
});

test('a hold with no athlete sentence is refused before the request is sent', async () => {
  const harness = mockWriteFetch({ holdsBefore: [], holdsAfter: [] });

  render(<SportsMedicinePage />);
  await openPlaceForm();
  fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

  await screen.findByText('Hold Not Placed');
  expect(screen.getByText(/Write the sentence this athlete reads/)).toBeTruthy();
  expect(harness.posted).toHaveLength(0);
});

test('lifting an active hold posts the hold id and the board stops showing it', async () => {
  const harness = mockWriteFetch({
    holdsBefore: [HOLD],
    holdsAfter: [],
    post: () => ({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, status: 'lifted' } }) }) as Response,
  });

  render(<SportsMedicinePage />);
  await screen.findByText(/Active Training Hold — sparring/);

  fireEvent.change(screen.getByLabelText(/Lift note/), { target: { value: 'Symptom-free week, cleared by the office.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

  await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());

  expect(harness.posted).toEqual([
    { action: 'lift', hold_id: 'hold-7', lift_note: 'Symptom-free week, cleared by the office.' },
  ]);
  // The place control is back, because this athlete is no longer held.
  expect(screen.getByRole('button', { name: 'Place a training hold' })).toBeTruthy();
});

test('a refused lift keeps the hold on screen — a child stays held until the server says otherwise', async () => {
  mockWriteFetch({
    holdsBefore: [HOLD],
    holdsAfter: [],
    post: () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ error: "Unsupported transition: hold is 'expired' and cannot be lifted" }),
      }) as Response,
  });

  render(<SportsMedicinePage />);
  await screen.findByText(/Active Training Hold — sparring/);

  fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

  await screen.findByText('Hold Not Lifted');
  expect(screen.getByText(/cannot be lifted/)).toBeTruthy();
  expect(screen.getByText(/Active Training Hold — sparring/)).toBeTruthy();
});
