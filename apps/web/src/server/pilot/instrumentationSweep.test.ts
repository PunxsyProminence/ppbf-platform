/*
 * The worker tick's sweep slot (instrumentation.ts). The email alert (lane
 * W4-1, EM-3b) runs first, then the web push alert (lane W5-WP, WP-2b-2c),
 * each in its own try: when one fails, the error is logged by class and the
 * rest still run, the video scan sweep as it did before.
 */

const order: string[] = [];
let capturedSweep: (() => Promise<void>) | undefined;

jest.mock('./shadowJobWorker', () => ({
  isShadowWorkerEnabled: () => true,
  resolveShadowWorkerIntervalMs: () => 30_000,
  startShadowJobWorker: (options: { sweep: () => Promise<void> }) => {
    capturedSweep = options.sweep;
    return { stop: () => undefined };
  },
}));
jest.mock('./shadowJobProcessor', () => ({ processNextShadowJob: jest.fn() }));
jest.mock('./shadowJobQueue', () => ({ purgeTerminalShadowJobs: jest.fn() }));
jest.mock('./shadowArchival', () => ({ createShadowArchivalSweep: () => jest.fn() }));
jest.mock('./videoScanSweep', () => ({
  sweepQuarantinedVideos: jest.fn(async () => {
    order.push('video');
    return { scanned: 0, promoted: 0, blocked: 0 };
  }),
}));
const runEmailAlertSweep = jest.fn();
jest.mock('./emailAlertSender', () => ({ runEmailAlertSweep: () => runEmailAlertSweep() }));
const runPushAlertSweep = jest.fn();
jest.mock('./pushAlertSender', () => ({ runPushAlertSweep: () => runPushAlertSweep() }));
const NOTHING = { queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0 };

import { register } from '../../../instrumentation';

beforeAll(async () => {
  process.env.NEXT_RUNTIME = 'nodejs';
  await register();
});

beforeEach(() => {
  order.length = 0;
  runEmailAlertSweep.mockReset();
  runPushAlertSweep.mockReset();
  runPushAlertSweep.mockImplementation(async () => {
    order.push('push');
    return NOTHING;
  });
});

it('runs the email alert first, then the push alert, then the video sweep', async () => {
  runEmailAlertSweep.mockImplementation(async () => {
    order.push('email');
    return NOTHING;
  });
  await capturedSweep!();
  expect(order).toEqual(['email', 'push', 'video']);
});

it('a failing email alert is logged by class only, and the video sweep still runs', async () => {
  runEmailAlertSweep.mockImplementation(async () => {
    order.push('email');
    throw new TypeError('the database is unreachable');
  });
  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(capturedSweep!()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('Email alert sweep failed', { errorClass: 'TypeError' });
  } finally {
    errors.mockRestore();
  }
  expect(order).toEqual(['email', 'push', 'video']);
});

it('a failing push alert is logged by class only, and the video sweep still runs', async () => {
  runEmailAlertSweep.mockImplementation(async () => {
    order.push('email');
    return NOTHING;
  });
  runPushAlertSweep.mockImplementation(async () => {
    order.push('push');
    throw new RangeError('the push service is unreachable');
  });
  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(capturedSweep!()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('Push alert sweep failed', { errorClass: 'RangeError' });
  } finally {
    errors.mockRestore();
  }
  expect(order).toEqual(['email', 'push', 'video']);
});

it('a push tick that did something is logged as counts only', async () => {
  runEmailAlertSweep.mockImplementation(async () => NOTHING);
  runPushAlertSweep.mockImplementation(async () => ({ ...NOTHING, sent: 2 }));
  const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await capturedSweep!();
    expect(logs).toHaveBeenCalledWith('Push alert sweep', { ...NOTHING, sent: 2 });
  } finally {
    logs.mockRestore();
  }
});
