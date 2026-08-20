/**
 * @jest-environment jsdom
 */

// Notices used to exist only as rows an engineer inserted by hand, so the
// author had no way to see which of them a member could actually read. These
// pin the distinction the surface has to keep visible: live, scheduled,
// expired, and retired are four different things.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import NoticesPage from './page';
import type { AnnouncementItem } from '@/components/AnnouncementBanner';

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

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({
    role: 'coach',
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'coach-1',
    mustChangePin: false,
    loading: false,
  }),
}));

function item(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann-1',
    message: 'Gloves on at 5.',
    author_name: 'Coach M.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'gym_notices',
    kind: 'notice',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<NoticesPage />);
  });
  return fetchMock;
}

function listFetch(announcements: AnnouncementItem[]): jest.Mock {
  return jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });
}

test('the author sees which items are live and which are not', async () => {
  await renderPage(
    listFetch([
      item({ announcement_id: 'a-live', message: 'Gloves on at 5.' }),
      item({ announcement_id: 'a-sched', message: 'Tournament sign-ups open Monday.', starts_at: '2099-01-01T00:00:00.000Z' }),
      item({ announcement_id: 'a-gone', message: 'Last week only.', ends_at: '2020-01-01T00:00:00.000Z' }),
      item({ announcement_id: 'a-retired', message: 'Pulled down.', active: false }),
    ]),
  );

  const posted = screen.getByRole('heading', { name: 'Everything Posted' }).parentElement as HTMLElement;
  expect(within(posted).getByText('LIVE')).toBeTruthy();
  expect(within(posted).getByText('SCHEDULED')).toBeTruthy();
  expect(within(posted).getByText('EXPIRED')).toBeTruthy();
  expect(within(posted).getByText('RETIRED')).toBeTruthy();
});

test('the live-right-now summary carries only what a member can read today', async () => {
  await renderPage(
    listFetch([
      item({ announcement_id: 'a-live', message: 'Gloves on at 5.' }),
      item({ announcement_id: 'a-sched', message: 'Tournament sign-ups open Monday.', starts_at: '2099-01-01T00:00:00.000Z' }),
    ]),
  );

  const live = screen.getByRole('heading', { name: 'Live Right Now' }).parentElement as HTMLElement;
  expect(within(live).getByText(/Gloves on at 5\./)).toBeTruthy();
  expect(within(live).queryByText(/Tournament sign-ups open Monday\./)).toBeNull();
  expect(within(live).getAllByText(/Nothing live\./).length).toBeGreaterThan(0);
});

test('publishing sends the placement, kind and window the author chose', async () => {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/announcements/post')) {
      return jsonResponse({ ok: true, announcement: item() });
    }
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements: [] });
    }
    throw new Error(`Unexpected fetch: ${String(url)} ${String(init?.method)}`);
  });

  await renderPage(fetchMock);

  fireEvent.change(screen.getByPlaceholderText('What should this surface say?'), {
    target: { value: 'Hands up, chin down.' },
  });
  fireEvent.change(screen.getByPlaceholderText('Your name, as members will see it'), {
    target: { value: 'Coach M.' },
  });
  fireEvent.change(screen.getByLabelText(/Placement/), { target: { value: 'athlete_workspace' } });
  fireEvent.change(screen.getByLabelText(/Kind/), { target: { value: 'motivation' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  });

  const postCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/announcements/post'));
  expect(postCall).toBeDefined();
  expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toMatchObject({
    message: 'Hands up, chin down.',
    author_name: 'Coach M.',
    placement: 'athlete_workspace',
    kind: 'motivation',
    starts_at: null,
    ends_at: null,
  });
});

test('a window that closes before it opens is refused before it reaches the server', async () => {
  const fetchMock = await renderPage(listFetch([]));

  fireEvent.change(screen.getByPlaceholderText('What should this surface say?'), { target: { value: 'Hello' } });
  fireEvent.change(screen.getByPlaceholderText('Your name, as members will see it'), { target: { value: 'Coach' } });
  fireEvent.change(screen.getByLabelText(/Starts \(optional\)/), { target: { value: '2026-08-08T10:00' } });
  fireEvent.change(screen.getByLabelText(/Ends \(optional\)/), { target: { value: '2026-08-01T10:00' } });

  expect(screen.getByText('The end time must be after the start time.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/announcements/post'))).toHaveLength(0);
});

test('retiring an item marks it retired in place', async () => {
  const fetchMock = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/announcements/update')) {
      return jsonResponse({ ok: true, announcement: item({ active: false }) });
    }
    if (String(url).includes('/api/pilot/announcements/get')) {
      return jsonResponse({ ok: true, announcements: [item()] });
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  });

  await renderPage(fetchMock);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
  });

  expect(screen.getByText('Retired. It no longer renders anywhere.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  const live = screen.getByRole('heading', { name: 'Live Right Now' }).parentElement as HTMLElement;
  expect(within(live).queryByText(/Gloves on at 5\./)).toBeNull();
});

test('a failed load is not presented as an empty notice board', async () => {
  await renderPage(jest.fn(async () => jsonResponse({}, false)));

  expect(screen.getByText(/Nothing below is the full list/i)).toBeTruthy();
  expect(screen.queryByText('Nothing has been posted for this gym yet.')).toBeNull();
});

/* ============================================================== the room ==

   /notices was roomless while being named in the Front Office's own Purpose
   line, and the reason on file was the ink: a staff-gated page standing on
   .on-canvas with --hide-800 and --hide-950 hard-coded into its header, which
   is correct on cream and invisible on a plank wall. These pin the conversion
   and the room together, because either one alone is the failure mode.

   MUTATION-CHECKED. Dropping `room`, dropping `room--office`, putting a
   `min-h-screen bg-[...]` child back inside the room, restoring one
   `text-[color:var(--hide-800)]`, and swapping .btn--lever back to
   .btn--ghost each turn one of these red by name. */

/** class="..." / className="..." / className={`...`} -- attributes only. */
const CLASS_ATTR = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

/**
 * Ink authored for the family canvas. Every one of these resolves to a colour
 * the light ground needs and the plank wall cannot use: --canvas-tan is
 * --canvas-warm, --black is --hide-950 (#14100D), --gray-dark is --hide-800
 * (#2A1F18). The hide rungs are banned as INK only -- `bg-[var(--hide-950)]`
 * on the room element itself is the no-stylesheet fallback every sibling
 * office route states, and is not what goes dark-on-dark.
 */
const CANVAS_INK = [
  'var(--canvas-tan',
  'var(--black)',
  'var(--gray-dark)',
  'text-[color:var(--hide-800)]',
  'text-[color:var(--hide-950)]',
  'text-[var(--hide-800)]',
  'text-[var(--hide-950)]',
];

/** A ground tall enough to cover the wall, the light and the plate at once. */
const FULL_VIEWPORT = /^(?:[a-z]+:)?(?:min-)?h-(?:screen|full|\[100vh\]|\[100dvh\])$/;
const A_GROUND = /^(?:[a-z]+:)?bg-/;

function classAttributeValues(source: string): string[] {
  return [...source.matchAll(CLASS_ATTR)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

test('stands in the front office wearing the base class, not the modifier alone', async () => {
  await renderPage(listFetch([]));

  const main = document.querySelector('main');
  expect(main).not.toBeNull();
  const tokens = (main as HTMLElement).className.split(/\s+/).filter(Boolean);

  // Both, on the same element. `.room--office` DECLARES --plate and never
  // consumes it -- `.room::after` paints the plate and `.room::before` is the
  // light -- so a surface carrying only the modifier gets the plank texture
  // and no room at all. That was defect #498, across 76 surfaces.
  expect(tokens).toContain('room');
  expect(tokens).toContain('room--office');
});

test('lets no descendant paint a full-viewport ground over the room', async () => {
  await renderPage(listFetch([item()]));

  const room = document.querySelector('main.room') as HTMLElement;
  // ppbf.css is unlayered and Tailwind's utilities sit in @layer utilities, so
  // .room--office outranks a bg-[...] on the SAME element -- but not on a
  // child. A child stating `min-h-screen bg-[...]` paints a full-viewport
  // rectangle over the wall AND over the plate and silently negates the room.
  // Found live at coach/sports-medicine/page.tsx and fixed there.
  const offenders = [...room.querySelectorAll('*')]
    .filter((el) => typeof el.className === 'string')
    .map((el) => ({ el, tokens: el.className.split(/\s+/).filter(Boolean) }))
    .filter(({ tokens }) => tokens.some((t) => FULL_VIEWPORT.test(t)) && tokens.some((t) => A_GROUND.test(t)))
    .map(({ el }) => `${el.tagName.toLowerCase()}: ${el.className}`);

  expect(offenders).toEqual([]);
});

test('states no canvas ink in any class it writes', () => {
  // Read off the source rather than the DOM: a branch that only renders on a
  // failed load or a board session still ships its ink. Class ATTRIBUTES only,
  // so the comments above -- which name these tokens to explain them -- are
  // prose and not markup.
  const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
  const offenders = classAttributeValues(source)
    .filter((value) => CANVAS_INK.some((token) => value.includes(token)));

  expect(offenders).toEqual([]);
});

test('carries the office furniture and not only the office wall', async () => {
  await renderPage(listFetch([item()]));

  const room = document.querySelector('main.room') as HTMLElement;
  // ROOM-PURPOSE-DNA, Feel: "Plank wall, desk lamp, paper forms". Motion:
  // "Forms, tables". The wall was never the missing half.
  expect(room.querySelector('.lamp')).not.toBeNull();
  expect(room.querySelector('.mat-paper')).not.toBeNull();
  expect(room.querySelector('table.ledger')).not.toBeNull();
});

test('names its empty board instead of leaving one bare sentence', async () => {
  await renderPage(listFetch([]));

  const empty = document.querySelector('.empty');
  expect(empty).not.toBeNull();
  // The DNA names the invite as well as the empty state. An empty board that
  // only tells you nothing is there is not a front desk.
  expect(empty?.querySelector('.empty-action')).not.toBeNull();
  expect(screen.getByText('Nothing has been posted for this gym yet.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Write the first one' })).toBeTruthy();
});

test('puts no ghost button on the paper', async () => {
  await renderPage(listFetch([item()]));

  // ppbf.css documents .btn--ghost as grey-on-grey the moment it lands on a
  // light ground: it is bone text on a translucent black wash, tuned for
  // leather. .btn--lever carries its own dark surface and reads on the sheet.
  const ghostsOnPaper = [...document.querySelectorAll('.mat-paper .btn--ghost')]
    .map((el) => el.textContent?.trim());
  expect(ghostsOnPaper).toEqual([]);
  expect(document.querySelector('.mat-paper .btn--lever')).not.toBeNull();
});
