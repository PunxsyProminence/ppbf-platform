import type { NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requirePrincipalAllowingPinChange } from './http';
import { resolvePrincipal } from './auth';
import {
  LEGACY_SHARED_FIRST_LOGIN_PIN,
  assertChosenPinAllowed,
  generateStartingPin,
  validatePinPolicy,
} from './pinPolicy';
import { resolveAuthoritativeRoleSession } from '../../../components/roleSession';

jest.mock('./auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.Mock;

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'nneale',
    role: 'athlete',
    organizationId: 'punxsy_prominence',
    athleteId: 'Neeko-001',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    mustChangePin: false,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

const request = {} as NextRequest;

// Starting PINs are generated per athlete. The generator is the credential
// source for every child account, so its output has to satisfy the same policy
// every other PIN does -- a generator that could emit 111111 would be handing
// out the first PIN an attacker tries.
describe('the generated starting PIN', () => {
  test('always satisfies the PIN policy, so nothing downstream needs a special case', () => {
    for (let i = 0; i < 500; i += 1) {
      const pin = generateStartingPin();
      expect(() => validatePinPolicy(pin)).not.toThrow();
    }
  });

  test('is six digits', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateStartingPin()).toMatch(/^\d{6}$/);
    }
  });

  // The whole point of the change: two accounts provisioned in one batch must
  // not share a PIN. This cannot prove randomness, but a generator returning a
  // constant -- the bug that would silently recreate the old shared-PIN
  // problem -- fails it immediately.
  test('does not return the same PIN every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(generateStartingPin());
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  test('never emits the old shared PIN', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateStartingPin()).not.toBe(LEGACY_SHARED_FIRST_LOGIN_PIN);
    }
  });
});

// A PIN the platform ISSUED must not be re-choosable by the athlete: choosing it
// clears must_change_pin while leaving the account on a credential an admin has
// seen, written down, and possibly read aloud.
describe('an issued PIN can never be chosen', () => {
  test('choosing the PIN you were just issued is refused', () => {
    expect(() => assertChosenPinAllowed('428913', '428913'))
      .toThrow('PIN cannot be the one you were given to sign in with. Choose a different one.');
  });

  test('the old shared PIN is refused outright, with no current PIN needed', () => {
    expect(() => assertChosenPinAllowed(LEGACY_SHARED_FIRST_LOGIN_PIN))
      .toThrow('PIN cannot be the old shared starting PIN. Choose a different one.');
  });

  // It is also refused one layer earlier now. The old code exempted it from
  // validatePinPolicy so the shared-PIN reset could issue it; nothing issues it
  // any more, so the exemption is gone. It is an ascending run and the generic
  // rule would catch it, but the specific message is the one that names the
  // situation of someone still sitting on that PIN.
  test('the old shared PIN no longer passes the policy either', () => {
    expect(() => validatePinPolicy(LEGACY_SHARED_FIRST_LOGIN_PIN))
      .toThrow('PIN cannot be the starting PIN everyone is given. Choose a different one.');
  });

  // The refusal is only useful if the athlete sees it. This used to depend on
  // the message beginning with "PIN", which jsonError prefix-matched to a 400;
  // anything else came back as a 500 with the reason stripped out. It now
  // throws ValidationError, so the status comes from the type and rewording
  // the message can no longer silence it.
  //
  // The body also carries `code` now. That is the point of the machine code
  // moving out of the message prefix: a client can branch on
  // PIN_IS_DEFAULT_FIRST_LOGIN without string-matching prose, which is the
  // same fragility this change removes on the server side.
  test('the refusal reaches the athlete as a 400 carrying the reason', async () => {
    let refusal: unknown;
    try {
      assertChosenPinAllowed('428913', '428913');
    } catch (error) {
      refusal = error;
    }

    const response = jsonError(refusal);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'PIN cannot be the one you were given to sign in with. Choose a different one.',
      code: 'PIN_IS_ISSUED_PIN',
    });
  });

  test('surrounding whitespace does not sneak either past', () => {
    expect(() => assertChosenPinAllowed('  428913 ', '428913')).toThrow('you were given');
    expect(() => assertChosenPinAllowed(`  ${LEGACY_SHARED_FIRST_LOGIN_PIN} `)).toThrow('old shared starting PIN');
  });

  test('a genuinely different policy-valid PIN is allowed', () => {
    expect(() => assertChosenPinAllowed('428913', '571902')).not.toThrow();
  });
});

describe('requirePrincipal blocks an account still on the bootstrap PIN', () => {
  test('rejects, so a route cannot serve data to a starting-PIN session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: true }));

    await expect(requirePrincipal(request)).rejects.toThrow('Forbidden: PIN change required');
  });

  test('allows the same account once it has chosen its own PIN', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: false }));

    await expect(requirePrincipal(request)).resolves.toMatchObject({ accountId: 'nneale' });
  });

  // The field is optional on PilotPrincipal so test fixtures elsewhere need not
  // restate it. An absent value must read as "not mid-bootstrap", or every
  // existing route test would start failing.
  test('treats an absent flag as not mid-bootstrap', async () => {
    const withoutFlag = principal();
    delete (withoutFlag as Record<string, unknown>).mustChangePin;
    mockResolvePrincipal.mockResolvedValueOnce(withoutFlag);

    await expect(requirePrincipal(request)).resolves.toMatchObject({ accountId: 'nneale' });
  });

  test('still rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    await expect(requirePrincipal(request)).rejects.toThrow('Unauthorized');
  });
});

describe('requirePrincipalAllowingPinChange', () => {
  test('admits the bootstrap session, so the PIN can actually be changed', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ mustChangePin: true }));

    await expect(requirePrincipalAllowingPinChange(request)).resolves.toMatchObject({
      accountId: 'nneale',
      mustChangePin: true,
    });
  });

  test('does not admit an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    await expect(requirePrincipalAllowingPinChange(request)).rejects.toThrow('Unauthorized');
  });
});

describe('client-side session routing', () => {
  test('sends a bootstrap session to the PIN change rather than to a dashboard', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: true,
    });

    expect(resolution).toEqual({ ok: false, reason: 'pin_change_required' });
  });

  // The distinction matters: 'unauthenticated' routes to /login, and signing
  // in again would land right back in the same state -- a loop.
  test('does not report a bootstrap session as unauthenticated', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: true,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).not.toBe('unauthenticated');
  });

  test('routes normally once the athlete has their own PIN', () => {
    const resolution = resolveAuthoritativeRoleSession({
      authenticated: true,
      role: 'athlete',
      auth_provider: 'ppbf_local',
      must_change_pin: false,
    });

    expect(resolution.ok).toBe(true);
  });
});
