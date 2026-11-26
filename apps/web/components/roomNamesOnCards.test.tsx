/**
 * @jest-environment jsdom
 */

// THE CARD NAMES IN THE GYM'S WORDS (lane W4-9, RN-3; OW27-15, OW27-40 A;
// Overwatch's Q-A A and Q-G A): the /profile door's label wherever the menus
// print it, and its title; "My Corner"; the mentors heading's two forms; the
// Sparring Log eyebrow's two forms. Search matches the name shown (OW27-41 A).

import fs from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { BUILDING, searchDoors } from './buildingMap';
import { DEFAULT_ROOM_NAMES, resetRoomNamesForTests, roomNameLookup } from '@/src/client/roomNames';
import { CARD_NAME_DEFAULTS, DOOR_LABEL_KEY } from '@/src/shared/roomNames';

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
const SESSION = { role: 'coach', expiresAt: 8.64e15 };
jest.mock('./roleSession', () => ({
  subscribeRoleSession: () => () => {},
  getRoleSessionSnapshot: () => SESSION,
  clearRoleSession: jest.fn(),
}));

import CardCatalog from './CardCatalog';
import Corridor from './Corridor';

const NEW_NAME = 'Qqqq Page';
const PROFILE = BUILDING.find((door) => door.href === '/profile')!;
const WEB = path.resolve(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(WEB, relative), 'utf8');

function serveNames(names: Record<string, { name: string; is_default: boolean }>) {
  global.fetch = jest.fn(async (url: unknown) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith('/api/pilot/room-names') ? { ok: true, names } : { ok: true }),
  } as unknown as Response)) as unknown as typeof fetch;
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
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('the /profile door', () => {
  test('is the one door whose label is a card name, and the lookup reads it', () => {
    expect(DOOR_LABEL_KEY).toEqual({ '/profile': 'card:your-profile' });
    expect(DEFAULT_ROOM_NAMES.door(PROFILE)).toBe('Your Profile');
    expect(roomNameLookup({ 'card:your-profile': NEW_NAME }).door(PROFILE)).toBe(NEW_NAME);
    // Every other door keeps its own label.
    const other = BUILDING.find((door) => door.href === '/schedule')!;
    expect(roomNameLookup({ 'card:your-profile': NEW_NAME }).door(other)).toBe(other.label);
  });

  test('typed Search matches the name shown, and not the old one through the label (OW27-41 A)', () => {
    const renamed = roomNameLookup({ 'card:your-profile': NEW_NAME }).door;
    expect(searchDoors('coach', 'qqqq', undefined, renamed).map((door) => door.href)).toContain('/profile');
    expect(searchDoors('coach', 'qqqq').map((door) => door.href)).not.toContain('/profile');
    expect(searchDoors('coach', 'your profile').map((door) => door.href)[0]).toBe('/profile');
    // The door's own keywords ("profile ...") still find it, as before (OW27-41 A keeps keywords).
    expect(searchDoors('coach', 'your profile', undefined, renamed).map((door) => door.href)).not.toContain('/profile');
    expect(searchDoors('coach', 'profile', undefined, renamed).map((door) => door.href)).toContain('/profile');
  });

  test('Search and the corridor print it in the gym\'s words', async () => {
    serveNames({ 'card:your-profile': { name: NEW_NAME, is_default: false } });
    pathname = '/profile';
    render(<><Corridor /><CardCatalog /></>);
    await settle();
    expect(document.querySelector('.corridor-trigger-here')?.textContent).toBe(NEW_NAME);
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const dialog = screen.getByRole('dialog');
    const row = Array.from(dialog.querySelectorAll('li[role="option"]')).find((li) => li.querySelector('code')?.textContent === '/profile');
    expect(row?.querySelector('b')?.textContent).toBe(NEW_NAME);
    act(() => {
      fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: 'qqqq' } });
    });
    const offered = Array.from(dialog.querySelectorAll('li[role="option"] code')).map((code) => code.textContent);
    expect(offered).toContain('/profile');
  });
});

describe('the pages read their card names through the lookup, and no longer type them', () => {
  test.each([
    ['app/profile/page.tsx', ["names.name('card:your-profile')"], ['"Your Profile"', "'Your Profile'"]],
    ['components/AthleteCorner.tsx', ["names.name('card:my-corner')"], ['>My Corner<']],
    ['components/AthleteAchievements.tsx', ["names.name('card:who-they-train-with')", "names.name('card:who-you-train-with')"], ["'Who they train with'", "'Who you train with'"]],
    ['app/athlete/dashboard/sparring/page.tsx', ["names.name('card:coach-entry')", "names.name('card:your-entry')"], ["'Coach Entry'", "'Your entry'"]],
  ])('%s', (file, reads, typed) => {
    const source = read(file);
    for (const call of reads) expect(source).toContain(call);
    for (const literal of typed) expect(source).not.toContain(literal);
  });

  test('the words they no longer type are the card defaults, so every gym on the defaults sees exactly what it saw', () => {
    expect(CARD_NAME_DEFAULTS['your-profile']).toBe('Your Profile');
    expect(CARD_NAME_DEFAULTS['my-corner']).toBe('My Corner');
    expect(CARD_NAME_DEFAULTS['who-you-train-with']).toBe('Who you train with');
    expect(CARD_NAME_DEFAULTS['who-they-train-with']).toBe('Who they train with');
    expect(CARD_NAME_DEFAULTS['your-entry']).toBe('Your entry');
    expect(CARD_NAME_DEFAULTS['coach-entry']).toBe('Coach Entry');
  });
});

test('the Corner section\'s landmark reads the same name as its heading (Codex P2 on #2216)', () => {
  const source = read('components/AthleteCorner.tsx');
  expect(source).toContain("<section aria-label={names.name('card:my-corner')}");
  expect(source).not.toContain('aria-label="My corner"');
});
