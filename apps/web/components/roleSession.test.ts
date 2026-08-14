import {
  ROLE_SESSION_KEY,
  ROLE_SESSION_TTL_MS,
  clearRoleSession,
  createPersistentRoleSession,
  getPilotRoleDestination,
  isRoleSessionAllowed,
  loadAuthoritativeRoleSession,
  mapPilotRoleToClubRole,
  persistAuthoritativeRoleSession,
  readRoleSession,
  resolveAuthoritativeRoleSession,
} from './roleSession';
import type { ClubRole } from './roleRoutes';
import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWindow(storage: Storage): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      dispatchEvent: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    },
  });
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, 'window');
}

afterEach(() => {
  jest.restoreAllMocks();
  restoreWindow();
});

describe('roleSession in-memory cache (no localStorage writes)', () => {
  test('stores only a bounded in-memory role cache with a future expiry', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    const session = createPersistentRoleSession('athlete');

    expect(session).toEqual({ role: 'athlete', expiresAt: 1_000 + ROLE_SESSION_TTL_MS });
    expect(readRoleSession()).toEqual(session);
    // The role session (and the older legacy key) must never be written to
    // localStorage -- the in-memory cache and the HttpOnly server cookie are
    // the only sources of truth.
    expect(storage.getItem(ROLE_SESSION_KEY)).toBeNull();
    expect(storage.getItem('ppbf-club-role')).toBeNull();
  });

  // platform_owner has no roleRoutes landing card, so an earlier parse set
  // was built without it and threw away a session the login page had just
  // written -- blanking the global header on every ungated page for the
  // owner. Pinned here against the in-memory cache now that storage is gone.
  test('a platform_owner session survives the next read', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    createPersistentRoleSession('platform_owner');

    expect(readRoleSession()).toEqual({ role: 'platform_owner', expiresAt: 1_000 + ROLE_SESSION_TTL_MS });
  });

  test('an expired in-memory session reads as null and clears itself', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    createPersistentRoleSession('admin');

    jest.spyOn(Date, 'now').mockReturnValue(1_000 + ROLE_SESSION_TTL_MS + 1);

    expect(readRoleSession()).toBeNull();
    expect(readRoleSession()).toBeNull();
  });

  // Residual localStorage entries from builds that predate the in-memory
  // cache: nothing reads them back, so a browser that once received a write
  // carries the key forever unless a login or logout purges it. Deliberately
  // exercised on the write/transition paths only -- readRoleSession and
  // getRoleSessionSnapshot must stay pure reads (the latter is the
  // getSnapshot function passed to useSyncExternalStore).
  test('a fresh login purges residual legacy localStorage keys', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    storage.setItem(ROLE_SESSION_KEY, JSON.stringify({ role: 'admin', expiresAt: 9_999 }));
    storage.setItem('ppbf-club-role', 'coach');

    createPersistentRoleSession('athlete');

    expect(storage.getItem(ROLE_SESSION_KEY)).toBeNull();
    expect(storage.getItem('ppbf-club-role')).toBeNull();
  });

  test('logging out purges residual legacy localStorage keys', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    storage.setItem(ROLE_SESSION_KEY, JSON.stringify({ role: 'coach', expiresAt: 9_999 }));
    storage.setItem('ppbf-club-role', 'athlete');

    clearRoleSession();

    expect(storage.getItem(ROLE_SESSION_KEY)).toBeNull();
    expect(storage.getItem('ppbf-club-role')).toBeNull();
    expect(readRoleSession()).toBeNull();
  });

  test('reading the session never touches localStorage at all', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    const removeSpy = jest.spyOn(storage, 'removeItem');
    createPersistentRoleSession('athlete');
    removeSpy.mockClear();

    readRoleSession();

    expect(removeSpy).not.toHaveBeenCalled();
  });

  test('blocked localStorage never turns a valid server login into a client failure', () => {
    const blockedWindow = {
      dispatchEvent: jest.fn(),
    };
    Object.defineProperty(blockedWindow, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: blockedWindow,
    });

    expect(() => createPersistentRoleSession('athlete')).not.toThrow();
    // The in-memory cache still works even though storage is blocked.
    expect(readRoleSession()).toEqual(expect.objectContaining({ role: 'athlete' }));
    expect(() => clearRoleSession()).not.toThrow();
    expect(readRoleSession()).toBeNull();
  });
});

describe('authoritative server role resolution', () => {
  test.each([
    ['platform_owner', 'platform_owner', '/admin/platform'],
    ['organization_admin', 'admin', '/admin'],
    ['admin', 'admin', '/admin'],
    ['coach', 'coach', '/coach/environment/intake-router'],
    ['athlete', 'athlete', '/athlete/dashboard'],
    ['parent', 'parent', '/parent/dashboard'],
    ['board', 'board', '/board'],
    ['staff', 'staff', '/workspace'],
    ['volunteer', 'volunteer', '/workspace'],
  ])('maps supported server role %s explicitly', (serverRole, expectedRole, expectedDestination) => {
    expect(mapPilotRoleToClubRole(serverRole)).toBe(expectedRole);
    expect(getPilotRoleDestination(serverRole)).toBe(expectedDestination);
  });

  // An invited staff member or volunteer authenticates successfully and has no
  // PIN fallback, so an unroutable role here is the difference between a
  // working account and one that can never enter the app.
  test.each(['staff', 'volunteer'])('a %s session survives storage and lands on its own workspace', (serverRole) => {
    const storage = new MemoryStorage();
    installWindow(storage);

    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: serverRole,
      auth_provider: 'microsoft',
    });

    expect(resolution).toMatchObject({ ok: true, destination: '/workspace' });
    if (resolution.ok) {
      createPersistentRoleSession(resolution.session.role);
    }
    expect(readRoleSession()?.role).toBe(serverRole);
  });

  test.each(['', 'unknown', null, undefined])(
    'never defaults an unsupported server role to admin: %p',
    (role) => {
      expect(mapPilotRoleToClubRole(role)).toBeNull();
      expect(getPilotRoleDestination(role)).toBeNull();
    },
  );

  // The whole point of the split: these two must stop being interchangeable.
  // While both mapped to 'admin', every page guard was wrong in one direction
  // or the other -- an organization_admin was locked out of /coach/video-analysis
  // even though the upload API admits that role, and Omega rendered admin
  // pages whose API then refused it.
  test('platform_owner and organization_admin are no longer the same club role', () => {
    expect(mapPilotRoleToClubRole('platform_owner'))
      .not.toBe(mapPilotRoleToClubRole('organization_admin'));
  });

  test('the legacy admin alias still resolves with the organization admins', () => {
    // roleEquals() treats 'admin' and 'organization_admin' as the same server
    // role while legacy rows migrate, so the client must not split them.
    expect(mapPilotRoleToClubRole('admin')).toBe(mapPilotRoleToClubRole('organization_admin'));
  });

  test('an admin-gated page admits organization_admin but not platform_owner', () => {
    // isRoleSessionAllowed is what every page guard runs. Pinned as behavior
    // rather than as a mapping detail, because this is the property the
    // guards actually depend on.
    const adminOnly: ClubRole[] = ['admin'];
    const orgAdmin = mapPilotRoleToClubRole('organization_admin') as ClubRole;
    const omega = mapPilotRoleToClubRole('platform_owner') as ClubRole;

    expect(adminOnly.includes(orgAdmin)).toBe(true);
    expect(adminOnly.includes(omega)).toBe(false);
  });

  test('accepts athlete local auth but requires Microsoft for every privileged role', () => {
    expect(resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
    })).toMatchObject({ ok: true, session: { role: 'athlete' } });

    expect(resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'coach',
      auth_provider: 'ppbf_local',
    })).toEqual({ ok: false, reason: 'privileged_auth_required' });
  });

  test('server truth replaces a mismatched local role instead of inheriting it', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    createPersistentRoleSession('admin');

    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
    });

    expect(readRoleSession()?.role).toBe('admin');
    expect(resolution).toMatchObject({
      ok: true,
      session: { role: 'athlete' },
      destination: '/athlete/dashboard',
    });
    if (resolution.ok) {
      createPersistentRoleSession(resolution.session.role);
    }
    expect(readRoleSession()?.role).toBe('athlete');
  });

  test('unauthenticated and unknown-role server responses fail closed', () => {
    expect(resolveAuthoritativeRoleSession({ authenticated: false }))
      .toEqual({ ok: false, reason: 'unauthenticated' });
    expect(resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'future_super_admin',
      auth_provider: 'microsoft',
    })).toEqual({ ok: false, reason: 'unsupported_role' });
  });

  test('exact server-derived role controls page access without an admin wildcard', () => {
    const admin = { role: 'admin', expiresAt: Date.now() + 1_000 } as const;
    expect(isRoleSessionAllowed(admin, ['admin'])).toBe(true);
    expect(isRoleSessionAllowed(admin, ['athlete'])).toBe(false);
  });

  test('loads server truth with cookie credentials and no caching', async () => {
    const fetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        authenticated: true,
        role: 'organization_admin',
        auth_provider: 'microsoft',
      }),
    }) as Response);

    const resolution = await loadAuthoritativeRoleSession('/api/pilot/auth/session', { fetcher });

    expect(fetcher).toHaveBeenCalledWith('/api/pilot/auth/session', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    }));
    expect(resolution).toMatchObject({
      ok: true,
      session: { role: 'admin' },
      destination: '/admin',
    });
  });

  test('a seat cannot make an unroutable role routable', async () => {
    // The seat refines where a board member lands. It is not an authority, so
    // it must never be the thing that lets an unknown role into the app.
    expect(resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'future_board_admin',
      auth_provider: 'microsoft',
      board_seat: 'president',
    })).toEqual({ ok: false, reason: 'unsupported_role' });
    expect(getPilotRoleDestination('future_board_admin', 'president')).toBeNull();
  });

  test('distinguishes a retryable server failure from an expired session', async () => {
    const serverErrorFetcher = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as Response);
    const expiredFetcher = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: false }),
    }) as Response);

    await expect(loadAuthoritativeRoleSession('/session', { fetcher: serverErrorFetcher }))
      .resolves.toEqual({ ok: false, reason: 'server_error', statusCode: 503 });
    await expect(loadAuthoritativeRoleSession('/session', { fetcher: expiredFetcher }))
      .resolves.toEqual({ ok: false, reason: 'unauthenticated' });
  });
});

describe('the board seat routes a member to their own page', () => {
  test.each(boardSeatConfigs.map((seat) => seat.slug))(
    'a member holding the %s seat lands on it',
    (seat) => {
      expect(getPilotRoleDestination('board', seat)).toBe(`/board/${seat}`);
    },
  );

  test.each([undefined, null, '', 'vice-president', 'president ', 'BOARD', 42])(
    'a board member with no seat the app can open lands on the shared board workspace: %p',
    (seat) => {
      expect(getPilotRoleDestination('board', seat)).toBe('/board');
    },
  );

  test('a seat changes nothing for any other role', () => {
    expect(getPilotRoleDestination('coach', 'treasurer')).toBe('/coach/environment/intake-router');
    expect(getPilotRoleDestination('organization_admin', 'president')).toBe('/admin');
    expect(getPilotRoleDestination('athlete', 'president')).toBe('/athlete/dashboard');
  });

  test('the server-reported seat decides the destination, and the role stays board', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'board',
      auth_provider: 'microsoft',
      board_seat: 'treasurer',
    });

    expect(resolution).toMatchObject({
      ok: true,
      destination: '/board/treasurer',
      session: { role: 'board', boardSeat: 'treasurer' },
    });
  });

  // The seat is identity, not authority: every page guard keeps asking for
  // 'board', and a seat holder must satisfy it exactly as a seatless one does.
  test('a seated session is still an ordinary board session to every page guard', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'board',
      auth_provider: 'microsoft',
      board_seat: 'president',
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(isRoleSessionAllowed(resolution.session, ['board'])).toBe(true);
    expect(isRoleSessionAllowed(resolution.session, ['admin'])).toBe(false);
    expect(mapPilotRoleToClubRole('board')).toBe('board');
  });

  test('a board member with no seat still lands on the shared board workspace', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'board',
      auth_provider: 'microsoft',
    });

    expect(resolution).toMatchObject({ ok: true, destination: '/board' });
    if (resolution.ok) {
      expect(resolution.session.boardSeat).toBeUndefined();
    }
  });

  test('a seat claimed by a non-board session is ignored entirely', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'coach',
      auth_provider: 'microsoft',
      board_seat: 'president',
    });

    expect(resolution).toMatchObject({ ok: true, destination: '/coach/environment/intake-router' });
    if (resolution.ok) {
      expect(resolution.session.boardSeat).toBeUndefined();
    }
  });
});

describe('the seat survives the display cache', () => {
  test('a stored board session carries its seat back out', () => {
    const storage = new MemoryStorage();
    installWindow(storage);

    createPersistentRoleSession('board', 'treasurer');

    expect(readRoleSession()).toMatchObject({ role: 'board', boardSeat: 'treasurer' });
  });

  test('a resolved session round-trips its seat without the caller unpacking it', () => {
    const storage = new MemoryStorage();
    installWindow(storage);

    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'board',
      auth_provider: 'microsoft',
      board_seat: 'safety-director',
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    persistAuthoritativeRoleSession(resolution.session);

    expect(readRoleSession()).toMatchObject({ role: 'board', boardSeat: 'safety-director' });
  });

  test.each(['admin', 'coach', 'athlete', 'platform_owner'] as ClubRole[])(
    'no seat is kept for a %s session even if one is offered',
    (role) => {
      createPersistentRoleSession(role, 'president');

      const session = readRoleSession();
      expect(session?.role).toBe(role);
      expect(session?.boardSeat).toBeUndefined();
    },
  );

  test('a seatless board session keeps no seat key at all', () => {
    createPersistentRoleSession('board');

    const session = readRoleSession();
    expect(session?.role).toBe('board');
    expect(session?.boardSeat).toBeUndefined();
  });

  // Dropping an unusable seat rather than the whole cache: a seat the app
  // cannot render is worth nothing, but signing a valid board member out over
  // it costs them the workspace they are authenticated for.
  test('an unrecognized seat offered at create time is discarded and the session survives', () => {
    createPersistentRoleSession('board', 'vice-president');

    expect(readRoleSession()).toMatchObject({ role: 'board' });
    expect(readRoleSession()?.boardSeat).toBeUndefined();
  });
});
