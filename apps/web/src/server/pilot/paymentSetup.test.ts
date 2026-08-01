import { resolvePaymentSetupStatus } from './paymentSetup';

// The whole value of this status is that it goes away by itself. A checklist
// that has to be turned off by hand is one that eventually lies -- so the
// cases that matter are the two ends: nothing done, and everything done.

const KEYS = ['PPBF_PAYMENTS_ENABLED', 'PAYMENT_GIVING_ACCOUNT_ID', 'PAYMENT_PROGRAM_ACCOUNT_ID'] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original[key];
    }
  }
});

describe('payment setup status', () => {
  test('nothing configured: not ready, both lanes unconnected, steps to follow', () => {
    const status = resolvePaymentSetupStatus();

    expect(status.ready).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.lanes).toEqual({ giving: 'not_connected', program: 'not_connected' });
    expect(status.remainingSteps.length).toBeGreaterThan(0);
    // Giving is named first because its 501(c)(3) verification is the slow half.
    expect(status.remainingSteps[0]).toContain('Giving');
  });

  test('one lane connected still leaves the other one named', () => {
    process.env.PAYMENT_GIVING_ACCOUNT_ID = 'acct_giving';

    const status = resolvePaymentSetupStatus();

    expect(status.lanes.giving).toBe('connected');
    expect(status.lanes.program).toBe('not_connected');
    expect(status.remainingSteps.join(' ')).toContain('Program');
    expect(status.remainingSteps.join(' ')).not.toContain('Connect the Giving');
  });

  test('both lanes connected but payments off is NOT ready', () => {
    // Connected is not the same as switched on: compliance sign-off and the
    // staging proof sit between them, and reporting ready here would let the
    // prompt vanish before the gate it exists to describe.
    process.env.PAYMENT_GIVING_ACCOUNT_ID = 'acct_giving';
    process.env.PAYMENT_PROGRAM_ACCOUNT_ID = 'acct_program';

    const status = resolvePaymentSetupStatus();

    expect(status.ready).toBe(false);
    expect(status.remainingSteps.join(' ')).toContain('compliance sign-off');
  });

  test('fully set up: ready, and no steps left for the console to render', () => {
    process.env.PPBF_PAYMENTS_ENABLED = 'true';
    process.env.PAYMENT_GIVING_ACCOUNT_ID = 'acct_giving';
    process.env.PAYMENT_PROGRAM_ACCOUNT_ID = 'acct_program';

    const status = resolvePaymentSetupStatus();

    expect(status.ready).toBe(true);
    expect(status.remainingSteps).toEqual([]);
  });

  test('the flag only counts when it is exactly true', () => {
    process.env.PPBF_PAYMENTS_ENABLED = 'TRUE';
    expect(resolvePaymentSetupStatus().enabled).toBe(false);

    process.env.PPBF_PAYMENTS_ENABLED = '1';
    expect(resolvePaymentSetupStatus().enabled).toBe(false);
  });

  test('a blank account id is not a connection', () => {
    process.env.PAYMENT_GIVING_ACCOUNT_ID = '   ';
    expect(resolvePaymentSetupStatus().lanes.giving).toBe('not_connected');
  });
});
