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

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// The route requires the athlete's sentence and does NOT require a lift
// condition, so this row is a real shape the board has to render, not a
// hypothetical one.
const HOLD_NO_LIFT = {
  hold_id: 'hold-11',
  scope: 'all_training',
  athlete_explanation: 'Sitting out this week while your ankle settles.',
  lift_condition_text: '',
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

test('a hold with no lift condition still tells the coach what the athlete is told', async () => {
  // The whole point: this line used to render only when a condition had been
  // written, so a hold could show a stamp, a scope, an explanation and a Lift
  // button while saying nothing about what ends it. RefusalStamp throws rather
  // than render that; TrainingHoldBanner substitutes an honest fallback. This
  // board now does the latter -- throwing here would take a held child off the
  // coach's screen entirely.
  global.fetch = mockFetch({
    '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD_NO_LIFT] }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText(/Active Training Hold — all training/);
  expect(screen.getByText(/^Lifts when:/)).toBeTruthy();
  expect(screen.getByText(/ask whoever placed the hold/)).toBeTruthy();
  expect(screen.getByText(/Tell them what ends it/)).toBeTruthy();
});

test('a real lift condition is printed as written, never replaced by the fallback', async () => {
  global.fetch = mockFetch({
    '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD] }) }) as Response,
  });

  render(<SportsMedicinePage />);

  await screen.findByText(/Active Training Hold — sparring/);
  expect(screen.getByText(/A symptom-free week and a coach check-in/)).toBeTruthy();
  expect(screen.queryByText(/ask whoever placed the hold/)).toBeNull();
});

/* ---------------------------------------------------------------------------
   Room DNA: --locked means a child is in danger, and nothing else. (Red
   itself is not reserved, OD-2026-09-29-001.)
   ------------------------------------------------------------------------- */

test('no clearance record on file does not wear the medical red', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () => ({ ok: true, json: async () => ({ ok: true, status: null }) }) as Response,
  });

  render(<SportsMedicinePage />);

  const badge = await screen.findByText('no record');
  // Clerical gap, not a clinician's refusal. Still an action state -- one rung
  // down, never cleared.
  expect(badge.className).toContain('badge--restricted');
  expect(badge.className).not.toContain('badge--locked');
});

test('a clinician saying no keeps the medical red', async () => {
  global.fetch = mockFetch({
    '/shadow/medical-status': () =>
      ({
        ok: true,
        json: async () => ({ ok: true, status: { status: 'not_cleared', effective_at: '2026-08-01T10:00:00.000Z' } }),
      }) as Response,
  });

  render(<SportsMedicinePage />);

  const badge = await screen.findByText('not cleared');
  expect(badge.className).toContain('badge--locked');
});

test('a board that would not load is not stamped as a medical emergency', async () => {
  global.fetch = mockFetch({ '/athletes/list': () => ({ ok: false, json: async () => ({}) }) as Response });

  render(<SportsMedicinePage />);

  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  // Law 3: the glyph and the uppercase label carry it, not the colour.
  expect(within(alert).getByText('Attention')).toBeTruthy();
  expect(screen.getByText(/Unable to load your roster/)).toBeTruthy();
});

/* ---------------------------------------------------------------------------
   Room DNA: the clinic is a room, and this page stands in it.
   ------------------------------------------------------------------------- */

test('the flagship does not paint the Night room over its own wall', async () => {
  global.fetch = mockFetch();

  const { container } = render(<SportsMedicinePage />);
  await screen.findByText('Jordan Doe');

  // This page's content is a CHILD of RoleStandaloneView's .room--clinic
  // element, and nothing on a child is outranked by its ancestor: a
  // full-viewport `bg-[var(--hide-950)]` here painted night ink over the
  // cabinetry AND over the plate layer (.room::after sits at z-index:-1),
  // so the clinic's flagship rendered as the Night room with a green tint.
  // Nothing about that is visible from a unit test, which is exactly why it
  // survived two PRs -- so the class itself is what gets held.
  expect(container.querySelector('[class*="hide-950"]')).toBeNull();
});

test("the masthead stands on the room's own furniture", async () => {
  global.fetch = mockFetch();

  const { container } = render(<SportsMedicinePage />);

  // Feel line: varnished cabinetry, cooler green light. Both were declared in
  // the design system and used by nothing -- nine clinic surfaces, 29 panels,
  // every one of them the same leather every other room is made of.
  const heading = await screen.findByRole('heading', { name: 'Clearance Board' });
  expect(heading.className).toContain('t-gothic');
  expect(container.querySelector('.mat-wood')).toBeTruthy();
  expect(container.querySelector('.lamp.lamp--green')).toBeTruthy();
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

// The rung list offers only what the platform enforces. conditioning_only
// stays display-vocabulary for historical rows, but a coach must not be able
// to promise a pause that nothing stops -- the server refuses it too
// (training-holds route, OPERATIONAL_TRAINING_HOLD_SCOPES).
test('the "What stops" select offers only enforced rungs -- conditioning_only is not among them', async () => {
  mockWriteFetch({ holdsBefore: [], holdsAfter: [] });

  render(<SportsMedicinePage />);
  await openPlaceForm();

  const select = screen.getByLabelText('What stops') as HTMLSelectElement;
  const offered = Array.from(select.options).map((option) => option.value);
  expect(offered).toEqual(['all_training', 'contact_only']);
});

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
  // Brass, never the bare .stamp: --stamp-red is the same ink as --locked, and
  // RefusalStamp's locked art policy gives red to MEDICALLY_NOT_ALLOWED alone.
  // A write the server bounced is not a medical refusal.
  expect(stamp.className).toContain('stamp--brass');
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

  const stamp = await screen.findByText('Hold Not Placed');
  // A client-side required-field message is the furthest thing from a medical
  // fact, and it was carrying the room's medical red.
  expect(stamp.className).toContain('stamp--brass');
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

/* ---------------------------------------------------------------------------
   A board nobody could read is not an empty board.
   ------------------------------------------------------------------------- */

/*
 * This screen answers one question -- "who is medically cleared" -- and its
 * empty state answers it with "No athletes on your roster", which on this page
 * a coach reads as "nothing to check, everyone may train". A whole-board read
 * failure used to render exactly that sentence. The per-row failure was
 * already fail-closed (the 'unavailable' badge two tests above); only the
 * failure that takes out the whole board escaped, and it escaped into the most
 * reassuring sentence on the page.
 */
describe('a clearance board nobody could read never reads as a clear roster', () => {
  test('a roster the server refused says the board could not be read, and does not say the roster is empty', async () => {
    global.fetch = mockFetch({ '/athletes/list': () => ({ ok: false, json: async () => ({}) }) as Response });

    render(<SportsMedicinePage />);

    expect(await screen.findByText('The clearance board could not be read')).toBeTruthy();
    // This half is the defect itself. A page that adds the honest banner and
    // keeps the reassuring sentence underneath has fixed nothing -- the coach
    // still reads "no athletes to check" and walks onto the floor.
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a roster read that throws is treated the same as one the server refused', async () => {
    // A dropped connection reaches this page as a rejection rather than a
    // status, and lands in the same catch. A coach must not learn a different
    // fact from a dead network than from a 503.
    global.fetch = mockFetch({
      '/athletes/list': () => Promise.reject(new Error('Network request failed')),
    });

    render(<SportsMedicinePage />);

    expect(await screen.findByText('The clearance board could not be read')).toBeTruthy();
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a coach who genuinely has nobody is told that, and is not told a read failed', async () => {
    // The other direction, and it is not decoration: without it the tests
    // above pass just as well against a board that claims failure every time
    // it loads, which teaches a coach to read past the one banner that means
    // something.
    global.fetch = mockFetch({ '/athletes/list': () => ({ ok: true, json: async () => ({ items: [] }) }) as Response });

    render(<SportsMedicinePage />);

    expect(await screen.findByText('No athletes on your roster')).toBeTruthy();
    expect(screen.queryByText('The clearance board could not be read')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
   A hold nobody could read is not "no hold".
   ------------------------------------------------------------------------- */

/*
 * The clearance half of each row was already three-valued (cleared / no record
 * / unavailable). The hold half was two-valued: a failed hold read collapsed to
 * null, and null is the row a child with no hold gets -- name, clearance badge,
 * and a "Place a training hold" button, with nothing saying nobody could look.
 * A coach reading that row before contact work concludes the child is not held.
 */
describe('a hold nobody could read never reads as "no hold"', () => {
  const UNREAD = /Training hold could not be read/;

  function holdRow(): HTMLElement {
    return screen.getByText('Jordan Doe').closest('li') as HTMLElement;
  }

  // Owner decision 2026-10-01 (Jason, "3 B"): on an unread hold the place
  // control is disabled -- present, with its reason beside it, not hidden.
  function expectPlaceDisabledWithReason() {
    const place = within(holdRow()).getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    const reason = document.getElementById(place.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toMatch(/Training hold could not be read/);
    expect(reason?.textContent).toMatch(/cannot be placed from this row until it has been read/);
    // Disabled means disabled: a click opens no form.
    fireEvent.click(place);
    expect(screen.queryByLabelText(/What this athlete reads/)).toBeNull();
  }

  test('a hold read the server refused says the hold is unknown on that row', async () => {
    // The refused body is a well-formed "no holds": it is the STATUS that says
    // nobody looked, and the status has to be what the page believes.
    global.fetch = mockFetch({
      '/training-holds': () => ({ ok: false, status: 503, json: async () => ({ ok: true, holds: [] }) }) as Response,
    });

    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');

    expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
    expect(within(holdRow()).getByText(/Unknown is not “no hold”/)).toBeTruthy();
    expectPlaceDisabledWithReason();
    // And it still does not claim a hold it could not read.
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
    // The clearance that WAS read is still shown: one failed read does not
    // take the other off the row.
    expect(within(holdRow()).getByText('cleared')).toBeTruthy();
  });

  test('a hold read that throws is treated the same as one the server refused', async () => {
    global.fetch = mockFetch({ '/training-holds': () => Promise.reject(new Error('Network request failed')) });

    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');

    expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
    expectPlaceDisabledWithReason();
  });

  test('a hold read whose body will not parse is unknown too', async () => {
    global.fetch = mockFetch({
      '/training-holds': () =>
        ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response,
    });

    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');

    expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
    expectPlaceDisabledWithReason();
  });

  test('a clearance read that throws does not take a hold that was read off the row', async () => {
    global.fetch = mockFetch({
      '/shadow/medical-status': () => Promise.reject(new Error('Network request failed')),
      '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD] }) }) as Response,
    });

    render(<SportsMedicinePage />);

    await screen.findByText(/Active Training Hold — sparring/);
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  test('a clearance body that will not parse does not take a hold that was read off the row', async () => {
    global.fetch = mockFetch({
      '/shadow/medical-status': () =>
        ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response,
      '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD] }) }) as Response,
    });

    render(<SportsMedicinePage />);

    await screen.findByText(/Active Training Hold — sparring/);
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  test('a 200 that carries no `holds` list is unknown, not "no hold"', async () => {
    // The route always sends a `holds` array to staff. An empty object, an
    // error body or a different shape served with 200 says nothing about holds
    // -- and one of these bodies is carrying a real hold under another key.
    for (const body of [{}, { error: 'upstream' }, { ok: true, hold: HOLD }, { holds: null }, { holds: { 0: HOLD } }]) {
      global.fetch = mockFetch({ '/training-holds': () => ({ ok: true, json: async () => body }) as Response });

      const { unmount } = render(<SportsMedicinePage />);
      await screen.findByText('Jordan Doe');

      expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
      expectPlaceDisabledWithReason();
      unmount();
    }
  });

  test('an EMPTY list is the only list that means no hold: an entry that is not a hold is unknown', async () => {
    // `[null]` and `[false]` used to read as "no hold" (first entry falsy);
    // `[{}]` used to render a hold with no sentence and no way to lift it.
    const entries: unknown[] = [
      null,
      false,
      {},
      'hold',
      { ...HOLD, hold_id: undefined },
      { ...HOLD, hold_id: '' },
      { ...HOLD, scope: undefined },
      { ...HOLD, scope: '' },
      { ...HOLD, scope: ' ' },
      { ...HOLD, athlete_explanation: '   ' },
      { ...HOLD, athlete_explanation: 7 },
      { ...HOLD, lift_condition_text: null },
    ];
    for (const entry of entries) {
      global.fetch = mockFetch({
        '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [entry] }) }) as Response,
      });

      const { unmount } = render(<SportsMedicinePage />);
      await screen.findByText('Jordan Doe');

      expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
      expect(screen.queryByText(/Active Training Hold/)).toBeNull();
      expectPlaceDisabledWithReason();
      unmount();
    }
    // And a real hold behind a malformed one is not shown as a clean read.
    global.fetch = mockFetch({
      '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [HOLD, null] }) }) as Response,
    });
    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');
    expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
  });

  test('an athlete who genuinely has no hold is not told a read failed', async () => {
    // The other direction: a board that says "could not be read" on every row
    // teaches a coach to read past the one line that means something.
    global.fetch = mockFetch();

    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');
    const place = (await screen.findByRole('button', { name: 'Place a training hold' })) as HTMLButtonElement;

    expect(screen.queryByText(UNREAD)).toBeNull();
    expect(place.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  test('a placed hold whose response and re-read both carry nothing is unknown, not "no hold"', async () => {
    // The write committed. The POST body came back unparseable and the re-read
    // failed, so the board has nothing it can show -- and "no hold" is the one
    // thing it knows to be false.
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return { ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON'); } } as unknown as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await openPlaceForm();
    expect(screen.queryByText(UNREAD)).toBeNull();

    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    expect(await screen.findByText(UNREAD)).toBeTruthy();
    expectPlaceDisabledWithReason();
  });

  /** First `failures` hold reads are refused; every read after returns `then`. */
  function mockRecheckFetch(failures: number, then: Array<Record<string, unknown>>) {
    let holdReads = 0;
    const posted: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ ok: true, hold: PLACED }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads <= failures) return { ok: false, status: 503, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ ok: true, holds: then }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    return { posted, holdReads: () => holdReads };
  }

  test('after a successful re-read that finds no hold, the place control is enabled again and works', async () => {
    const harness = mockRecheckFetch(1, []);

    render(<SportsMedicinePage />);
    await screen.findByText(UNREAD);
    expectPlaceDisabledWithReason();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(screen.queryByText(UNREAD)).toBeNull());
    expect(harness.holdReads()).toBe(2);
    const place = screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement;
    expect(place.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();

    fireEvent.click(place);
    expect(await screen.findByLabelText(/What this athlete reads/)).toBeTruthy();
  });

  test('after a successful re-read that finds a hold, the row shows the hold', async () => {
    mockRecheckFetch(1, [HOLD]);

    render(<SportsMedicinePage />);
    await screen.findByText(UNREAD);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    await screen.findByText(/Active Training Hold — sparring/);
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  test('a re-read that fails again leaves the hold unknown and the place control disabled', async () => {
    const harness = mockRecheckFetch(2, []);

    render(<SportsMedicinePage />);
    await screen.findByText(UNREAD);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(harness.holdReads()).toBe(2));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
    expectPlaceDisabledWithReason();
    expect(harness.posted).toHaveLength(0);
  });
});

/*
 * After a write, the two directions are not symmetric, and each is pinned.
 */
describe('what the board says when the re-read after a write does not agree', () => {
  const UNREAD = /Training hold could not be read/;

  test('a hold the server just confirmed, then a re-read that says there is none: unknown, not "no hold"', async () => {
    // One of the two is stale. Believing the read shows a held child as free.
    mockWriteFetch({ holdsBefore: [], holdsAfter: [] });

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: PLACED.athlete_explanation } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    expect(await screen.findByText(UNREAD)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a hold the server just confirmed, then a re-read that fails: the confirmed hold is shown', async () => {
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true, hold: PLACED }) } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        return Promise.reject(new Error('Network request failed'));
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: PLACED.athlete_explanation } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    await screen.findByText(/Active Training Hold — contact only/);
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  test('a lift the server confirmed, then a re-read that fails: no hold, and the place control is live', async () => {
    // One active hold per athlete, and the server has just said this one is
    // lifted: "no hold" is the committed outcome, not a guess.
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, hold: { ...HOLD, status: 'lifted' } }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [HOLD] }) } as Response;
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());
    expect(screen.queryByText(UNREAD)).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/*
 * Two rows. Every test above has one athlete, and one athlete cannot show a
 * button on one row being re-enabled by something finishing on another.
 */
describe('one row finishing does not release another row that is still out', () => {
  const SECOND = { athlete_id: 'ath-2', full_name: 'Riley Poe' };

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('li') as HTMLElement;
  }

  test('a lift in flight on one row stays disabled while a re-check on another row completes', async () => {
    let releaseLift: (() => void) | undefined;
    const liftHeld = new Promise<Response>((resolve) => {
      releaseLift = () => resolve({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, status: 'lifted' } }) } as Response);
    });
    const posts: string[] = [];
    let secondReads = 0;
    let firstLifted = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(String(init.body));
        const response = await liftHeld;
        firstLifted = true;
        return response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, SECOND] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('athlete_id=ath-2')) {
        secondReads += 1;
        if (secondReads === 1) return { ok: false, status: 503, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      }
      if (url.includes('/training-holds')) {
        return { ok: true, json: async () => ({ ok: true, holds: firstLifted ? [] : [HOLD] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);

    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Lift this hold' }));
    const lifting = (await within(rowOf('Jordan Doe')).findByRole('button', { name: 'Lifting…' })) as HTMLButtonElement;
    expect(lifting.disabled).toBe(true);

    fireEvent.click(within(rowOf('Riley Poe')).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(
        (within(rowOf('Riley Poe')).getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    // The other row finished. This one is still out, and still locked.
    const stillLifting = within(rowOf('Jordan Doe')).getByRole('button', { name: 'Lifting…' }) as HTMLButtonElement;
    expect(stillLifting.disabled).toBe(true);
    fireEvent.click(stillLifting);
    expect(posts).toHaveLength(1);

    releaseLift?.();
    await waitFor(() => expect(within(rowOf('Jordan Doe')).queryByText(/Active Training Hold/)).toBeNull());
    expect(posts).toHaveLength(1);
  });

  test('"Check again" is locked while its own read is out', async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const held = new Promise<Response>((resolve) => {
      release = () => resolve({ ok: true, json: async () => ({ ok: true, holds: [] }) } as Response);
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        reads += 1;
        if (reads === 1) return { ok: false, status: 503, json: async () => ({}) } as Response;
        return held;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

    const checking = (await screen.findByRole('button', { name: 'Checking…' })) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);
    fireEvent.click(checking);
    expect(reads).toBe(2);

    release?.();
    await waitFor(() => expect(screen.queryByText(/Training hold could not be read/)).toBeNull());
    expect(reads).toBe(2);
  });
});

describe('a refused placement is news about the row', () => {
  test('"already exists" makes the board read the hold it did not know about', async () => {
    // Loaded with no hold; someone else placed one since. The server refuses
    // the second, and the row must stop saying "no hold".
    const harness = mockWriteFetch({
      holdsBefore: [],
      holdsAfter: [HOLD],
      post: () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Hold already exists: hold-7 is active for this athlete -- lift it first' }),
        }) as Response,
    });

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    await screen.findByText(/Active Training Hold — sparring/);
    expect(screen.getByText('Hold Not Placed')).toBeTruthy();
    expect(screen.getByText(/lift it first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Place a training hold' })).toBeNull();
    expect(harness.holdReads()).toBe(2);
  });

  test('a refusal whose re-read FAILS leaves the hold unknown: the form closes, the place control is disabled, the refusal stays', async () => {
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'Scope not supported.' }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    // The server has just contradicted the board (it may be saying "Hold
    // already exists") and the board could not look again. Its last
    // successful read -- "no hold" -- is not something to keep showing.
    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    await screen.findByText('Hold Not Placed');
    expect(screen.getByText('Scope not supported.')).toBeTruthy();
    expect(await screen.findByText(/Training hold could not be read/)).toBeTruthy();
    expect(holdReads).toBe(2);
    // The form is gone, and the only way forward is a read that succeeds.
    expect(screen.queryByLabelText(/What this athlete reads/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Place hold' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByText('Hold Not Placed')).toBeTruthy();
  });

  test('after that, a "Check again" that finds no hold gives back the place control, not the old form by itself', async () => {
    // The form was CLOSED, not merely hidden behind the unknown state: a form
    // that pops back open with a sentence nobody is looking at is one click
    // from a hold nobody meant to place.
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'Scope not supported.' }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 2) return { ok: false, status: 503, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await screen.findByText(/Training hold could not be read/);

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(screen.queryByText(/Training hold could not be read/)).toBeNull());
    expect(screen.queryByLabelText(/What this athlete reads/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a placement whose response carries something that is not a hold, and whose re-read fails, is unknown', async () => {
    // The POST said ok and handed back `{}` under `hold`. That is not a hold
    // to paint on the board.
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true, hold: {} }) } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    expect(await screen.findByText(/Training hold could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
  });

  test('a refusal whose re-read finds no hold keeps the form open with what was typed', async () => {
    // The other direction: an ordinary refusal with a board that CAN look
    // again must not cost the coach their sentence.
    const harness = mockWriteFetch({
      holdsBefore: [],
      holdsAfter: [],
      post: () => ({ ok: false, status: 400, json: async () => ({ error: 'Scope not supported.' }) }) as Response,
    });

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    await screen.findByText('Hold Not Placed');
    await waitFor(() => expect(harness.holdReads()).toBe(2));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Place hold' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/Training hold could not be read/)).toBeNull();
    expect((screen.getByLabelText(/What this athlete reads/) as HTMLTextAreaElement).value).toBe('Resting your wrist.');
  });

});
