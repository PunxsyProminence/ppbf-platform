/**
 * @jest-environment jsdom
 */

// The screen that records a guardian signed.
//
// pilot.waivers and POST /api/pilot/intake/domain-upsert both existed for
// months; what did not exist was any screen calling them, so consent could be
// recorded by an API call and by nobody standing in the gym. These tests hold
// the two things that make this screen worth having: it sends the shape the
// route actually accepts, and it never reports "nothing on file" for a child
// whose record merely failed to load.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ConsentPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const ROSTER = [
  { athlete_id: 'ath-001', full_name: 'Sample Athlete One', active_flag: true },
  { athlete_id: 'ath-002', full_name: 'Sample Athlete Two', active_flag: false },
];

/** One row of pilot.waivers, shared by the register checks below. */
const WAIVER_ON_FILE = {
  waiver_id: 'w-1',
  athlete_id: 'ath-001',
  waiver_type: 'general',
  signed_by_name: 'A Guardian',
  signed_by_role: 'guardian',
  signed_at: '2026-07-04T12:00:00.000Z',
  consent_version: 'v1',
  status: 'signed',
  notes: 'Paper in the blue folder',
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

/** Roster from athletes/list, waivers from domain-get, writes to domain-upsert. */
function mockApi(options: {
  waivers?: unknown[];
  domainGetOk?: boolean;
  upsertOk?: boolean;
} = {}) {
  const { waivers = [], domainGetOk = true, upsertOk = true } = options;
  return jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/athletes/list')) {
      // The route answers with `items` on every branch.
      return jsonResponse({ items: ROSTER });
    }
    if (target.includes('/domain-get')) {
      return domainGetOk
        ? jsonResponse({ ok: true, waivers })
        : jsonResponse({ error: 'Database unavailable' }, false);
    }
    if (target.includes('/domain-upsert')) {
      return upsertOk
        ? jsonResponse({ ok: true, entity_id: 'waiver-1' })
        : jsonResponse({ error: 'Forbidden: role not allowed' }, false);
    }
    void init;
    return jsonResponse({}, false);
  });
}

async function renderAndPickAthlete(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ConsentPage />);
  await screen.findByText('Sample Athlete One');
  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-001' } });
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-get'))).toBe(true),
  );
}

it('reads the roster from `items`, the key the route actually sends', async () => {
  const fetchMock = mockApi();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ConsentPage />);

  // Both athletes offered, the inactive one marked rather than hidden -- a
  // consent record may need adding for someone who has stopped attending.
  expect(await screen.findByText('Sample Athlete One')).toBeTruthy();
  expect(screen.getByText('Sample Athlete Two (inactive)')).toBeTruthy();
});

it('sends the entity_type and payload domain-upsert expects', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.change(screen.getByLabelText('Date signed'), { target: { value: '2026-08-15' } });
  fireEvent.change(screen.getByLabelText('What was signed'), { target: { value: 'medical_release' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-upsert'))).toBe(true),
  );

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/domain-upsert'));
  const sent = JSON.parse(String((call?.[1] as RequestInit).body));

  expect(sent.entity_type).toBe('waiver');
  expect(sent.athlete_id).toBe('ath-001');
  expect(sent.payload.signed_by_name).toBe('A Guardian');
  expect(sent.payload.waiver_type).toBe('medical_release');
  expect(sent.payload.status).toBe('signed');
});

// pilot.waivers.signed_at is timestamptz and the input gives a calendar day.
// Sending midnight would store the day before the one that was typed for every
// reader west of Greenwich -- the same off-by-one that made an athlete's drill
// due date render a day early.
it('stores the day that was typed, not the day before it', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.change(screen.getByLabelText('Date signed'), { target: { value: '2026-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/domain-upsert'))).toBe(true),
  );

  const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/domain-upsert'));
  const sent = JSON.parse(String((call?.[1] as RequestInit).body));

  // Midday, so the stored instant lands on 2026-01-01 in every timezone rather
  // than 2025-12-31 -- a consent dated to the wrong YEAR.
  expect(sent.payload.signed_at).toBe('2026-01-01T12:00:00.000Z');
  expect(new Date(sent.payload.signed_at).toISOString().slice(0, 10)).toBe('2026-01-01');
});

it('will not submit without a name and a date', async () => {
  const fetchMock = mockApi();
  await renderAndPickAthlete(fetchMock);

  // Name empty by default, so the control is refused rather than sending a
  // consent record attributed to nobody.
  expect(screen.getByRole('button', { name: /record consent/i }).hasAttribute('disabled')).toBe(true);
});

it('shows what is already on file', async () => {
  const fetchMock = mockApi({
    waivers: [
      {
        waiver_id: 'w-1',
        athlete_id: 'ath-001',
        waiver_type: 'general',
        signed_by_name: 'A Guardian',
        signed_by_role: 'guardian',
        signed_at: '2026-07-04T12:00:00.000Z',
        consent_version: 'v1',
        status: 'signed',
        notes: 'Paper in the blue folder',
      },
    ],
  });
  await renderAndPickAthlete(fetchMock);

  expect(await screen.findByText(/A Guardian/)).toBeTruthy();
  expect(screen.getByText('Paper in the blue folder')).toBeTruthy();
  // Rendered from the calendar day rather than through new Date().
  expect(screen.getByText('Jul 4, 2026')).toBeTruthy();
});

// The worst error this screen could make. "Nothing on file" for a child whose
// guardian did sign, because a request failed, would send somebody to ask a
// family for paperwork they already provided -- or worse, read as consent never
// having been given.
it('never reports nothing on file when the record failed to load', async () => {
  const fetchMock = mockApi({ domainGetOk: false });
  await renderAndPickAthlete(fetchMock);

  // The server's own reason, not a generic one -- the person standing at the
  // desk can tell "the database is down" from "this athlete has no record".
  expect(await screen.findByText(/Database unavailable/i)).toBeTruthy();
  expect(screen.queryByText(/Nothing recorded for this athlete yet/i)).toBeNull();
});

it('says nothing is on file only when the record loaded and was empty', async () => {
  const fetchMock = mockApi({ waivers: [] });
  await renderAndPickAthlete(fetchMock);

  expect(await screen.findByText(/Nothing recorded for this athlete yet/i)).toBeTruthy();
});

it('reports a refused write instead of claiming it saved', async () => {
  const fetchMock = mockApi({ upsertOk: false });
  await renderAndPickAthlete(fetchMock);

  fireEvent.change(screen.getByLabelText('Who signed'), { target: { value: 'A Guardian' } });
  fireEvent.click(screen.getByRole('button', { name: /record consent/i }));

  expect(await screen.findByText(/Forbidden: role not allowed/i)).toBeTruthy();
  expect(screen.queryByText('Recorded.')).toBeNull();
});

/* ============================================================== the room ==

   This screen was roomless on the legacy canvas-tan palette with roughly forty
   inline restatements of it, and its cards set no ink of their own -- so
   hanging the office wall behind it without converting the ink first would
   have recoloured every one of them at once and left dark type on a dark
   plank. These pin the conversion and the room together, because either one
   alone is the failure mode.

   MUTATION-CHECKED. Dropping `room`, dropping `room--office`, putting a
   `min-h-screen bg-[...]` child back inside the room, restoring one
   `bg-[var(--canvas-tan)]`, and printing a raw waiver_type back into the
   register each turn one of these red by name. */

/** class="..." / className="..." / className={`...`} -- attributes only. */
const CLASS_ATTR = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

/**
 * The legacy palette this page wore. globals.css aliases every one of them to
 * a room token -- --canvas-tan is --canvas-warm, --black is --hide-950
 * (#14100D), --gray-dark is --hide-800 (#2A1F18) -- so each is a light-ground
 * ink, and each lands dark-on-dark the moment a plank wall goes up behind it.
 */
const LEGACY_PALETTE = [
  'var(--canvas-tan',
  'var(--black)',
  'var(--gray-dark)',
  'var(--white)',
  'text-[color:var(--hide-800)]',
  'text-[color:var(--hide-950)]',
];

/** A ground tall enough to cover the wall, the light and the plate at once. */
const FULL_VIEWPORT = /^(?:[a-z]+:)?(?:min-)?h-(?:screen|full|\[100vh\]|\[100dvh\])$/;
const A_GROUND = /^(?:[a-z]+:)?bg-/;

it('stands in the front office wearing the base class, not the modifier alone', async () => {
  await renderAndPickAthlete(mockApi());

  const main = document.querySelector('main');
  expect(main).not.toBeNull();
  const tokens = (main as HTMLElement).className.split(/\s+/).filter(Boolean);

  // Both, on the same element. `.room--office` DECLARES --plate and never
  // consumes it -- `.room::after` paints the plate and `.room::before` is the
  // light -- so the modifier alone is a plank texture with no room behind it.
  // That was defect #498.
  expect(tokens).toContain('room');
  expect(tokens).toContain('room--office');
});

it('lets no descendant paint a full-viewport ground over the room', async () => {
  await renderAndPickAthlete(mockApi({ waivers: [WAIVER_ON_FILE] }));

  const room = document.querySelector('main.room') as HTMLElement;
  // ppbf.css is unlayered and Tailwind's utilities sit in @layer utilities, so
  // .room--office outranks a bg-[...] on the SAME element -- but not on a
  // child. A child stating `min-h-screen bg-[...]` paints over the wall AND
  // the plate and silently negates the room, which is what this page's own
  // <main> used to do with bg-[var(--canvas-tan)].
  const offenders = [...room.querySelectorAll('*')]
    .filter((el) => typeof el.className === 'string')
    .map((el) => ({ el, tokens: el.className.split(/\s+/).filter(Boolean) }))
    .filter(({ tokens }) => tokens.some((t) => FULL_VIEWPORT.test(t)) && tokens.some((t) => A_GROUND.test(t)))
    .map(({ el }) => `${el.tagName.toLowerCase()}: ${el.className}`);

  expect(offenders).toEqual([]);
});

it('states none of the legacy palette in any class it writes', () => {
  // Read off the source rather than the DOM: half this page renders only once
  // an athlete is chosen, and an unrendered branch still ships its ink. Class
  // ATTRIBUTES only, so the comments that name these tokens stay prose.
  const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
  const offenders = [...source.matchAll(CLASS_ATTR)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((value) => LEGACY_PALETTE.some((token) => value.includes(token)));

  expect(offenders).toEqual([]);
});

it('carries the office furniture and not only the office wall', async () => {
  await renderAndPickAthlete(mockApi({ waivers: [WAIVER_ON_FILE] }));

  const room = document.querySelector('main.room') as HTMLElement;
  // ROOM-PURPOSE-DNA, Feel: "Plank wall, desk lamp, paper forms". Motion:
  // "Forms, tables". The wall was never the missing half.
  expect(room.querySelector('.lamp')).not.toBeNull();
  expect(room.querySelector('.mat-paper')).not.toBeNull();
  expect((await screen.findByRole('table')).classList.contains('ledger')).toBe(true);
});

it('reads a filed record back in the words it was filed in, keeping the key', async () => {
  await renderAndPickAthlete(mockApi({ waivers: [WAIVER_ON_FILE] }));

  // The register printed pilot.waivers' raw column values -- `general`,
  // `guardian`, `signed` -- which is a machine talking on a screen whose whole
  // job is answering "who signed, and what". The vocabulary the form already
  // offers is the clerk's wording for exactly those keys.
  // Scoped to the register: the same words are the <option> labels in the
  // form's own selects above it, which is the point -- one vocabulary, read
  // forwards when filing and backwards when reading back.
  const register = within(await screen.findByRole('table'));
  expect(register.getByText('General participation')).toBeTruthy();
  expect(register.getByText('Parent or legal guardian')).toBeTruthy();
  expect(register.getByText('Signed')).toBeTruthy();

  // And the keys are not deleted while looking like a cleanup: they move to
  // the mono "Filed under" column, which is what somebody searching the
  // cabinet a year later actually has to type.
  const filed = register.getByText(/general · signed · v1/);
  expect(filed.classList.contains('ledger-id')).toBe(true);
});

it('names its empty register instead of leaving one bare sentence', async () => {
  await renderAndPickAthlete(mockApi({ waivers: [] }));

  const empty = await screen.findByText('Nothing recorded for this athlete yet.');
  expect(empty.closest('.empty')).not.toBeNull();
  // The DNA names the invite as well as the empty state, and the invite has to
  // land on this page: the form it points at is directly above.
  expect(document.querySelector('.empty-action')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Record the first one' })).toBeTruthy();
});

it('puts no ghost button on the paper', async () => {
  await renderAndPickAthlete(mockApi({ waivers: [WAIVER_ON_FILE] }));

  // ppbf.css documents .btn--ghost as grey-on-grey the moment it lands on a
  // light ground. The one ghost on this page stands on the leather header,
  // which is what it was tuned for.
  const ghostsOnPaper = [...document.querySelectorAll('.mat-paper .btn--ghost')]
    .map((el) => el.textContent?.trim());
  expect(ghostsOnPaper).toEqual([]);

  // The one ghost this page states is the header's Back-to-admin link, and the
  // header is leather. Counted off the source because the next/link mock above
  // renders a bare <a href> and drops className, so a rendered check here
  // would pass on a page that had none.
  const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
  const ghostClasses = [...source.matchAll(CLASS_ATTR)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((value) => value.split(/\s+/).includes('btn--ghost'));
  expect(ghostClasses).toEqual(['btn btn--ghost']);
});
