/**
 * @jest-environment jsdom
 */

// THE GYM'S ROOM NAMES IN SEARCH AND THE CORRIDOR (lane W4-9, RN-2; OW27-40 A;
// OW27-41 A: Search uses the shown name; Overwatch's Q-E A on #2212: a
// low-ranked match on the room's shown name). The read itself is
// src/client/roomNames.test.tsx; this pins where the names show.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { searchDoors, visibleDoors } from './buildingMap';
import { LAB_HREFS, LAB_LABEL, ROOM_PLACE_LABEL, ROOM_PLACE_ORDER, roomPlaceOf, searchGroups, type RoomPlace } from './roomPlaces';
import { resetRoomNamesForTests } from '@/src/client/roomNames';

let pathname = '/dashboard';
const router = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => pathname,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const COACH = { role: 'coach', expiresAt: 8.64e15 };
const ADMIN = { role: 'admin', expiresAt: 8.64e15 };
let SESSION = COACH;
jest.mock('./roleSession', () => ({
  subscribeRoleSession: () => () => {},
  getRoleSessionSnapshot: () => SESSION,
  clearRoleSession: jest.fn(),
}));

import CardCatalog, { searchGroupLabel } from './CardCatalog';
import Corridor from './Corridor';

// A name no door's own words can reach, even as a subsequence.
const NEW_NAME = 'Qqqq Hall';

/** The first Room Map room the coach has a page in, and that room's pages. */
function coachRoom(): { place: RoomPlace; hrefs: string[] } {
  const doors = visibleDoors('coach');
  for (const place of ROOM_PLACE_ORDER) {
    const hrefs = doors.filter((door) => roomPlaceOf(door.href) === place).map((door) => door.href);
    if (hrefs.length > 0) return { place, hrefs };
  }
  throw new Error('test bug: the coach has no Room Map room');
}

function serveNames(names: Record<string, { name: string; is_default: boolean }>) {
  const fetchMock = jest.fn(async (url: unknown) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/api/pilot/room-names') ? { ok: true, names } : { ok: true }),
  } as unknown as Response));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetRoomNamesForTests();
  pathname = '/dashboard';
  SESSION = COACH;
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('the pure functions', () => {
  test('searchGroups names a Room Map room through placeName; Home and Lab keep theirs', () => {
    const doors = visibleDoors('admin');
    const renamed = searchGroups(doors, 'admin', (place) => `Gym ${place}`);
    for (const group of renamed) {
      if (group.key === 'home') expect(group.label).toBe('Home');
      else if (group.key === 'lab') expect(group.label).toBe(LAB_LABEL);
      else expect(group.label).toBe(`Gym ${group.key}`);
    }
    expect(renamed.some((group) => group.key === 'lab')).toBe(true);
    // Without placeName, the Room Map's own names, as before.
    for (const group of searchGroups(doors, 'admin')) {
      if (group.key !== 'home' && group.key !== 'lab') expect(group.label).toBe(ROOM_PLACE_LABEL[group.key]);
    }
  });

  test('searchGroupLabel reads the gym\'s name for a room, and keeps Home and Lab', () => {
    expect(searchGroupLabel('front-desk', () => 'Lobby')).toBe('Lobby');
    expect(searchGroupLabel('front-desk')).toBe(ROOM_PLACE_LABEL['front-desk']);
    expect(searchGroupLabel('home', () => 'Lobby')).toBe('Home');
    expect(searchGroupLabel('lab', () => 'Lobby')).toBe(LAB_LABEL);
  });

  test('typed Search finds a room\'s pages by its shown name, below every match on a page\'s own words (Q-E A)', () => {
    const { place, hrefs } = coachRoom();
    const roomNameOf = (href: string) => (roomPlaceOf(href) === place ? NEW_NAME : roomPlaceOf(href) ? ROOM_PLACE_LABEL[roomPlaceOf(href)!] : null);
    // Without the room name nothing answers; with it, exactly that room's pages.
    expect(searchDoors('coach', 'qqqq hall')).toEqual([]);
    expect(searchDoors('coach', 'qqqq hall', roomNameOf).map((door) => door.href).sort()).toEqual([...hrefs].sort());
    expect(searchDoors('coach', 'qqqq', roomNameOf).map((door) => door.href).sort()).toEqual([...hrefs].sort());
    // Low-ranked: a page whose own label matches comes before a room-name match.
    const mixed = (href: string) => (href === '/schedule' ? null : 'Schedule Wing');
    const ranked = searchDoors('coach', 'schedule', mixed);
    const firstRoomOnly = ranked.findIndex((door) => !`${door.label} ${door.keywords ?? ''} ${door.href}`.toLowerCase().includes('schedule'));
    const lastOwnWords = ranked.map((door) => `${door.label} ${door.keywords ?? ''} ${door.href}`.toLowerCase().includes('schedule')).lastIndexOf(true);
    expect(firstRoomOnly === -1 || firstRoomOnly > lastOwnWords).toBe(true);
  });

  test('a room\'s old name finds nothing through the room once it is renamed (OW27-41 A)', () => {
    const { place } = coachRoom();
    const oldName = ROOM_PLACE_LABEL[place].toLowerCase();
    const renamedRoom = (href: string) => (roomPlaceOf(href) === place ? NEW_NAME : null);
    // What the old name still finds comes from the pages' own words, exactly as without room names.
    expect(searchDoors('coach', oldName, renamedRoom)).toEqual(searchDoors('coach', oldName));
  });
});

describe('on screen', () => {
  test('Search names the room in the gym\'s words: its All pages heading, its pages\' tags and typed matches', async () => {
    const { place, hrefs } = coachRoom();
    serveNames({ [`place:${place}`]: { name: NEW_NAME, is_default: false } });
    render(<CardCatalog />);
    await settle();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const dialog = screen.getByRole('dialog');
    const headings = Array.from(dialog.querySelectorAll('[data-group]')).map((el) => el.textContent ?? '');
    expect(headings).toContain(NEW_NAME);
    expect(headings).not.toContain(ROOM_PLACE_LABEL[place]);

    const input = dialog.querySelector('input') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: 'qqqq' } });
    });
    const offered = Array.from(dialog.querySelectorAll('li[role="option"] code')).map((code) => code.textContent ?? '');
    expect(offered.sort()).toEqual([...hrefs].sort());
    expect(dialog.textContent).toContain(`in ${NEW_NAME}`);
  });

  test('for the admin, a page filed under Lab is never found by its underlying room\'s name (it shows "Lab", not the room)', async () => {
    SESSION = ADMIN;
    const lab = visibleDoors('admin').map((door) => door.href).filter((href) => LAB_HREFS.has(href) && roomPlaceOf(href));
    expect(lab.length).toBeGreaterThan(0);
    const place = roomPlaceOf(lab[0])!;
    serveNames({ [`place:${place}`]: { name: NEW_NAME, is_default: false } });
    render(<CardCatalog />);
    await settle();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const dialog = screen.getByRole('dialog');
    act(() => {
      fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: 'qqqq' } });
    });
    const offered = Array.from(dialog.querySelectorAll('li[role="option"] code')).map((code) => code.textContent ?? '');
    expect(offered.filter((href) => LAB_HREFS.has(href))).toEqual([]);
    // What it does find is filed under that room, by the name shown.
    for (const href of offered) expect(roomPlaceOf(href)).toBe(place);
  });

  test('the empty-state hint names rooms in the gym\'s words', async () => {
    serveNames({ [`place:${ROOM_PLACE_ORDER[0]}`]: { name: NEW_NAME, is_default: false } });
    render(<CardCatalog />);
    await settle();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const dialog = screen.getByRole('dialog');
    act(() => {
      fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: 'zzzzzzzzzzzz' } });
    });
    expect(dialog.textContent).toContain(`Try a room (${NEW_NAME}, `);
  });

  test('the corridor plate names the room you are in, in the gym\'s words', async () => {
    const { place, hrefs } = coachRoom();
    pathname = hrefs[0];
    serveNames({ [`place:${place}`]: { name: NEW_NAME, is_default: false } });
    render(<Corridor />);
    await settle();
    expect(document.querySelector('.corridor-trigger-lbl')?.textContent).toBe(NEW_NAME);
  });

  test('before the read answers, and when it fails, everything shows the Room Map\'s names', async () => {
    const { place, hrefs } = coachRoom();
    pathname = hrefs[0];
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    render(<Corridor />);
    await settle();
    expect(document.querySelector('.corridor-trigger-lbl')?.textContent).toBe(ROOM_PLACE_LABEL[place]);
  });
});
