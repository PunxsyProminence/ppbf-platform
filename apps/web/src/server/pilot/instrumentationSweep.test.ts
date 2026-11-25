/*
 * The worker tick's sweep slot (instrumentation.ts). The email alert (lane
 * W4-1, EM-3b) runs first, in its own try: when it fails, the error is logged
 * by class and the video scan sweep still runs, as it did before.
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

import { register } from '../../../instrumentation';

beforeAll(async () => {
  process.env.NEXT_RUNTIME = 'nodejs';
  await register();
});

beforeEach(() => {
  order.length = 0;
  runEmailAlertSweep.mockReset();
});

it('runs the email alert first, then the video sweep', async () => {
  runEmailAlertSweep.mockImplementation(async () => {
    order.push('email');
    return { queued: 0, recovered: 0, sent: 0, skipped: 0, retried: 0, failed: 0, lost: 0 };
  });
  await capturedSweep!();
  expect(order).toEqual(['email', 'video']);
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
  expect(order).toEqual(['email', 'video']);
});
