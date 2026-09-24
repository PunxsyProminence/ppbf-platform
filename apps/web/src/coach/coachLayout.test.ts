/**
 * The layout preference, including every way storage can let us down.
 *
 * The cases that matter here are not "does a setter set". They are: a shared
 * gym tablet handing one coach's choice to the next, a browser that refuses to
 * store anything, a value in the store that is not a layout at all, and the
 * window after mount when nobody knows yet who is signed in.
 */

import {
  DEFAULT_COACH_LAYOUT,
  coachLayoutStorageKey,
  isCoachLayoutId,
  otherCoachLayout,
  readCoachLayout,
  writeCoachLayout,
} from './coachLayout';

describe('coachLayout', () => {
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  function useStore(impl: Partial<Storage>) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: impl, configurable: true, writable: true,
    });
  }

  function memoryStore(): Storage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      key: () => null,
      get length() { return map.size; },
    } as unknown as Storage & { map: Map<string, string> };
  }

  afterEach(() => {
    if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults to the board, which is the surface a coach is operating from', () => {
    useStore(memoryStore());
    expect(readCoachLayout('acc_jason')).toBe('board');
    expect(DEFAULT_COACH_LAYOUT).toBe('board');
  });

  it('remembers a choice for the coach who made it', () => {
    useStore(memoryStore());
    writeCoachLayout('acc_jason', 'room');
    expect(readCoachLayout('acc_jason')).toBe('room');
  });

  it('does NOT hand one coach the layout the last coach picked on a shared tablet', () => {
    /* THE REASON THIS FILE IS SCOPED AT ALL. A gym tablet is not one person's
       device. Coach A picks ROOM, signs out, Coach B signs in and must arrive
       at the default rather than inside somebody else's choice. */
    const store = memoryStore();
    useStore(store);

    writeCoachLayout('acc_jason', 'room');
    expect(readCoachLayout('acc_jason')).toBe('room');
    expect(readCoachLayout('acc_mike')).toBe('board');

    // And the two are separate entries, not one overwritten.
    writeCoachLayout('acc_mike', 'board');
    expect(readCoachLayout('acc_jason')).toBe('room');
  });

  it('refuses to persist a choice before it knows whose choice it is', () => {
    /* The account id arrives asynchronously -- CoachWorkspace reads it from
       POST /api/pilot/auth/session -- so for the first moments after mount it
       is the empty string. Writing then would put one coach's preference into
       the slot every not-yet-identified session reads from, which is the
       shared-tablet bleed above wearing a different hat.

       The choice still APPLIES for the current render. Only the remembering
       waits. */
    const store = memoryStore();
    useStore(store);

    expect(writeCoachLayout('', 'room')).toBe(false);
    expect(writeCoachLayout('   ', 'room')).toBe(false);
    expect(store.map.size).toBe(0);
    expect(readCoachLayout('')).toBe('board');
  });

  it('renders the default rather than throwing when the browser refuses to store', () => {
    /* localStorage throws in private mode and in some embedded webviews. A
       tablet that cannot remember anything must still show a board. The
       preference is forgotten; nothing else is. */
    useStore({
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    } as unknown as Storage);

    expect(readCoachLayout('acc_jason')).toBe('board');
    expect(writeCoachLayout('acc_jason', 'room')).toBe(false);
    expect(readCoachLayout('acc_jason')).toBe('board');
  });

  it('survives storage being absent entirely', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readCoachLayout('acc_jason')).toBe('board');
    expect(writeCoachLayout('acc_jason', 'room')).toBe(true);
  });

  it('discards a stored value that is not a layout instead of mounting it', () => {
    /* The key is a string in a shared browser store. An older build may have
       written something else under a similar name, and this value decides which
       component mounts. An unknown value is not a layout; it is noise. */
    const store = memoryStore();
    useStore(store);
    for (const junk of ['floor', 'BOARD', '', 'null', '{"layout":"room"}']) {
      store.map.set(coachLayoutStorageKey('acc_jason'), junk);
      expect(readCoachLayout('acc_jason')).toBe('board');
    }
  });

  it('gives the unknown-account case its own visibly distinct key', () => {
    // 'anon' rather than an empty segment, so the not-yet-known case cannot be
    // mistaken for a real account whose id happens to be nothing.
    expect(coachLayoutStorageKey('acc_42')).toBe('ppbf:coach-layout:v1:acc_42');
    expect(coachLayoutStorageKey('')).toBe('ppbf:coach-layout:v1:anon');
    expect(coachLayoutStorageKey('  ')).toBe('ppbf:coach-layout:v1:anon');
  });

  it('knows a layout id from anything else', () => {
    expect(isCoachLayoutId('board')).toBe(true);
    expect(isCoachLayoutId('room')).toBe(true);
    for (const no of ['Board', 'floor', null, undefined, 0, {}, ['room']]) {
      expect(isCoachLayoutId(no)).toBe(false);
    }
  });

  it('toggles between exactly two positions', () => {
    expect(otherCoachLayout('board')).toBe('room');
    expect(otherCoachLayout('room')).toBe('board');
  });
});
