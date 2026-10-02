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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  athlete_id: 'ath-1',
  status: 'cleared',
  effective_at: '2026-08-01T10:00:00.000Z',
  // Fields the surface must never display, present in the payload on purpose
  // so the tests can pin their absence from the DOM.
  restriction_flags: { no_sparring: true },
  source_reference: 'physician-note-123',
};

// A staff read returns whole rows: this athlete's, active.
const HOLD = {
  hold_id: 'hold-7',
  athlete_id: 'ath-1',
  status: 'active',
  scope: 'sparring',
  athlete_explanation: 'Taking a week off contact while your headache settles.',
  lift_condition_text: 'A symptom-free week and a coach check-in.',
};

// The route requires the athlete's sentence and does NOT require a lift
// condition, so this row is a real shape the board has to render, not a
// hypothetical one.
const HOLD_NO_LIFT = {
  hold_id: 'hold-11',
  athlete_id: 'ath-1',
  status: 'active',
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
      return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
    '/shadow/medical-status': () => ({ ok: true, json: async () => ({ ok: true, status: null, effectiveStatus: 'no_record' }) }) as Response,
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
    '/shadow/medical-status': () => ({ ok: true, json: async () => ({ ok: true, status: null, effectiveStatus: 'no_record' }) }) as Response,
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
        json: async () => ({ ok: true, status: { status: 'not_cleared', athlete_id: 'ath-1', effective_at: '2026-08-01T10:00:00.000Z' }, effectiveStatus: 'not_cleared' }),
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

// The route answers a place with the whole row: this athlete's, active.
const PLACED = {
  hold_id: 'hold-9',
  athlete_id: 'ath-1',
  status: 'active',
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
      return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
    post: () => ({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, athlete_id: 'ath-1', status: 'lifted' } }) }) as Response,
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
    holdsAfter: [HOLD],
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
    for (const body of [
      {},
      { error: 'upstream' },
      { ok: true, hold: HOLD },
      { ok: true, holds: null },
      { ok: true, holds: { 0: HOLD } },
      // A well-formed "no holds" that does not say ok is not a read.
      { ok: false, holds: [] },
      { holds: [] },
      { ok: 'true', holds: [] },
      { ok: false, holds: [HOLD] },
    ]) {
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
      // A whole, well-formed hold that is not the answer to "this athlete's
      // active hold": someone else's, lifted, or not saying.
      { ...HOLD, athlete_id: 'ath-b', athlete_explanation: 'A SENTENCE WRITTEN FOR ANOTHER CHILD.' },
      { ...HOLD, athlete_id: undefined },
      { ...HOLD, status: 'lifted' },
      { ...HOLD, status: 'expired' },
      { ...HOLD, status: undefined },
    ];
    for (const entry of entries) {
      global.fetch = mockFetch({
        '/training-holds': () => ({ ok: true, json: async () => ({ ok: true, holds: [entry] }) }) as Response,
      });

      const { unmount } = render(<SportsMedicinePage />);
      await screen.findByText('Jordan Doe');

      expect(within(holdRow()).getByText(UNREAD)).toBeTruthy();
      expect(screen.queryByText(/Active Training Hold/)).toBeNull();
      expect(screen.queryByText(/A SENTENCE WRITTEN FOR ANOTHER CHILD/)).toBeNull();
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, hold: { ...HOLD, athlete_id: 'ath-1', status: 'lifted' } }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
      releaseLift = () => resolve({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, athlete_id: 'ath-1', status: 'lifted' } }) } as Response);
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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

/*
 * A 2xx is not a confirmation. "No hold" after a lift whose re-read failed is
 * only safe because the server CONFIRMED the lift -- so the confirmation has
 * to be one: ok, this hold, lifted.
 */
describe('a lift the server did not actually confirm never becomes "no hold" without a read', () => {
  const UNREAD = /Training hold could not be read/;
  const LIFTED = { ...HOLD, athlete_id: 'ath-1', status: 'lifted' };

  function liftBoard(post: () => Response, rereadHolds: 'fail' | Array<Record<string, unknown>>) {
    let holdReads = 0;
    const posted: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return post();
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [HOLD] }) } as Response;
        if (rereadHolds === 'fail') return { ok: false, status: 503, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ ok: true, holds: rereadHolds }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    return { posted, holdReads: () => holdReads };
  }

  const NOT_A_CONFIRMATION: Array<[string, () => Response]> = [
    ['a body that will not parse', () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response],
    ['an empty object', () => ({ ok: true, json: async () => ({}) }) as Response],
    ['ok:false with a lifted hold', () => ({ ok: true, json: async () => ({ ok: false, hold: LIFTED }) }) as Response],
    ['ok:true with no hold', () => ({ ok: true, json: async () => ({ ok: true }) }) as Response],
    ['ok:true with a hold that is still active', () => ({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, status: 'active' } }) }) as Response],
    ['ok:true with a hold that has no status', () => ({ ok: true, json: async () => ({ ok: true, hold: HOLD }) }) as Response],
    ['ok:true with a DIFFERENT hold lifted', () => ({ ok: true, json: async () => ({ ok: true, hold: { ...LIFTED, hold_id: 'hold-other' } }) }) as Response],
    ['ok:true with another athlete’s hold lifted', () => ({ ok: true, json: async () => ({ ok: true, hold: { ...LIFTED, athlete_id: 'ath-other' } }) }) as Response],
    ['ok:true with a lifted hold that names no athlete', () => ({ ok: true, json: async () => ({ ok: true, hold: { ...HOLD, athlete_id: undefined, status: 'lifted' } }) }) as Response],
    ['ok:true with a malformed hold', () => ({ ok: true, json: async () => ({ ok: true, hold: { status: 'lifted' } }) }) as Response],
  ];

  test.each(NOT_A_CONFIRMATION)('%s, then a re-read that fails: the hold stays on screen and the coach is told', async (_name, post) => {
    const harness = liftBoard(post, 'fail');

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText('Hold Not Lifted');
    expect(screen.getByText(/did not confirm this lift/)).toBeTruthy();
    expect(harness.holdReads()).toBe(2);
    // Still held on screen; no live place control, no "could not be read".
    expect(screen.getByText(/Active Training Hold — sparring/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Place a training hold' })).toBeNull();
    expect(screen.queryByText(UNREAD)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Lift this hold' }) as HTMLButtonElement).disabled).toBe(false));
  });

  test('truthy is not true: ok:1 or ok:"true" on a lift is not a confirmation', async () => {
    for (const ok of [1, 'true']) {
      liftBoard(() => ({ ok: true, json: async () => ({ ok, hold: LIFTED }) }) as Response, 'fail');

      const { unmount } = render(<SportsMedicinePage />);
      await screen.findByText(/Active Training Hold — sparring/);
      fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

      await screen.findByText('Hold Not Lifted');
      expect(screen.getByText(/Active Training Hold — sparring/)).toBeTruthy();
      unmount();
    }
  });

  test('an unconfirmed lift keeps the lift note the coach wrote', async () => {
    liftBoard(() => ({ ok: true, json: async () => ({}) }) as Response, 'fail');

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.change(screen.getByLabelText(/Lift note/), { target: { value: 'Symptom-free week.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText('Hold Not Lifted');
    expect((screen.getByLabelText(/Lift note/) as HTMLInputElement).value).toBe('Symptom-free week.');
  });

  test('a CONFIRMED lift still re-reads: a new hold placed meanwhile is shown, not "no hold"', async () => {
    const NEWER = { ...HOLD, hold_id: 'hold-newer', scope: 'all_training', athlete_explanation: 'A newer hold.' };
    const harness = liftBoard(() => ({ ok: true, json: async () => ({ ok: true, hold: LIFTED }) }) as Response, [NEWER]);

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText(/Active Training Hold — all training/);
    expect(screen.getByText('A newer hold.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Place a training hold' })).toBeNull();
    expect(harness.holdReads()).toBe(2);
  });

  test('an unconfirmed lift whose re-read finds a DIFFERENT hold says so, and shows that hold', async () => {
    const OTHER = { ...HOLD, hold_id: 'hold-other', scope: 'all_training', athlete_explanation: 'A different hold.' };
    liftBoard(() => ({ ok: true, json: async () => ({}) }) as Response, [OTHER]);

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText(/a different hold is now active for this athlete/);
    expect(screen.getByText('A different hold.')).toBeTruthy();
    expect(screen.queryByText(/The hold is still shown/)).toBeNull();
  });

  test('a lift the server REFUSES re-reads the row: "already lifted" does not leave a lifted hold on screen', async () => {
    // The lift went through earlier and nobody heard. The retry is refused
    // with "hold is 'lifted' and cannot be lifted" -- and the row used to keep
    // showing it as active, with no place control, until a page reload.
    const harness = liftBoard(
      () => ({ ok: false, status: 400, json: async () => ({ error: "Unsupported transition: hold is 'lifted' and cannot be lifted" }) }) as Response,
      [],
    );

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());
    expect(harness.holdReads()).toBe(2);
    expect(screen.getByText(/cannot be lifted/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a lift the server refuses, with a re-read that fails, keeps the hold on screen', async () => {
    liftBoard(
      () => ({ ok: false, status: 400, json: async () => ({ error: 'Not allowed.' }) }) as Response,
      'fail',
    );

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText('Not allowed.');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Lift this hold' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Active Training Hold — sparring/)).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });

  test('not a confirmation, but the re-read finds no hold: the READ says no hold, and that is shown', async () => {
    liftBoard(() => ({ ok: true, json: async () => ({}) }) as Response, []);

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());
    expect(screen.queryByText('Hold Not Lifted')).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('not a confirmation, and the re-read still finds the hold: held, and the coach is told', async () => {
    liftBoard(() => ({ ok: true, json: async () => ({ ok: true }) }) as Response, [HOLD]);

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await screen.findByText('Hold Not Lifted');
    expect(screen.getByText(/Active Training Hold — sparring/)).toBeTruthy();
  });

  test('a genuine confirmation with the athlete named, then a failed re-read: no hold', async () => {
    liftBoard(() => ({ ok: true, json: async () => ({ ok: true, hold: LIFTED }) }) as Response, 'fail');

    render(<SportsMedicinePage />);
    await screen.findByText(/Active Training Hold — sparring/);
    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));

    await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());
    expect(screen.queryByText('Hold Not Lifted')).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a placement answered with an ok that is not exactly true is not a confirmed hold either', async () => {
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: 1, hold: PLACED }) } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
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
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: PLACED.athlete_explanation } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));

    expect(await screen.findByText(UNREAD)).toBeTruthy();
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
  });
});

/*
 * A lapsed clearance is still STORED as 'cleared' -- the record of who cleared
 * this athlete must not vanish -- and the route says so beside it:
 * effectiveStatus 'cleared_expired', which is what the gates act on. This board
 * printed the stored word, so a coach scanning the roster before contact work
 * read a green "cleared" for a child the gate would refuse. Words, rung and
 * date: OD-2026-10-01-007 section 4.
 */
describe('a lapsed clearance beside a current one', () => {
  const LAPSED_SENTENCE = 'This clearance passed its end date, so it no longer counts. The medical gate blocks recommendations until a new clearance is recorded.';
  const CURRENT = { athlete_id: 'ath-1', full_name: 'Jordan Doe' };
  const LAPSED = { athlete_id: 'ath-2', full_name: 'Sam Roe' };
  const LAPSED_STATUS = {
    ...CLEARED_STATUS,
    status_id: 'status-2',
    athlete_id: 'ath-2',
    effective_at: '2026-06-01T16:00:00.000Z',
    // As the route sends it: `expires_at::text`, Postgres text, not ISO.
    expires_at: '2026-09-01 16:00:00+00',
  };
  // A clearance still in force that HAS an end date, in the future.
  const CURRENT_STATUS = { ...CLEARED_STATUS, expires_at: '2099-01-01 16:00:00+00' };

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('li') as HTMLElement;
  }

  function installRoster(lapsedBody: unknown) {
    global.fetch = mockFetch({
      '/athletes/list': () => ({ ok: true, json: async () => ({ items: [CURRENT, LAPSED] }) }) as Response,
      'medical-status?athleteId=ath-1': () =>
        ({ ok: true, json: async () => ({ ok: true, status: CURRENT_STATUS, effectiveStatus: 'cleared' }) }) as Response,
      'medical-status?athleteId=ath-2': () => ({ ok: true, json: async () => lapsedBody }) as Response,
    });
  }

  test('the current one reads "cleared since"; the lapsed one reads "clearance expired", amber, with its end date and the sentence', async () => {
    installRoster({ ok: true, status: LAPSED_STATUS, effectiveStatus: 'cleared_expired' });

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Roe');

    const current = within(rowOf('Jordan Doe'));
    expect(current.getByText('cleared').className).toContain('badge--cleared');
    expect(current.getByText('since 8/1/2026')).toBeTruthy();
    expect(current.queryByText('clearance expired')).toBeNull();
    expect(current.queryByText(LAPSED_SENTENCE)).toBeNull();
    expect(current.queryByText(/expired/)).toBeNull();

    const lapsed = within(rowOf('Sam Roe'));
    const badge = lapsed.getByText('clearance expired');
    expect(badge.className).toContain('badge--restricted');
    expect(badge.className).not.toContain('badge--cleared');
    expect(badge.className).not.toContain('badge--locked');
    expect(lapsed.getByText(LAPSED_SENTENCE)).toBeTruthy();
    expect(lapsed.getByText('expired 9/1/2026')).toBeTruthy();
    // Neither the stored word, nor the raw enum, nor the date it was cleared
    // "since" is on the lapsed row.
    expect(lapsed.queryByText('cleared')).toBeNull();
    expect(lapsed.queryByText('cleared_expired')).toBeNull();
    expect(lapsed.queryByText(/since/)).toBeNull();
    expect(rowOf('Sam Roe').querySelector('.badge--cleared')).toBeNull();
    expect(lapsed.queryByText('unavailable')).toBeNull();
    // Still no clinical detail on the surface.
    expect(screen.queryByText(/physician-note-123/)).toBeNull();
  });

  test('the end date is read on a browser whose Date takes only ISO 8601, from the text form the database sends', async () => {
    const RealDate = Date;
    const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
    class IsoOnlyDate extends RealDate {
      constructor(...args: unknown[]) {
        const refused = args.length === 1 && typeof args[0] === 'string' && !ISO.test(args[0]);
        super(...((refused ? [Number.NaN] : args) as [number]));
      }
    }
    // The stand-in refuses what it should and reads what it should.
    expect(Number.isNaN(new IsoOnlyDate(LAPSED_STATUS.expires_at).getTime())).toBe(true);
    expect(Number.isNaN(new IsoOnlyDate('2026-09-01T16:00:00+00:00').getTime())).toBe(false);

    global.Date = IsoOnlyDate as unknown as DateConstructor;
    try {
      installRoster({ ok: true, status: LAPSED_STATUS, effectiveStatus: 'cleared_expired' });

      render(<SportsMedicinePage />);
      await screen.findByText('Sam Roe');

      expect(within(rowOf('Sam Roe')).getByText('expired 9/1/2026')).toBeTruthy();
      expect(within(rowOf('Jordan Doe')).getByText('since 8/1/2026')).toBeTruthy();
    } finally {
      global.Date = RealDate;
    }
  });

  test.each([
    ['2026-09-01 16:00:00.123456+00', '9/1/2026'],
    ['2026-09-02 03:30:00+00', '9/1/2026'],
    ['2026-09-01 16:00:00-04', '9/1/2026'],
    ['2026-09-01T16:00:00.000Z', '9/1/2026'],
    ['2026-09-01T16:00:00+00:00', '9/1/2026'],
  ])('an end date sent as %s prints as the gym\'s day, %s', async (expiresAt, day) => {
    installRoster({ ok: true, status: { ...LAPSED_STATUS, expires_at: expiresAt }, effectiveStatus: 'cleared_expired' });

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Roe');

    expect(within(rowOf('Sam Roe')).getByText(`expired ${day}`)).toBeTruthy();
  });

  test.each([
    ['no end date in the row', undefined],
    ['an end date that is not a date', 'not-a-date'],
    ['an end date that is not a string', 20260901],
  ])('lapsed with %s: still "clearance expired", with no date printed and never "since"', async (_name, expiresAt) => {
    installRoster({ ok: true, status: { ...LAPSED_STATUS, expires_at: expiresAt }, effectiveStatus: 'cleared_expired' });

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Roe');

    const lapsed = within(rowOf('Sam Roe'));
    expect(lapsed.getByText('clearance expired')).toBeTruthy();
    expect(lapsed.getByText(LAPSED_SENTENCE)).toBeTruthy();
    expect(lapsed.queryByText(/^expired/)).toBeNull();
    expect(lapsed.queryByText(/since/)).toBeNull();
    expect(lapsed.queryByText('cleared')).toBeNull();
  });

  test.each(['restricted', 'not_cleared', 'pending'])('a stored "%s" is printed when effectiveStatus agrees with it', async (stored) => {
    installRoster({ ok: true, status: { ...LAPSED_STATUS, status: stored }, effectiveStatus: stored });

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Roe');

    const row = within(rowOf('Sam Roe'));
    expect(row.getByText(stored.replace('_', ' '))).toBeTruthy();
    expect(row.queryByText('clearance expired')).toBeNull();
    expect(row.queryByText('unavailable')).toBeNull();
    expect(rowOf('Sam Roe').querySelector('.badge--cleared')).toBeNull();
  });

  // The board is read once, when it opens. A clearance that was in force then
  // and runs out an hour later went on reading "cleared" until somebody
  // reloaded: the same mismatch with the gate, arrived at by waiting. A row
  // whose clearance has an end date is now read again when that date arrives,
  // and shows what the route answers.
  describe('a clearance that runs out while the board is open', () => {
    const NOW = Date.parse('2026-09-01T15:59:30.000Z');
    // Thirty seconds after NOW, as the route sends it.
    const SOON_STATUS = { ...LAPSED_STATUS, expires_at: '2026-09-01 16:00:00+00' };
    const STILL_CLEARED = { ok: true, status: SOON_STATUS, effectiveStatus: 'cleared' };
    const NOW_LAPSED = { ok: true, status: SOON_STATUS, effectiveStatus: 'cleared_expired' };
    const asResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

    let answer: () => Response | Promise<Response>;
    let reads: { current: number; lapsing: number };

    function installOpenBoard(first: unknown) {
      reads = { current: 0, lapsing: 0 };
      answer = () => asResponse(first);
      global.fetch = mockFetch({
        '/athletes/list': () => asResponse({ items: [CURRENT, LAPSED] }),
        // In force until 2099: a timer that must wait, a minute at a time.
        'medical-status?athleteId=ath-1': () => {
          reads.current += 1;
          return asResponse({ ok: true, status: CURRENT_STATUS, effectiveStatus: 'cleared' });
        },
        'medical-status?athleteId=ath-2': () => {
          reads.lapsing += 1;
          return answer();
        },
      });
    }

    async function pass(ms: number) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    }

    async function openBoard(first: unknown = STILL_CLEARED) {
      installOpenBoard(first);
      const view = render(<SportsMedicinePage />);
      await screen.findByText('Sam Roe');
      return view;
    }

    function expectStillCleared() {
      const row = within(rowOf('Sam Roe'));
      expect(row.getByText('cleared').className).toContain('badge--cleared');
      expect(row.getByText('since 6/1/2026')).toBeTruthy();
      expect(row.queryByText('clearance expired')).toBeNull();
    }

    function expectLapsed() {
      const row = within(rowOf('Sam Roe'));
      expect(row.getByText('clearance expired').className).toContain('badge--restricted');
      expect(row.getByText(LAPSED_SENTENCE)).toBeTruthy();
      expect(row.getByText('expired 9/1/2026')).toBeTruthy();
      expect(row.queryByText('cleared')).toBeNull();
      expect(row.queryByText(/since/)).toBeNull();
      expect(rowOf('Sam Roe').querySelector('.badge--cleared')).toBeNull();
    }

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('with nothing pressed: green "cleared" until the end date, then "clearance expired", the sentence and "expired <date>"', async () => {
      await openBoard();
      expectStillCleared();
      expect(reads.lapsing).toBe(1);

      // Not before the end date: nothing is asked and nothing changes.
      await pass(25_000);
      expect(reads.lapsing).toBe(1);
      expectStillCleared();

      answer = () => asResponse(NOW_LAPSED);
      await pass(6_000);

      expect(reads.lapsing).toBe(2);
      expectLapsed();
      // The other athlete's row is not touched, and is not asked about.
      expect(within(rowOf('Jordan Doe')).getByText('cleared').className).toContain('badge--cleared');
      expect(within(rowOf('Jordan Doe')).getByText('since 8/1/2026')).toBeTruthy();
      expect(reads.current).toBe(1);

      // Once the route has said it lapsed, the row is not asked about again.
      await pass(120_000);
      expect(reads.lapsing).toBe(2);
    });

    test('the board does not decide it from the date: while the route still answers "cleared", the row stays cleared and is asked again', async () => {
      await openBoard();

      // This device's clock is ahead of the server's.
      await pass(31_000);
      expect(reads.lapsing).toBe(2);
      expectStillCleared();

      answer = () => asResponse(NOW_LAPSED);
      await pass(30_000);
      expect(reads.lapsing).toBe(3);
      expectLapsed();
    });

    test.each<[string, () => Response | Promise<Response>]>([
      ['is refused', () => ({ ok: false, json: async () => ({}) }) as Response],
      ['throws', () => Promise.reject(new Error('Network request failed'))],
      ['comes back with no effectiveStatus', () => asResponse({ ok: true, status: SOON_STATUS })],
    ])('a re-read that %s leaves the row unavailable, not cleared', async (_name, failing) => {
      await openBoard();

      answer = failing;
      await pass(31_000);

      const row = within(rowOf('Sam Roe'));
      expect(row.getByText('unavailable')).toBeTruthy();
      expect(row.getByText(/Unknown is not cleared/)).toBeTruthy();
      expect(row.queryByText('cleared')).toBeNull();
      expect(row.queryByText(/since/)).toBeNull();
      expect(rowOf('Sam Roe').querySelector('.badge--cleared')).toBeNull();
    });

    test('a clearance renewed in the meantime stays cleared, and its new end date is waited for in turn', async () => {
      await openBoard();

      const renewed = { ...SOON_STATUS, status_id: 'status-3', effective_at: '2026-09-01T15:59:45.000Z', expires_at: '2026-09-01 16:03:00+00' };
      answer = () => asResponse({ ok: true, status: renewed, effectiveStatus: 'cleared' });
      await pass(31_000);
      expect(reads.lapsing).toBe(2);
      expect(within(rowOf('Sam Roe')).getByText('cleared').className).toContain('badge--cleared');

      // Nothing more until the new end date.
      await pass(2 * 60_000);
      expect(reads.lapsing).toBe(2);

      answer = () => asResponse({ ok: true, status: renewed, effectiveStatus: 'cleared_expired' });
      await pass(60_000);
      expect(reads.lapsing).toBe(3);
      expect(within(rowOf('Sam Roe')).getByText('clearance expired')).toBeTruthy();
    });

    test('an answer that arrives after a newer one does not paint over it', async () => {
      await openBoard();

      let releaseStale: (response: Response) => void = () => {};
      answer = () => new Promise<Response>((resolve) => { releaseStale = resolve; });
      await pass(31_000);
      expect(reads.lapsing).toBe(2);
      expectStillCleared();

      answer = () => asResponse(NOW_LAPSED);
      await pass(30_000);
      expect(reads.lapsing).toBe(3);
      expectLapsed();

      // The first re-read finally answers, with what was true when it was sent.
      await act(async () => {
        releaseStale(asResponse(STILL_CLEARED));
      });
      await pass(1_000);
      expectLapsed();
    });

    test('a far end date is waited for a minute at a time, never with one long delay, and asks nothing early', async () => {
      // Every delay the page asks the (fake) clock for. A wrapper, not a
      // spy: a spy on the fake setTimeout is put back by the file's own
      // restoreAllMocks after the real clock has returned.
      const fakeSetTimeout = global.setTimeout;
      const delays: number[] = [];
      const recording = Object.assign(
        ((handler: () => void, ms?: number) => {
          delays.push(Number(ms ?? 0));
          return fakeSetTimeout(handler, ms);
        }) as unknown as typeof setTimeout,
        fakeSetTimeout,
      );
      global.setTimeout = recording;
      try {
        await openBoard({ ok: true, status: { ...SOON_STATUS, expires_at: '2026-12-01 16:00:00+00' }, effectiveStatus: 'cleared' });

        await pass(5 * 60_000);

        expect(reads.lapsing).toBe(1);
        expect(reads.current).toBe(1);
        expectStillCleared();
        expect(delays).toContain(60_000);
        expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
      } finally {
        if (global.setTimeout === recording) global.setTimeout = fakeSetTimeout;
      }
    });

    test('a tablet that slept through the end date asks within a minute of waking, not when its long timer would have run out', async () => {
      // Ends in two hours.
      await openBoard({ ok: true, status: { ...SOON_STATUS, expires_at: '2026-09-01 18:00:00+00' }, effectiveStatus: 'cleared' });
      await pass(10_000);
      expect(reads.lapsing).toBe(1);

      // Asleep for three hours: the wall clock moves, no timer runs.
      jest.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
      answer = () => asResponse({ ok: true, status: { ...SOON_STATUS, expires_at: '2026-09-01 18:00:00+00' }, effectiveStatus: 'cleared_expired' });
      await pass(60_000);

      expect(reads.lapsing).toBe(2);
      expect(within(rowOf('Sam Roe')).getByText('clearance expired')).toBeTruthy();
      expect(rowOf('Sam Roe').querySelector('.badge--cleared')).toBeNull();
    });

    test.each([
      ['a clearance with no end date', { ok: true, status: { ...SOON_STATUS, expires_at: null }, effectiveStatus: 'cleared' }],
      ['a clearance whose end date is not a date', { ok: true, status: { ...SOON_STATUS, expires_at: 'not-a-date' }, effectiveStatus: 'cleared' }],
      ['a restricted row with an end date', { ok: true, status: { ...SOON_STATUS, status: 'restricted' }, effectiveStatus: 'restricted' }],
      ['a clearance already lapsed', NOW_LAPSED],
    ])('%s is never asked about again', async (_name, body) => {
      await openBoard(body);

      await pass(5 * 60_000);

      expect(reads.lapsing).toBe(1);
    });

    test('a board that has been closed asks nothing', async () => {
      const view = await openBoard();

      view.unmount();
      await pass(120_000);

      expect(reads.lapsing).toBe(1);
    });
  });
});

/*
 * "cleared" is printed only from a success envelope carrying this athlete's
 * status row. The hold half of the row was tightened first; the clearance
 * half had the same hole.
 */
describe('a clearance nobody actually read never reads as cleared, or as "no record"', () => {
  function clearanceRow(): HTMLElement {
    return screen.getByText('Jordan Doe').closest('li') as HTMLElement;
  }

  const NOT_A_CLEARANCE: Array<[string, unknown]> = [
    // Each keeps an effectiveStatus that agrees with its row, so it is refused
    // for the reason its name gives and not for a missing field.
    ['ok:false with a cleared row', { ok: false, status: CLEARED_STATUS, effectiveStatus: 'cleared' }],
    ['no ok at all with a cleared row', { status: CLEARED_STATUS, effectiveStatus: 'cleared' }],
    ['a cleared row for another athlete', { ok: true, status: { ...CLEARED_STATUS, athlete_id: 'SOMEONE-ELSE' }, effectiveStatus: 'cleared' }],
    ['a row that names no athlete', { ok: true, status: { status: 'cleared', effective_at: '2026-08-01T10:00:00.000Z' }, effectiveStatus: 'cleared' }],
    ['a row with a status that is not one of the four', { ok: true, status: { ...CLEARED_STATUS, status: 'fine' }, effectiveStatus: 'fine' }],
    ['a row with no date', { ok: true, status: { ...CLEARED_STATUS, effective_at: undefined }, effectiveStatus: 'cleared' }],
    ['an empty object', {}],
    ['ok:false with an error and a null status', { ok: false, error: 'upstream', status: null, effectiveStatus: 'no_record' }],
    ['ok:true with no status key', { ok: true, effectiveStatus: 'no_record' }],
    ['a status that is a bare string', { ok: true, status: 'cleared', effectiveStatus: 'cleared' }],
    // The word printed is the route's effectiveStatus, and only when it agrees
    // with the row it came with. Each of these is a whole, valid row (or a
    // valid "no row") beside an effectiveStatus that is absent or contradicts
    // it.
    ['a cleared row with NO effectiveStatus', { ok: true, status: CLEARED_STATUS }],
    ['no row with NO effectiveStatus', { ok: true, status: null }],
    ['no row beside effectiveStatus "cleared"', { ok: true, status: null, effectiveStatus: 'cleared' }],
    ['a cleared row beside effectiveStatus "no_record"', { ok: true, status: CLEARED_STATUS, effectiveStatus: 'no_record' }],
    ['a restricted row beside effectiveStatus "cleared"', { ok: true, status: { ...CLEARED_STATUS, status: 'restricted' }, effectiveStatus: 'cleared' }],
    ['a cleared row beside effectiveStatus "restricted"', { ok: true, status: CLEARED_STATUS, effectiveStatus: 'restricted' }],
    ['a pending row beside effectiveStatus "cleared_expired"', { ok: true, status: { ...CLEARED_STATUS, status: 'pending' }, effectiveStatus: 'cleared_expired' }],
    ['a not_cleared row beside effectiveStatus "cleared_expired"', { ok: true, status: { ...CLEARED_STATUS, status: 'not_cleared' }, effectiveStatus: 'cleared_expired' }],
    ['a restricted row beside effectiveStatus "cleared_expired"', { ok: true, status: { ...CLEARED_STATUS, status: 'restricted' }, effectiveStatus: 'cleared_expired' }],
    ['a cleared row beside an effectiveStatus that is no known word', { ok: true, status: CLEARED_STATUS, effectiveStatus: 'CLEARED' }],
    ['a cleared row beside an effectiveStatus that is not a string', { ok: true, status: CLEARED_STATUS, effectiveStatus: true }],
  ];

  test.each(NOT_A_CLEARANCE)('%s: the row says unavailable', async (_name, body) => {
    global.fetch = mockFetch({ '/shadow/medical-status': () => ({ ok: true, json: async () => body }) as Response });

    render(<SportsMedicinePage />);
    await screen.findByText('Jordan Doe');

    expect(within(clearanceRow()).getByText('unavailable')).toBeTruthy();
    expect(within(clearanceRow()).getByText(/Unknown is not cleared/)).toBeTruthy();
    expect(within(clearanceRow()).queryByText('cleared')).toBeNull();
    expect(within(clearanceRow()).queryByText('no record')).toBeNull();
    expect(within(clearanceRow()).queryByText('clearance expired')).toBeNull();
    expect(clearanceRow().querySelector('.badge--cleared')).toBeNull();
    expect(screen.queryByText(/No clearance record on file/)).toBeNull();
  });

  test('a roster answered 200 without a list is a board that could not be read, not an empty roster', async () => {
    for (const body of [{}, { ok: false, error: 'upstream' }, { items: null }, { items: {} }]) {
      global.fetch = mockFetch({ '/athletes/list': () => ({ ok: true, json: async () => body }) as Response });

      const { unmount } = render(<SportsMedicinePage />);

      expect(await screen.findByText('The clearance board could not be read')).toBeTruthy();
      expect(screen.queryByText('No athletes on your roster')).toBeNull();
      unmount();
    }
  });
});

/*
 * A place form belongs to the athlete it was opened for.
 */
describe('a place that comes back late does not touch another athlete’s open form', () => {
  const SECOND = { athlete_id: 'ath-2', full_name: 'Riley Poe' };

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('li') as HTMLElement;
  }

  function twoRowFetch(firstPlace: Promise<Response>) {
    const posted: Array<Record<string, unknown>> = [];
    let firstPlaced = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        if (body.athlete_id === 'ath-1') {
          const response = await firstPlace;
          firstPlaced = response.ok;
          return response;
        }
        return { ok: true, json: async () => ({ ok: true, hold: { ...PLACED, hold_id: 'hold-for-2' } }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, SECOND] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('athlete_id=ath-1')) {
        return { ok: true, json: async () => ({ ok: true, holds: firstPlaced ? [PLACED] : [] }) } as Response;
      }
      if (url.includes('/training-holds')) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    return posted;
  }

  async function placeForFirstThenOpenSecond() {
    render(<SportsMedicinePage />);
    await screen.findByText('Riley Poe');
    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }));
    fireEvent.change(await screen.findByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Jordan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await within(rowOf('Jordan Doe')).findByRole('button', { name: 'Placing…' });

    // Jordan's place is still out. The coach moves on to Riley.
    fireEvent.click(within(rowOf('Riley Poe')).getByRole('button', { name: 'Place a training hold' }));
    const riley = within(rowOf('Riley Poe'));
    // A fresh form, not Jordan's sentence.
    expect((riley.getByLabelText(/What this athlete reads/) as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(riley.getByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Riley, half written' } });
  }

  test('a late SUCCESS for the first athlete shows their hold and leaves the second athlete’s form open with its text', async () => {
    let release: ((response: Response) => void) | undefined;
    const posted = twoRowFetch(new Promise<Response>((resolve) => { release = resolve; }));
    await placeForFirstThenOpenSecond();

    release?.({ ok: true, json: async () => ({ ok: true, hold: PLACED }) } as Response);
    await within(rowOf('Jordan Doe')).findByText(/Active Training Hold — contact only/);

    const riley = within(rowOf('Riley Poe'));
    expect((riley.getByLabelText(/What this athlete reads/) as HTMLTextAreaElement).value).toBe('Sentence for Riley, half written');

    // And Riley's hold goes to Riley, with Riley's sentence.
    fireEvent.click(riley.getByRole('button', { name: 'Place hold' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0]).toMatchObject({ athlete_id: 'ath-1', athlete_explanation: 'Sentence for Jordan.' });
    expect(posted[1]).toMatchObject({ athlete_id: 'ath-2', athlete_explanation: 'Sentence for Riley, half written' });
  });

  test('a late REFUSAL for the first athlete lands on their row and leaves the second athlete’s form open with its text', async () => {
    let release: ((response: Response) => void) | undefined;
    twoRowFetch(new Promise<Response>((resolve) => { release = resolve; }));
    await placeForFirstThenOpenSecond();

    release?.({ ok: false, status: 409, json: async () => ({ error: 'Hold already exists -- lift it first' }) } as Response);
    await within(rowOf('Jordan Doe')).findByText('Hold Not Placed');

    const riley = within(rowOf('Riley Poe'));
    expect((riley.getByLabelText(/What this athlete reads/) as HTMLTextAreaElement).value).toBe('Sentence for Riley, half written');
    expect(riley.queryByText('Hold Not Placed')).toBeNull();
  });
});

describe('one row’s refusal is not erased by another row', () => {
  const SECOND = { athlete_id: 'ath-2', full_name: 'Riley Poe' };

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('li') as HTMLElement;
  }

  test('"Hold Not Placed" stays on its row while the coach opens, places and is refused on another', async () => {
    // Jordan is NOT held. The stamp saying so used to vanish the moment the
    // coach touched Riley's row.
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { athlete_id: string };
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: `Refused for ${body.athlete_id}.` }),
        } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, SECOND] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await screen.findByText('Riley Poe');
    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }));
    fireEvent.change(await screen.findByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Jordan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await within(rowOf('Jordan Doe')).findByText('Refused for ath-1.');

    fireEvent.click(within(rowOf('Riley Poe')).getByRole('button', { name: 'Place a training hold' }));
    expect(within(rowOf('Jordan Doe')).getByText('Hold Not Placed')).toBeTruthy();

    const riley = within(rowOf('Riley Poe'));
    fireEvent.change(riley.getByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Riley.' } });
    fireEvent.click(riley.getByRole('button', { name: 'Place hold' }));
    await riley.findByText('Refused for ath-2.');

    expect(within(rowOf('Jordan Doe')).getByText('Refused for ath-1.')).toBeTruthy();
    expect(within(rowOf('Jordan Doe')).queryByText('Refused for ath-2.')).toBeNull();
  });

  test('a form closed because a hold turned up does not come back by itself when that hold is lifted', async () => {
    let lifted = false;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string };
        if (body.action === 'lift') {
          lifted = true;
          return { ok: true, json: async () => ({ ok: true, hold: { ...HOLD, athlete_id: 'ath-1', status: 'lifted' } }) } as Response;
        }
        return { ok: false, status: 409, json: async () => ({ error: 'Hold already exists -- lift it first' }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        // First read: none. After the refusal someone else's hold is there.
        const calls = (global.fetch as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('/training-holds') && !(c[1] as RequestInit | undefined)?.body).length;
        const holds = calls === 1 || lifted ? [] : [HOLD];
        return { ok: true, json: async () => ({ ok: true, holds }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'An old sentence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await screen.findByText(/Active Training Hold — sparring/);

    fireEvent.click(screen.getByRole('button', { name: 'Lift this hold' }));
    await waitFor(() => expect(screen.queryByText(/Active Training Hold/)).toBeNull());

    expect(screen.queryByLabelText(/What this athlete reads/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Place a training hold' })).toBeTruthy();
  });
});

describe('whose refusal is whose, and when it goes', () => {
  const SECOND = { athlete_id: 'ath-2', full_name: 'Riley Poe' };

  function rowOf(name: string): HTMLElement {
    return screen.getByText(name).closest('li') as HTMLElement;
  }

  /** Jordan has no hold and every place is refused; Riley has a hold. */
  function boardWithRefusals(options: { failRereadFor?: string } = {}) {
    const reads: Record<string, number> = {};
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; athlete_id?: string };
        if (body.action === 'lift') {
          return { ok: false, status: 400, json: async () => ({ error: 'Lift refused for Riley.' }) } as Response;
        }
        return { ok: false, status: 400, json: async () => ({ error: `Refused for ${body.athlete_id}.` }) } as Response;
      }
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, SECOND] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        const id = url.includes('athlete_id=ath-2') ? 'ath-2' : 'ath-1';
        reads[id] = (reads[id] ?? 0) + 1;
        if (options.failRereadFor === id && reads[id] > 1) {
          return { ok: false, status: 503, json: async () => ({}) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true, holds: id === 'ath-2' ? [{ ...HOLD, athlete_id: 'ath-2' }] : [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  async function refuseJordan() {
    render(<SportsMedicinePage />);
    await screen.findByText('Riley Poe');
    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }));
    fireEvent.change(await screen.findByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Jordan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await within(rowOf('Jordan Doe')).findByText('Refused for ath-1.');
  }

  test('lifting (and being refused) on another row leaves this row’s refusal in place', async () => {
    boardWithRefusals();
    await refuseJordan();

    fireEvent.click(within(rowOf('Riley Poe')).getByRole('button', { name: 'Lift this hold' }));
    await within(rowOf('Riley Poe')).findByText('Lift refused for Riley.');

    expect(within(rowOf('Jordan Doe')).getByText('Refused for ath-1.')).toBeTruthy();
    expect(within(rowOf('Riley Poe')).queryByText('Refused for ath-1.')).toBeNull();
  });

  test('a row’s own next action clears its own refusal: placing again, and cancelling', async () => {
    boardWithRefusals();
    await refuseJordan();
    const jordan = within(rowOf('Jordan Doe'));

    // Placing again: the old stamp goes while the new attempt is out, then
    // the new answer lands.
    fireEvent.change(jordan.getByLabelText(/What this athlete reads/), { target: { value: 'A second sentence.' } });
    fireEvent.click(jordan.getByRole('button', { name: 'Place hold' }));
    await jordan.findByText('Refused for ath-1.');

    fireEvent.click(jordan.getByRole('button', { name: 'Cancel' }));
    expect(jordan.queryByText('Hold Not Placed')).toBeNull();
    expect(within(rowOf('Riley Poe')).queryByText('Hold Not Placed')).toBeNull();
  });

  test('a row’s own refused lift is cleared when it lifts again', async () => {
    boardWithRefusals();
    render(<SportsMedicinePage />);
    await screen.findByText('Riley Poe');
    const riley = within(rowOf('Riley Poe'));
    fireEvent.click(riley.getByRole('button', { name: 'Lift this hold' }));
    await riley.findByText('Hold Not Lifted');

    let sawItGone = false;
    const observer = new MutationObserver(() => {
      if (!within(rowOf('Riley Poe')).queryByText('Hold Not Lifted')) sawItGone = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    fireEvent.click(riley.getByRole('button', { name: 'Lift this hold' }));
    await riley.findByText('Hold Not Lifted');
    observer.disconnect();

    expect(sawItGone).toBe(true);
  });

  test('"write the sentence" is about the open form and goes when another row’s form replaces it', async () => {
    const THIRD = { athlete_id: 'ath-3', full_name: 'Sam Lee' };
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, THIRD] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Lee');
    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Place hold' }));
    await within(rowOf('Jordan Doe')).findByText(/Write the sentence this athlete reads/);

    fireEvent.click(within(rowOf('Sam Lee')).getByRole('button', { name: 'Place a training hold' }));

    // Jordan's form is gone, and so is the prompt about it.
    expect(screen.queryByText(/Write the sentence this athlete reads/)).toBeNull();
    expect(within(rowOf('Jordan Doe')).queryByText('Hold Not Placed')).toBeNull();
  });

  test('a late refusal for one row whose re-read FAILS does not close another row’s open form', async () => {
    let release: ((response: Response) => void) | undefined;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    const THIRD = { athlete_id: 'ath-3', full_name: 'Sam Lee' };
    let jordanReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return held;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE, THIRD] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('athlete_id=ath-1')) {
        jordanReads += 1;
        if (jordanReads > 1) return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      if (url.includes('/training-holds')) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    render(<SportsMedicinePage />);
    await screen.findByText('Sam Lee');
    fireEvent.click(within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }));
    fireEvent.change(await screen.findByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Jordan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
    await within(rowOf('Jordan Doe')).findByRole('button', { name: 'Placing…' });

    fireEvent.click(within(rowOf('Sam Lee')).getByRole('button', { name: 'Place a training hold' }));
    // Jordan's own open control is locked while Jordan's place is still out.
    expect((within(rowOf('Jordan Doe')).getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(true);
    const sam = within(rowOf('Sam Lee'));
    fireEvent.change(sam.getByLabelText(/What this athlete reads/), { target: { value: 'Sentence for Sam, half written' } });

    release?.({ ok: false, status: 409, json: async () => ({ error: 'Hold already exists -- lift it first' }) } as Response);
    await within(rowOf('Jordan Doe')).findByText(/Training hold could not be read/);

    expect((sam.getByLabelText(/What this athlete reads/) as HTMLTextAreaElement).value).toBe('Sentence for Sam, half written');
    expect(within(rowOf('Jordan Doe')).getByText('Hold Not Placed')).toBeTruthy();
  });
});

/*
 * A placement's answer is painted on the row without a read only when it IS
 * this placement's answer: ok, an active hold, for this athlete.
 */
describe('a place response that is not this athlete’s active hold is never painted on this athlete', () => {
  const UNREAD = /Training hold could not be read/;
  const OTHERS = {
    hold_id: 'hold-of-b',
    athlete_id: 'ath-b',
    status: 'active',
    scope: 'all_training',
    athlete_explanation: 'A SENTENCE WRITTEN FOR ANOTHER CHILD.',
    lift_condition_text: 'Their path back.',
  };

  function placeBoard(placeAnswer: unknown) {
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => placeAnswer } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        if (holdReads === 1) return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  async function place() {
    render(<SportsMedicinePage />);
    await openPlaceForm();
    fireEvent.change(screen.getByLabelText(/What this athlete reads/), { target: { value: 'Resting your wrist.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place hold' }));
  }

  test.each([
    ['a full active hold for ANOTHER athlete', { ok: true, hold: OTHERS }],
    ['this athlete’s hold, but lifted', { ok: true, hold: { ...PLACED, status: 'lifted' } }],
    ['this athlete’s hold with no status', { ok: true, hold: { ...PLACED, status: undefined } }],
    ['a hold that names no athlete', { ok: true, hold: { ...PLACED, athlete_id: undefined } }],
  ])('%s, then a re-read that fails: unknown, with nothing of that hold on screen', async (_name, answer) => {
    placeBoard(answer);
    await place();

    expect(await screen.findByText(UNREAD)).toBeTruthy();
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
    expect(screen.queryByText(/A SENTENCE WRITTEN FOR ANOTHER CHILD/)).toBeNull();
    expect(screen.queryByText(/Their path back/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('a full active hold for ANOTHER athlete, echoed by the re-read too: still nothing of it under this athlete', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true, hold: OTHERS }) } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        const reads = (global.fetch as jest.Mock).mock.calls.filter(
          (c) => String(c[0]).includes('/training-holds') && (c[1] as RequestInit | undefined)?.method !== 'POST',
        ).length;
        return { ok: true, json: async () => ({ ok: true, holds: reads === 1 ? [] : [OTHERS] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await place();

    expect(await screen.findByText(UNREAD)).toBeTruthy();
    expect(screen.queryByText(/Active Training Hold/)).toBeNull();
    expect(screen.queryByText(/A SENTENCE WRITTEN FOR ANOTHER CHILD/)).toBeNull();
  });

  test('a placement nobody confirmed, and no hold found by the read: the row says so instead of going quietly unknown', async () => {
    let holdReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (url.includes('/athletes/list')) return { ok: true, json: async () => ({ items: [ATHLETE] }) } as Response;
      if (url.includes('/shadow/medical-status')) {
        return { ok: true, json: async () => ({ ok: true, status: CLEARED_STATUS, effectiveStatus: 'cleared' }) } as Response;
      }
      if (url.includes('/training-holds')) {
        holdReads += 1;
        return { ok: true, json: async () => ({ ok: true, holds: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    await place();

    expect(await screen.findByText(/did not confirm this hold/)).toBeTruthy();
    expect(screen.getByText('Hold Not Placed')).toBeTruthy();
    expect(screen.getByText(UNREAD)).toBeTruthy();

    // And the way out works: a read that finds no hold gives the control back.
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText(UNREAD)).toBeNull());
    expect((screen.getByRole('button', { name: 'Place a training hold' }) as HTMLButtonElement).disabled).toBe(false);
    expect(holdReads).toBe(3);
  });

  test('a CONFIRMED placement says nothing of the kind', async () => {
    placeBoard({ ok: true, hold: PLACED });
    await place();

    await screen.findByText(/Active Training Hold — contact only/);
    expect(screen.queryByText(/did not confirm this hold/)).toBeNull();
    expect(screen.queryByText('Hold Not Placed')).toBeNull();
  });

  test('this athlete’s own active hold, then a re-read that fails: that hold is shown', async () => {
    placeBoard({ ok: true, hold: PLACED });
    await place();

    await screen.findByText(/Active Training Hold — contact only/);
    expect(screen.getByText(PLACED.athlete_explanation)).toBeTruthy();
    expect(screen.queryByText(UNREAD)).toBeNull();
  });
});
