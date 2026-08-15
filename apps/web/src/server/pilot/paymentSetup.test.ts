import { resolvePaymentSetupStatus } from './paymentSetup';
import { getConnectedLanes, readPaymentPlatformConfig } from './paymentConnect';

// The whole value of this status is that it goes away by itself. A checklist
// that has to be turned off by hand is one that eventually lies -- so the
// cases that matter are the two ends: nothing done, and everything done.
// Connected lanes now come from pilot.payment_accounts (via paymentConnect),
// not from configuration -- accounts are rows, not env vars.

jest.mock('./paymentConnect', () => ({
  getConnectedLanes: jest.fn(),
  readPaymentPlatformConfig: jest.fn(),
}));

const mockLanes = getConnectedLanes as jest.Mock;
const mockConfig = readPaymentPlatformConfig as jest.Mock;

const FLAG = 'PPBF_PAYMENTS_ENABLED';
let originalFlag: string | undefined;

beforeEach(() => {
  originalFlag = process.env[FLAG];
  delete process.env[FLAG];
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: 'sk_1', webhookSecret: 'whsec_1' });
});

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env[FLAG];
  } else {
    process.env[FLAG] = originalFlag;
  }
  jest.clearAllMocks();
});

describe('payment setup status', () => {
  test('nothing connected: not ready, both lanes unconnected, steps to follow', async () => {
    mockLanes.mockResolvedValue([]);

    const status = await resolvePaymentSetupStatus('org-1');

    expect(mockLanes).toHaveBeenCalledWith('org-1');
    expect(status.ready).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.lanes).toEqual({ giving: 'not_connected', program: 'not_connected' });
    expect(status.remainingSteps.length).toBeGreaterThan(0);
    // Giving is named first because its 501(c)(3) verification is the slow half.
    expect(status.remainingSteps[0]).toContain('Giving');
  });

  test('an unregistered platform adds the once-for-everyone step first', async () => {
    mockConfig.mockReturnValue({ connectClientId: null, platformSecretKey: null, webhookSecret: null });
    mockLanes.mockResolvedValue([]);

    const status = await resolvePaymentSetupStatus('org-1');

    expect(status.remainingSteps[0]).toContain('Connect OAuth client');
  });

  test('one lane connected still leaves the other one named', async () => {
    mockLanes.mockResolvedValue(['giving']);

    const status = await resolvePaymentSetupStatus('org-1');

    expect(status.lanes.giving).toBe('connected');
    expect(status.lanes.program).toBe('not_connected');
    expect(status.remainingSteps.join(' ')).toContain('Program');
    expect(status.remainingSteps.join(' ')).not.toContain('Connect the Giving');
  });

  test('both lanes connected but payments off is NOT ready', async () => {
    // Connected is not the same as switched on: compliance sign-off and the
    // staging proof sit between them, and reporting ready here would let the
    // prompt vanish before the gate it exists to describe.
    mockLanes.mockResolvedValue(['giving', 'program']);

    const status = await resolvePaymentSetupStatus('org-1');

    expect(status.ready).toBe(false);
    expect(status.remainingSteps.join(' ')).toContain('compliance sign-off');
  });

  test('fully set up: ready, and no steps left for the console to render', async () => {
    process.env[FLAG] = 'true';
    mockLanes.mockResolvedValue(['giving', 'program']);

    const status = await resolvePaymentSetupStatus('org-1');

    expect(status.ready).toBe(true);
    expect(status.remainingSteps).toEqual([]);
  });

  test('the flag only counts when it is exactly true', async () => {
    mockLanes.mockResolvedValue(['giving', 'program']);

    process.env[FLAG] = 'TRUE';
    expect((await resolvePaymentSetupStatus('org-1')).enabled).toBe(false);

    process.env[FLAG] = '1';
    expect((await resolvePaymentSetupStatus('org-1')).enabled).toBe(false);
  });
});
