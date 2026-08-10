import { NextRequest } from 'next/server';

import { POST } from './route';
import { changeOwnPin } from '@/src/server/pilot/auth';
import { requirePrincipalAllowingPinChange } from '@/src/server/pilot/http';
import { assertChosenPinAllowed, validatePinPolicy } from '@/src/server/pilot/pinPolicy';

/*
  The weak-PIN regression, asserted where it actually broke.

  validatePinPolicy threw 'That PIN is too easy to guess...'. jsonError derived
  status from a message prefix, "That" matched nothing, and the athlete got
  HTTP 500 "Internal server error" -- no indication their PIN was refused, let
  alone why. Every sibling check in the same function began with "PIN" and
  worked, and pinPolicy.ts's own header documented the convention it then broke
  eleven lines later.

  pinPolicy.test.ts asserted `.toThrow('too easy to guess')` -- a substring
  match at the service layer, below jsonError. It passed throughout.

  The mock below deliberately DELEGATES to the real validatePinPolicy rather
  than throwing a hand-written error. If someone reintroduces a plain Error, or
  reworders the message, this test fails -- which a hand-authored fake error
  would not do.
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipalAllowingPinChange: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  changeOwnPin: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipalAllowingPinChange);
const mockChangeOwnPin = jest.mocked(changeOwnPin);

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/auth/change-pin', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'ath-1',
    role: 'athlete' as const,
    organizationId: 'org-1',
    athleteId: 'ATH-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local' as const,
    mustChangePin: true,
  } as never);

  // Mirrors changeOwnPin's real preamble -- both guards, in order -- so the
  // real validators decide what is thrown and the route decides the status.
  // Both are needed: validatePinPolicy deliberately EXEMPTS the issued
  // bootstrap PIN (it has to validate when handed out), and assertChosenPinAllowed
  // is the separate guard that stops an athlete choosing it. Mocking only the
  // first would make '123456' look accepted.
  mockChangeOwnPin.mockImplementation(async (_accountId, _current, next) => {
    validatePinPolicy(next);
    assertChosenPinAllowed(next);
  });
});

describe('POST /api/pilot/auth/change-pin weak-PIN handling', () => {
  test.each(['111111', '222222', '654321', '121212'])(
    'a trivially guessable PIN (%s) returns 400 carrying the guidance, not 500',
    async (weak) => {
      const res = await post({ current_pin: '481902', new_pin: weak });

      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('too easy to guess');
      expect(body.error).not.toBe('Internal server error');
    },
  );

  // The bootstrap PIN takes a different path: validatePinPolicy exempts it,
  // assertChosenPinAllowed refuses it. Both must surface as a usable 400.
  test('choosing the published starting PIN returns 400, not 500', async () => {
    const res = await post({ current_pin: '481902', new_pin: '123456' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('starting PIN');
    expect(body.error).not.toBe('Internal server error');
    expect(body.code).toBe('PIN_IS_DEFAULT_FIRST_LOGIN');
  });

  test('the athlete is told what to avoid, not just that it failed', async () => {
    const body = await (await post({ current_pin: '481902', new_pin: '111111' })).json();

    // The whole point of disclosing this message: it has to be actionable.
    expect(body.error).toContain('repeated digits');
    expect(body.code).toBe('PIN_TRIVIALLY_GUESSABLE');
  });

  test.each([
    ['a non-numeric PIN', 'abcdef'],
    ['a wrong-length PIN', '1234'],
  ])('%s also returns 400 with its own reason', async (_label, bad) => {
    const res = await post({ current_pin: '481902', new_pin: bad });
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toBe('Internal server error');
  });

  // The security property, at the route boundary: a genuine internal fault
  // must still be redacted. Migrating validations onto typed errors must not
  // make it easier to leak one.
  test('an internal failure is still redacted to a generic 500', async () => {
    mockChangeOwnPin.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2'),
    );

    const res = await post({ current_pin: '481902', new_pin: '739154' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
  });
});
