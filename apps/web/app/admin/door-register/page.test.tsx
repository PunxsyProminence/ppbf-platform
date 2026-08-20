/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import DoorRegisterPage from './page';
import { BUILDING, OPEN, ROOM_LABEL, visibleDoors } from '@/components/buildingMap';
import {
  clearRoleSession,
  createPersistentRoleSession,
  getRoleSessionSnapshot,
} from '@/components/roleSession';
import type { ClubRole } from '@/components/roleRoutes';

/**
 * THE DOOR REGISTER.
 *
 * Two kinds of check live here and they are not equally important.
 *
 * The room-DNA checks (the base .room class, no child painting over the wall)
 * are the ordinary Room DNA guards -- defect #498 and the /coach/sports-medicine
 * bug respectively.
 *
 * THE SAFETY CHECKS ARE THE POINT OF THE FILE. This page exists because the
 * owner chose a structure-only preview over impersonation, and the whole value
 * of that choice is that the page cannot quietly become an impersonation later.
 * So the boundary is pinned from three directions at once:
 *
 *   RENDERED   -- `fetch` is replaced with a spy that THROWS. Every role in the
 *                 picker is clicked. One request of any kind, to any URL, fails
 *                 the test by name.
 *   SESSION    -- the reader's own role session is compared BY REFERENCE across
 *                 previewing every role. roleSession.ts memoizes its snapshot on
 *                 the cached session's reference, so a new reference means
 *                 somebody minted, widened or re-persisted a principal.
 *   SOURCE     -- the page file is read and searched for the machinery of a
 *                 request or a principal. The rendered check only sees the code
 *                 paths it clicks; a fetch behind a condition nobody clicks is
 *                 invisible to it and obvious to this one.
 *
 * MUTATION-CHECKED. Adding a fetch to the page turns the rendered check and the
 * source check red by name; adding an import from src/server/pilot/access turns
 * the chokepoint check red on its own.
 */

/* The gate is the READER's own identity check -- the one fetch on this route
   that is legitimate, and not something this page does. Mocked through so what
   remains under test is the page's own behaviour, which is what makes "no fetch
   at all" a legitimate assertion rather than one carving out an exception. */
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const PAGE_SOURCE = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

/**
 * Prose is not code. This file's own header explains the boundary at length and
 * names the things it forbids while doing it -- "/api/pilot/*" appears in the
 * page's comment saying it never calls one. Stripping comments first is what
 * keeps the checks below failing on a real call rather than on an accurate
 * sentence. Same move, and the same reason, as roomBaseClass.test.ts.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const PAGE_CODE = withoutComments(PAGE_SOURCE);

/** Every role any door in the map names — the set the picker has to cover. */
const SUBJECT_LABEL: Partial<Record<ClubRole, string>> = {
  athlete: 'Athlete', parent: 'Parent', coach: 'Coach', staff: 'Staff',
  volunteer: 'Volunteer', admin: 'Admin', board: 'Board',
  platform_owner: 'Platform Owner',
};

const EVERY_SUBJECT = [
  'Athlete', 'Parent', 'Coach', 'Staff', 'Volunteer',
  'Admin', 'Board', 'Platform Owner', 'Nobody signed in',
];

function rolesNamedByTheMap(): ClubRole[] {
  const named = new Set<ClubRole>();
  for (const door of BUILDING) {
    if (door.roles === OPEN) continue;
    for (const role of door.roles) named.add(role);
  }
  return [...named];
}

/** The reader's own session, set the way the application actually sets one. */
function signInAs(role: ClubRole): void {
  createPersistentRoleSession(role);
}

async function renderPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<DoorRegisterPage />);
  });
  return result;
}

async function pick(label: string): Promise<void> {
  const button = screen.getByRole('button', { name: label });
  await act(async () => {
    button.click();
  });
}

afterEach(() => {
  clearRoleSession();
  jest.restoreAllMocks();
});

/* ------------------------------------------------------- the safety line -- */

describe('the register previews a role WITHOUT becoming that role', () => {
  it('issues no request of any kind, for any previewed role', async () => {
    // Not "no /api/pilot/* request" -- NO REQUEST. The register is a pure
    // function of a module constant, so there is nothing this page could
    // legitimately ask a server for, and the strictest form of the assertion is
    // also the truest one. A fetch on a previewed role's behalf is the exact
    // thing this feature was scoped never to do.
    const forbidden = jest.fn((input: unknown) => {
      throw new Error(`the door register performed a fetch: ${String(input)}`);
    });
    global.fetch = forbidden as unknown as typeof fetch;

    signInAs('admin');
    await renderPage();

    for (const label of EVERY_SUBJECT) await pick(label);

    expect(forbidden).not.toHaveBeenCalled();
  });

  it('leaves the reader’s own session untouched by previewing every role', async () => {
    // The impersonation an admin would reach for first is writing the previewed
    // role into the session, which really would change what every other surface
    // -- and every API call behind them -- believes about that person.
    //
    // Compared by REFERENCE, not by role name. roleSession.ts memoizes its
    // snapshot on the cached session's reference and only replaces it from
    // createPersistentRoleSession / clearRoleSession, so an identical reference
    // is proof no write happened, and a re-mint of the SAME role still fails.
    global.fetch = jest.fn(() => { throw new Error('fetch'); }) as unknown as typeof fetch;

    signInAs('admin');
    const before = getRoleSessionSnapshot();
    expect(before?.role).toBe('admin');

    await renderPage();
    for (const label of EVERY_SUBJECT) await pick(label);

    expect(getRoleSessionSnapshot()).toBe(before);
  });

  it('holds no request machinery in its source at all', () => {
    // The rendered check can only see the paths it clicks. This one reads the
    // file, so a request added behind any condition is caught whether a test
    // happens to run it or not.
    for (const forbidden of ['fetch(', 'apiBase', 'XMLHttpRequest', 'sendBeacon', '/api/']) {
      expect(PAGE_CODE).not.toContain(forbidden);
    }
  });

  it('imports nothing from the authorization chokepoint', () => {
    // requirePrincipal / requireRole / resolvePrincipal and the modules they
    // live in are server-side authority. A client page reaching for any of them
    // is either impersonation or a leak, and there is no third reading.
    for (const forbidden of [
      'server/pilot/access', 'server/pilot/http',
      'requirePrincipal', 'requireRole', 'resolvePrincipal',
    ]) {
      expect(PAGE_CODE).not.toContain(forbidden);
    }
  });

  it('never mints, persists or clears a principal', () => {
    for (const forbidden of [
      'createPersistentRoleSession', 'persistAuthoritativeRoleSession',
      'loadAuthoritativeRoleSession', 'clearRoleSession',
      'document.cookie', 'localStorage',
    ]) {
      expect(PAGE_CODE).not.toContain(forbidden);
    }
  });

  it('says in the page itself that a link opens with the reader’s own permissions', async () => {
    // The severe failure here is not technical: it is an admin believing they
    // are reading a coach's screen. The distinction has to be in words on the
    // page, not only in which rows happen to be underlined.
    signInAs('admin');
    await renderPage();
    await pick('Coach');

    expect(screen.getByText(/with your own permissions/i)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /opens for you/i })).toBeTruthy();
  });
});

/* ------------------------------------------------- links vs. plain text -- */

describe('a door is a link only when the READER can open it', () => {
  it('links the doors the reader’s own session holds and prints the rest as text', async () => {
    // 'staff' rather than 'admin': a staff reader shares only some of a coach's
    // doors, so both sides of the rule are exercised in one render.
    signInAs('staff');
    await renderPage();
    await pick('Coach');

    const previewed = visibleDoors('coach');
    const readerHolds = new Set(visibleDoors('staff').map((door) => door.href));
    const linked = previewed.filter((door) => readerHolds.has(door.href));
    const plain = previewed.filter((door) => !readerHolds.has(door.href));

    // The fixture only means anything if the map actually splits both ways.
    expect(linked.length).toBeGreaterThan(0);
    expect(plain.length).toBeGreaterThan(0);

    const table = screen.getByRole('table');
    for (const door of linked) {
      expect(within(table).getAllByRole('link', { name: door.label }).length).toBeGreaterThan(0);
    }
    for (const door of plain) {
      expect(within(table).queryAllByRole('link', { name: door.label })).toEqual([]);
      // Still ON the page -- printed, just not walkable.
      expect(within(table).getAllByText(door.href).length).toBeGreaterThan(0);
    }
  });

  it('links nothing for a reader with no session, however privileged the preview', async () => {
    // No signInAs: visibleDoors(null) is the ungated set, so every admin-gated
    // row must be plain text even while the register is showing the admin's.
    await renderPage();
    await pick('Admin');

    const table = screen.getByRole('table');
    expect(within(table).queryAllByRole('link', { name: 'Capability Console' })).toEqual([]);
    expect(within(table).getAllByText('/admin').length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------- what it prints -- */

describe('the register prints route metadata, grouped by room', () => {
  it('prints the path and the room of every door the previewed role holds', async () => {
    signInAs('admin');
    await renderPage();
    await pick('Coach');

    const previewed = visibleDoors('coach');
    const table = screen.getByRole('table');

    for (const door of previewed) {
      expect(within(table).getAllByText(door.href).length).toBeGreaterThan(0);
    }
    for (const room of new Set(previewed.map((door) => ROOM_LABEL[door.room]))) {
      expect(within(table).getAllByText(room).length).toBeGreaterThan(0);
    }
  });

  it('shows a different register per role rather than one list for everybody', async () => {
    signInAs('admin');
    await renderPage();

    await pick('Athlete');
    expect(screen.queryByText('/admin/pin')).toBeNull();

    await pick('Admin');
    expect(screen.getAllByText('/admin/pin').length).toBeGreaterThan(0);
  });

  it('offers a subject for every role the map actually names', async () => {
    // Derived from BUILDING, so a door that starts naming a role the picker
    // does not offer fails here instead of quietly going unreadable.
    signInAs('admin');
    await renderPage();

    for (const role of rolesNamedByTheMap()) {
      const label = SUBJECT_LABEL[role];
      expect(label).toBeDefined();
      expect(screen.getByRole('button', { name: label as string })).toBeTruthy();
    }
  });

  it('offers no board SEAT, because no door names one and a seat signs in as Board', async () => {
    signInAs('admin');
    await renderPage();

    for (const seat of ['Treasurer', 'Secretary', 'President', 'Chair']) {
      expect(screen.queryByRole('button', { name: seat })).toBeNull();
    }
  });

  it('opens closed, on the office’s own empty state rather than a hand-rolled one', async () => {
    signInAs('admin');
    const { container } = await renderPage();

    expect(screen.getByText('No role picked yet')).toBeTruthy();
    expect(container.querySelector('.empty')).not.toBeNull();
    expect(container.querySelector('.empty-action')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

/* ------------------------------------------------------------ room DNA -- */

describe('the register stands in the Front Office', () => {
  it('carries the base .room class alongside the modifier', async () => {
    // Defect #498: --plate is DECLARED by .room--office and CONSUMED by
    // .room::after, and the light is .room::before. A surface wearing only the
    // modifier gets the plank texture, no plate and no lamp -- and looks like it
    // did something, which is why this went out across 76 surfaces.
    signInAs('admin');
    const { container } = await renderPage();

    const room = container.querySelector('.room--office');
    expect(room).not.toBeNull();
    expect(room?.classList.contains('room')).toBe(true);
  });

  it('lets no descendant paint a full-viewport background over the wall', async () => {
    // ppbf.css is unlayered and Tailwind's utilities sit in @layer utilities, so
    // a CHILD's `min-h-screen bg-[...]` covers the wall, the lamp and the plate
    // -- which is what was live on /coach/sports-medicine. The room element
    // itself may state a ground: ::before and ::after paint above it. Anything
    // below it may not.
    signInAs('admin');
    const { container } = await renderPage();
    await pick('Admin');

    const offenders = [...container.querySelectorAll('[class*="min-h-screen"]')]
      .filter((el) => /\bbg-\[/.test(el.className))
      .filter((el) => !el.classList.contains('room'))
      .map((el) => el.className);

    expect(offenders).toEqual([]);
  });

  it('wears the office’s own furniture rather than raw Tailwind', async () => {
    // The room's Feel line is "plank wall, desk lamp, paper forms, riveted
    // cards" and its Motion line names tables and "Nobody here yet". The lamp
    // and the ledger are the two that had no consumer at all before #514, so
    // they are the two most likely to be dropped in a later edit.
    signInAs('admin');
    const { container } = await renderPage();
    expect(container.querySelector('.lamp')).not.toBeNull();

    await pick('Admin');
    expect(container.querySelector('.mat-paper')).not.toBeNull();
    expect(container.querySelector('table.ledger')).not.toBeNull();
  });

  it('carries none of the office’s forbidden chrome', () => {
    // Forbidden for this room: clinic green, night telemetry, board wainscot,
    // floor drama. Read from the source, so a class on any branch counts.
    for (const forbidden of [
      'room--clinic', 'room--night', 'room--board', 'room--floor', 'lamp--green',
    ]) {
      expect(PAGE_CODE).not.toContain(forbidden);
    }
  });

  it('uses the lever on paper, never the ghost button ppbf.css calls grey-on-grey', () => {
    // .btn--ghost is documented as grey-on-grey on a light ground; #514 replaced
    // every ghost that landed on paper with .btn--lever. The ghost that remains
    // is on the leather header, which is the ground it was authored for.
    expect(PAGE_CODE).toContain('btn--lever');
    const paperSection = PAGE_CODE.slice(PAGE_CODE.indexOf('mat-paper'));
    expect(paperSection).not.toContain('btn--ghost');
  });
});
