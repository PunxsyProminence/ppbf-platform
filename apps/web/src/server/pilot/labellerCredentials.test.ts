/**
 * @jest-environment node
 */
import { ANNOTATOR_ROLES } from '@/app/api/pilot/calibration/annotatorGate';

import { queryOne } from './db';
import {
  assertLabellerPinAllowed,
  LABELLER_ACCOUNT_ROLES,
  labellerPinTargetKey,
  normalizeLabellerDisplayName,
  verifyLabellerPin,
} from './labellerCredentials';
import { clearRateLimit, recordFailedAttempt } from './rateLimit';
import { hashPin, verifyPin } from './security';

/*
  The rules and the limiter wiring. Who is eligible, and what the table
  holds, are proven against real Postgres in labellerCredentials.pg.test.ts.
*/

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./security', () => {
  const actual = jest.requireActual('./security');
  return { ...actual, verifyPin: jest.fn(actual.verifyPin) };
});

const mockQueryOne = jest.mocked(queryOne);
const mockVerifyPin = jest.mocked(verifyPin);

const ORG = 'org-pp';
const COACH = 'coach-a';
const STATION_KEY = 'labeller_pin_station:station-1';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('the PIN rule', () => {
  it.each(['2580', '1357', '0102', '9021', '1123'])('admits %s', (pin) => {
    expect(() => assertLabellerPinAllowed(pin)).not.toThrow();
  });

  it.each([['123'], ['12345'], ['12a4'], [' 2580'], ['2580 '], ['٢٥٨٠'], [2580], [null], [undefined]])(
    'refuses %p as not four digits',
    (pin) => {
      expect(() => assertLabellerPinAllowed(pin)).toThrow(expect.objectContaining({ code: 'LABELLER_PIN_FORMAT' }));
    },
  );

  // Jason, 2026-10-03: "B" -- any four digits, the easy ones included.
  it('admits every one of the 10,000 four-digit PINs', () => {
    for (let n = 0; n < 10_000; n += 1) {
      expect(() => assertLabellerPinAllowed(String(n).padStart(4, '0'))).not.toThrow();
    }
  });
});

describe('the picker name', () => {
  it('trims and keeps a name of 1 to 40 characters', () => {
    expect(normalizeLabellerDisplayName('  Coach Mike ')).toBe('Coach Mike');
    expect(normalizeLabellerDisplayName('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it.each([[''], ['   '], [null], [42]])('refuses %p as missing', (value) => {
    expect(() => normalizeLabellerDisplayName(value)).toThrow(expect.objectContaining({ code: 'LABELLER_NAME_REQUIRED' }));
  });

  it('refuses 41 characters', () => {
    expect(() => normalizeLabellerDisplayName('x'.repeat(41))).toThrow(expect.objectContaining({ code: 'LABELLER_NAME_TOO_LONG' }));
  });

  it.each([['newline', 'Mi\nke'], ['C1 control', 'Mi\u0085ke'], ['zero-width space', 'Mi​ke'], ['direction override', 'Mi‮ke']])(
    'refuses a %s',
    (_label, name) => {
      expect(() => normalizeLabellerDisplayName(name)).toThrow(expect.objectContaining({ code: 'LABELLER_NAME_INVALID' }));
    },
  );

  it('keeps accented and non-Latin names', () => {
    expect(normalizeLabellerDisplayName('José Núñez')).toBe('José Núñez');
    expect(normalizeLabellerDisplayName('コーチ')).toBe('コーチ');
  });
});

describe('who may hold a labelling PIN', () => {
  it('is ANNOTATOR_ROLES plus the legacy admin alias, and nothing else', () => {
    expect([...LABELLER_ACCOUNT_ROLES].sort()).toEqual([...ANNOTATOR_ROLES, 'admin'].sort());
  });
});

describe('verifyLabellerPin and the limiter', () => {
  let storedHash: string;
  const targetKey = labellerPinTargetKey(ORG, COACH);

  beforeAll(async () => {
    storedHash = await hashPin('2580');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    clearRateLimit(targetKey);
    clearRateLimit(STATION_KEY);
    mockQueryOne.mockResolvedValue({ account_id: COACH, display_name: 'Coach A', pin_hash: storedHash });
  });

  function verify(pin: unknown) {
    return verifyLabellerPin({ organizationId: ORG, accountId: COACH, pin, extraLimiterKeys: [STATION_KEY] });
  }

  it('returns the picker entry for the right PIN, never the hash', async () => {
    await expect(verify('2580')).resolves.toEqual({ account_id: COACH, display_name: 'Coach A' });
  });

  it('refuses a wrong PIN with the one generic answer', async () => {
    expect(await codeOf(verify('2581'))).toBe('LABELLER_PIN_REFUSED');
  });

  it('refuses an unknown or ineligible pick the same way, after the same scrypt', async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await codeOf(verify('2580'))).toBe('LABELLER_PIN_REFUSED');
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed PIN without matching it against anything', async () => {
    expect(await codeOf(verify('25800'))).toBe('LABELLER_PIN_REFUSED');
    clearRateLimit(targetKey);
    clearRateLimit(STATION_KEY);
    expect(await codeOf(verify(2580))).toBe('LABELLER_PIN_REFUSED');
  });

  it('makes the next attempt wait after a wrong one, on the labeller bucket', async () => {
    expect(await codeOf(verify('1111'))).toBe('LABELLER_PIN_REFUSED');
    expect(await codeOf(verify('2580'))).toBe('LABELLER_PIN_SLOW_DOWN');
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('makes a pick wait while the station bucket is blocked, whoever is picked', async () => {
    recordFailedAttempt(STATION_KEY);
    expect(await codeOf(verify('2580'))).toBe('LABELLER_PIN_SLOW_DOWN');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('lets exactly one of many simultaneous guesses run', async () => {
    const results = await Promise.all(['1111', '2222', '3333', '4444', '5555'].map((pin) => codeOf(verify(pin))));
    expect(results.filter((code) => code === 'LABELLER_PIN_REFUSED')).toHaveLength(1);
    expect(results.filter((code) => code === 'LABELLER_PIN_SLOW_DOWN')).toHaveLength(4);
  });

  it('clears the labeller bucket on the right PIN, and never the station bucket', async () => {
    // Labeller bucket alone: a right PIN is refunded, so the next is not made to wait.
    expect(await codeOf(verifyLabellerPin({ organizationId: ORG, accountId: COACH, pin: '2580' }))).toBe('ACCEPTED');
    expect(await codeOf(verifyLabellerPin({ organizationId: ORG, accountId: COACH, pin: '2580' }))).toBe('ACCEPTED');

    // With the station bucket: the right PIN does not refund it, so someone
    // at the tablet cannot wipe the station's count with their own PIN.
    expect(await codeOf(verify('2580'))).toBe('ACCEPTED');
    expect(await codeOf(verify('2580'))).toBe('LABELLER_PIN_SLOW_DOWN');
  });
});
