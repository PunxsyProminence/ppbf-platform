import {
  ROLE_SESSION_KEY,
  ROLE_SESSION_TTL_MS,
  clearRoleSession,
  createPersistentRoleSession,
  getPilotRoleDestination,
  isRoleSessionAllowed,
  loadAuthoritativeRoleSession,
  mapPilotRoleToClubRole,
  readRoleSession,
  resolveAuthoritativeRoleSession,
} from './roleSession';

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

describe('roleSession display cache', () => {
  test('stores only a bounded role cache with a future expiry', () => {
    const storage = new MemoryStorage();
    installWindow(storage);
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    const session = createPersistentRoleSession('athlete');
    const stored = JSON.parse(storage.getItem(ROLE_SESSION_KEY) ?? '{}') as Record<string, unknown>;

    expect(session).toEqual({ role: 'athlete', expiresAt: 1_000 + ROLE_SESSION_TTL_MS });
    expect(stored).toEqual(session);
    expect(Object.keys(stored).sort()).toEqual(['expiresAt', 'role']);
    expect(storage.getItem('ppbf-club-role')).toBeNull();
  });

  test.each([
    ['missing expiry', JSON.stringify({ role: 'admin' })],
    ['expired', JSON.stringify({ role: 'admin', expiresAt: 999 })],
    ['unsupported role', JSON.stringify({ role: 'platform_owner', expiresAt: 2_000 })],
    ['malformed JSON', '{'],
  ])('rejects and removes a stale cache: %s', (_label, raw) => {
    const storage = new MemoryStorage();
    installWindow(storage);
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    storage.setItem(ROLE_SESSION_KEY, raw);

    expect(readRoleSession()).toBeNull();
    expect(storage.getItem(ROLE_SESSION_KEY)).toBeNull();
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
    expect(readRoleSession()).toBeNull();
    expect(() => clearRoleSession()).not.toThrow();
  });
});

describe('authoritative server role resolution', () => {
  test.each([
    ['platform_owner', 'admin', '/admin/platform'],
    ['organization_admin', 'admin', '/admin'],
    ['admin', 'admin', '/admin'],
    ['coach', 'coach', '/coach/review-queue'],
    ['athlete', 'athlete', '/athlete/dashboard'],
    ['parent', 'parent', '/parent/dashboard'],
    ['board', 'board', '/board'],
  ])('maps supported server role %s explicitly', (serverRole, expectedRole, expectedDestination) => {
    expect(mapPilotRoleToClubRole(serverRole)).toBe(expectedRole);
    expect(getPilotRoleDestination(serverRole)).toBe(expectedDestination);
  });

  test.each(['', 'unknown', 'staff', 'volunteer', null, undefined])(
    'never defaults an unsupported server role to admin: %p',
    (role) => {
      expect(mapPilotRoleToClubRole(role)).toBeNull();
      expect(getPilotRoleDestination(role)).toBeNull();
    },
  );

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
      .resolves.toEqual({ ok: false, reason: 'server_error' });
    await expect(loadAuthoritativeRoleSession('/session', { fetcher: expiredFetcher }))
      .resolves.toEqual({ ok: false, reason: 'unauthenticated' });
  });
});
