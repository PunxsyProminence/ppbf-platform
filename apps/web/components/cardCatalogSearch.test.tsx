/**
 * @jest-environment jsdom
 */

// SEARCH (AS-4, U2-4c). Jump became Search, and the corridor's Rooms list
// became "All pages" inside it (S2-2 A, OD-2026-11-19-008): Home first, then the
// Room Map's rooms, then Lab for the admin and the platform owner only
// (searchGroups, roomPlaces.ts; QT A, QU A on #2029). The property that is not
// a look: Search never offers a page the person cannot open, and a board seat it
// cannot confirm is never offered (it fails closed, BOA-05).

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import * as buildingMap from './buildingMap';
import { searchGroups } from './roomPlaces';
import type { ClubRole } from './roleRoutes';

let pathname = '/dashboard';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

let role: string | null = 'coach';
/** A board member's cached landing seat (RoleSession.boardSeat), when a test sets one. */
let landingSeat: string | undefined;
const sessionCache = new Map<string, { role: string; expiresAt: number; boardSeat?: string }>();
jest.mock('./roleSession', () => ({
  subscribeRoleSession: () => () => {},
  getRoleSessionSnapshot: () => {
    if (!role) return null;
    const key = `${role}:${landingSeat ?? ''}`;
    let cached = sessionCache.get(key);
    if (!cached) {
      cached = { role, expiresAt: 8.64e15, ...(landingSeat ? { boardSeat: landingSeat } : {}) };
      sessionCache.set(key, cached);
    }
    return cached;
  },
  clearRoleSession: jest.fn(),
}));

import CardCatalog from './CardCatalog';

const ROLES: ClubRole[] = ['athlete', 'coach', 'parent', 'admin', 'board', 'staff', 'volunteer', 'platform_owner'];
const SEAT_DOOR = /^\/board\/(president|chair|vice-chair|treasurer|secretary|safety-director|community-director|at-large)$/;

function openSearch() {
  render(<CardCatalog />);
  act(() => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
  });
  return screen.getByRole('dialog');
}

/** Every page the open Search offers, by href (each row shows its href). */
function offered(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('li[role="option"] code')).map((code) => code.textContent ?? '');
}

/** The group headings under "All pages", in order. */
function groupHeadings(dialog: HTMLElement): string[] {
  return Array.from(dialog.querySelectorAll('[data-group]')).map((el) => el.textContent ?? '');
}

beforeEach(() => {
  role = 'coach';
  landingSeat = undefined;
  pathname = '/dashboard';
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('All pages: only what the person can open, grouped Home, rooms, Lab', () => {
  it.each(ROLES)('offers a %s exactly the doors visibleDoors gives them, seats failing closed', (r) => {
    role = r;
    const dialog = openSearch();
    const open = buildingMap.visibleDoors(r, { boardSeats: null });
    const hrefs = offered(dialog);
    for (const href of hrefs) expect(open.some((door) => door.href === href)).toBe(true);
    // And it hides none of them: every door in a group is listed.
    const grouped = searchGroups(open, r).flatMap((group) => group.doors.map((door) => door.href));
    expect(hrefs.sort()).toEqual([...grouped].sort());
  });

  it.each(ROLES)('groups a %s\'s pages in searchGroups\' order', (r) => {
    role = r;
    const dialog = openSearch();
    const expected = searchGroups(buildingMap.visibleDoors(r, { boardSeats: null }), r).map((group) => group.label);
    expect(groupHeadings(dialog)).toEqual(expected);
  });

  it('puts Lab last for the admin and the platform owner, and gives no other role a Lab', () => {
    for (const r of ROLES) {
      role = r;
      const dialog = openSearch();
      const headings = groupHeadings(dialog);
      if (r === 'admin' || r === 'platform_owner') expect(headings[headings.length - 1]).toBe('Lab');
      else expect(headings).not.toContain('Lab');
      cleanup();
    }
  });

  it('follows the door list, not a list of its own: a door visibleDoors hides is never offered', () => {
    const real = buildingMap.visibleDoors;
    jest
      .spyOn(buildingMap, 'visibleDoors')
      .mockImplementation((r, viewer) => real(r, viewer).filter((door) => door.href !== '/coach/drills'));
    const dialog = openSearch();
    expect(offered(dialog)).not.toContain('/coach/drills');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'library' } });
    expect(offered(dialog)).not.toContain('/coach/drills');
    expect(offered(dialog)).toContain('/coach/cue-library');
  });

  it('labels each search result with its Search group', () => {
    const dialog = openSearch();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'drill library' } });
    const row = within(dialog).getByRole('option', { name: /Drill Library/ });
    expect(row.querySelector('.catalog-room-tag')?.textContent).toBe('in Drill Cabinet');
  });
});

describe('board seats fail closed', () => {
  it('offers a board member no seat workspace when the held seats are unknown (the header sits above the board gate)', () => {
    role = 'board';
    const dialog = openSearch();
    expect(offered(dialog).filter((href) => SEAT_DOOR.test(href))).toEqual([]);
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'treasurer' } });
    expect(offered(dialog).filter((href) => SEAT_DOOR.test(href))).toEqual([]);
    // Board Hub, where every seat the member holds is listed, stays.
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: '' } });
    expect(offered(dialog)).toContain('/board');
    expect(offered(dialog)).not.toContain('/admin');
  });

  it('never takes the cached landing seat as a held seat (review: a stale session must not reopen a seat)', () => {
    role = 'board';
    landingSeat = 'treasurer';
    const dialog = openSearch();
    expect(offered(dialog).filter((href) => SEAT_DOOR.test(href))).toEqual([]);
  });

  it('under the board gate, offers only the seats the member holds', () => {
    const gate = jest.requireActual('./BoardRoleGate') as typeof import('./BoardRoleGate');
    jest.spyOn(gate, 'useBoardSession').mockReturnValue({ seats: ['treasurer'] } as never);
    role = 'board';
    const dialog = openSearch();
    expect(offered(dialog).filter((href) => SEAT_DOOR.test(href))).toEqual(['/board/treasurer']);
  });

  it('offers the platform owner every seat workspace, as resolveBoardSeatAccess opens them', () => {
    role = 'platform_owner';
    const dialog = openSearch();
    const seats = offered(dialog).filter((href) => SEAT_DOOR.test(href));
    expect(seats).toHaveLength(8);
  });
});

describe('protections the corridor carried, now Search\'s', () => {
  it('gives a coach no Operations hub in All pages, and keeps the two pages under its prefix', () => {
    const dialog = openSearch();
    const hrefs = offered(dialog);
    expect(hrefs).not.toContain('/operations');
    expect(hrefs).toContain('/operations/wrestling-league');
    expect(hrefs).toContain('/operations/external-competition');
  });

  it('gives an admin the Operations hub', () => {
    role = 'admin';
    expect(offered(openSearch())).toContain('/operations');
  });

  it('gives a signed-out visitor only open pages', () => {
    role = null;
    const dialog = openSearch();
    for (const href of offered(dialog)) {
      expect(buildingMap.BUILDING.find((door) => door.href === href)?.roles).toBe(buildingMap.OPEN);
    }
  });
});

describe('the keyboard walks All pages in the order it is drawn', () => {
  it('moves from the last page of one group to the first of the next', () => {
    const dialog = openSearch();
    const options = Array.from(dialog.querySelectorAll<HTMLElement>('li[role="option"]'));
    const field = within(dialog).getByRole('combobox');
    for (let i = 0; i < options.length - 1; i += 1) {
      fireEvent.keyDown(field, { key: 'ArrowDown' });
    }
    const active = dialog.querySelector('li[role="option"][aria-selected="true"]');
    expect(active).toBe(options[options.length - 1]);
    expect(Number(active?.getAttribute('data-idx'))).toBe(options.length - 1);
  });
});
