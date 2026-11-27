/**
 * @jest-environment jsdom
 */

import { act, cleanup, render, screen } from '@testing-library/react';

import { DEFAULT_ROOM_NAMES, resetRoomNamesForTests, roomNameLookup, useRoomNames } from './roomNames';
import { ROOM_NAME_DEFAULTS } from '@/src/shared/roomNames';

/*
 * The browser's room names (lane W4-9, RN-2): one read per sign-in, shared by
 * every screen; the defaults until it answers, when signed out, and when it
 * fails; only keys on the list the gym has changed are taken from the answer.
 */

let session: { role: string; expiresAt: number } | null = null;
const sessionListeners = new Set<() => void>();
jest.mock('@/components/roleSession', () => ({
  subscribeRoleSession: (listener: () => void) => {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  },
  getRoleSessionSnapshot: () => session,
}));

function signIn(role: string, expiresAt: number) {
  act(() => {
    session = { role, expiresAt };
    for (const listener of sessionListeners) listener();
  });
}

function answer(names: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ ok: true, names }) } as unknown as Response;
}

function Probe({ id }: { id: string }) {
  const names = useRoomNames();
  return <p data-testid={id}>{`${names.place('front-desk')}|${names.room('clinic')}|${names.name('card:my-corner')}`}</p>;
}

const DEFAULTS_TEXT = `${ROOM_NAME_DEFAULTS['place:front-desk']}|${ROOM_NAME_DEFAULTS['room:clinic']}|${ROOM_NAME_DEFAULTS['card:my-corner']}`;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetRoomNamesForTests();
  session = { role: 'coach', expiresAt: 1_000 };
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('the lookup falls back to the default for any name the gym has not changed', () => {
  const lookup = roomNameLookup({ 'place:front-desk': 'Lobby' });
  expect(lookup.place('front-desk')).toBe('Lobby');
  expect(lookup.place('floor')).toBe(ROOM_NAME_DEFAULTS['place:floor']);
  expect(lookup.room('office')).toBe(ROOM_NAME_DEFAULTS['room:office']);
  expect(DEFAULT_ROOM_NAMES.name('card:coach-entry')).toBe('Coach Entry');
});

test('shows the defaults until the read answers, then the gym\'s names; two screens share one read', async () => {
  let release: (response: Response) => void = () => {};
  const fetchMock = jest.fn<Promise<Response>, [unknown, unknown?]>(() => new Promise<Response>((resolve) => { release = resolve; }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<><Probe id="a" /><Probe id="b" /></>);
  await settle();
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/pilot\/room-names$/);
  expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: 'include', cache: 'no-store' });

  await act(async () => {
    release(answer({
      'place:front-desk': { name: 'Lobby', is_default: false },
      'room:clinic': { name: 'Treatment Room', is_default: false },
      'card:my-corner': { name: 'My Corner', is_default: true },
    }));
  });
  await settle();
  expect(screen.getByTestId('a').textContent).toBe('Lobby|Treatment Room|My Corner');
  expect(screen.getByTestId('b').textContent).toBe('Lobby|Treatment Room|My Corner');
});

test('signed out, nothing is read and the defaults show', async () => {
  session = null;
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<Probe id="a" />);
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);
});

test('a new sign-in reads again, and a sign-out drops the last gym\'s names', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(answer({ 'place:front-desk': { name: 'Lobby', is_default: false } }))
    .mockResolvedValueOnce(answer({ 'place:front-desk': { name: 'Reception', is_default: false } }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent?.startsWith('Lobby|')).toBe(true);

  act(() => {
    session = null;
    for (const listener of sessionListeners) listener();
  });
  await settle();
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);

  signIn('parent', 2_000);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('a').textContent?.startsWith('Reception|')).toBe(true);
});

test('a route re-verifying the same sign-in (a fresh expiresAt) neither reads again nor drops the names (Codex P2 on #2215)', async () => {
  const fetchMock = jest.fn().mockResolvedValue(answer({ 'place:front-desk': { name: 'Lobby', is_default: false } }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent?.startsWith('Lobby|')).toBe(true);

  // RoleSessionGate mints a fresh session object with a new expiresAt on every gated route.
  signIn('coach', 9_999);
  await settle();
  expect(screen.getByTestId('a').textContent?.startsWith('Lobby|')).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a sign-out drops the names even with no screen mounted, so the next same-role sign-in reads its own gym (Codex P1 on #2215)', async () => {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(answer({ 'place:front-desk': { name: 'Lobby', is_default: false } }))
    .mockResolvedValueOnce(answer({ 'place:front-desk': { name: 'Reception', is_default: false } }));
  global.fetch = fetchMock as unknown as typeof fetch;

  const first = render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent?.startsWith('Lobby|')).toBe(true);
  // The header unmounts the screens that show names as soon as the session ends.
  first.unmount();
  act(() => {
    session = null;
    for (const listener of sessionListeners) listener();
  });
  // Another account, the same role, on the same device.
  signIn('coach', 1_000);
  render(<Probe id="b" />);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('b').textContent?.startsWith('Reception|')).toBe(true);
});

test('after a failed read, a screen mounting 30 s or more later reads again, and not sooner (Q-J A on #2215)', async () => {
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const fetchMock = jest.fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(answer({ 'place:front-desk': { name: 'Lobby', is_default: false } }));
  global.fetch = fetchMock as unknown as typeof fetch;

  const first = render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);
  first.unmount();

  now += 10_000;
  const second = render(<Probe id="b" />);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('b').textContent).toBe(DEFAULTS_TEXT);
  second.unmount();

  now += 20_000;
  render(<Probe id="c" />);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('c').textContent?.startsWith('Lobby|')).toBe(true);
});

test('an answer that arrives after the person signed out is not shown to whoever comes next', async () => {
  let release: (response: Response) => void = () => {};
  const fetchMock = jest.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
    .mockImplementationOnce(() => new Promise<Response>(() => {}));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<Probe id="a" />);
  await settle();
  signIn('athlete', 3_000);
  await settle();
  await act(async () => {
    release(answer({ 'place:front-desk': { name: 'Lobby', is_default: false } }));
  });
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);
});

test.each([
  ['a refused read', () => Promise.resolve({ ok: false, status: 403, json: async () => ({ ok: false }) } as unknown as Response)],
  ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['a fetch that throws as it is called', () => { throw new TypeError('no network'); }],
  ['an answer that is not names', () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, names: 'Lobby' }) } as unknown as Response)],
])('%s leaves the defaults', async (_label, impl) => {
  global.fetch = jest.fn(impl) as unknown as typeof fetch;
  render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent).toBe(DEFAULTS_TEXT);
});

test('only keys on the list, changed by the gym, are taken from the answer', async () => {
  global.fetch = jest.fn().mockResolvedValue(answer({
    'place:front-desk': { name: 'Lobby', is_default: false },
    'place:old-gym': { name: 'Old Gym', is_default: false },
    'room:clinic': { name: 7, is_default: false },
    'card:my-corner': { name: 'My Space' },
  })) as unknown as typeof fetch;
  render(<Probe id="a" />);
  await settle();
  expect(screen.getByTestId('a').textContent).toBe(`Lobby|${ROOM_NAME_DEFAULTS['room:clinic']}|${ROOM_NAME_DEFAULTS['card:my-corner']}`);
});
