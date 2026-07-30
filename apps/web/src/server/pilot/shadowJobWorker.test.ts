import {
  DEFAULT_WORKER_INTERVAL_SECONDS,
  isShadowWorkerEnabled,
  resolveShadowWorkerIntervalMs,
  startShadowJobWorker,
  type ShadowJobWorkerHandle,
} from './shadowJobWorker';

describe('worker enablement flag', () => {
  test('starts only on the exact string true', () => {
    expect(isShadowWorkerEnabled({ PPBF_SHADOW_WORKER_ENABLED: 'true' })).toBe(true);
    // Anything else -- including a truthy-looking value -- keeps the worker
    // off. No environment gains a background processor by accident.
    expect(isShadowWorkerEnabled({ PPBF_SHADOW_WORKER_ENABLED: 'TRUE' })).toBe(false);
    expect(isShadowWorkerEnabled({ PPBF_SHADOW_WORKER_ENABLED: '1' })).toBe(false);
    expect(isShadowWorkerEnabled({})).toBe(false);
  });
});

describe('worker interval', () => {
  test('defaults, parses, and clamps to the 5-600 second band', () => {
    expect(resolveShadowWorkerIntervalMs({})).toBe(DEFAULT_WORKER_INTERVAL_SECONDS * 1000);
    expect(resolveShadowWorkerIntervalMs({ PPBF_SHADOW_WORKER_INTERVAL_SECONDS: '10' })).toBe(10_000);
    expect(resolveShadowWorkerIntervalMs({ PPBF_SHADOW_WORKER_INTERVAL_SECONDS: '2' })).toBe(5_000);
    expect(resolveShadowWorkerIntervalMs({ PPBF_SHADOW_WORKER_INTERVAL_SECONDS: '99999' })).toBe(600_000);
    expect(resolveShadowWorkerIntervalMs({ PPBF_SHADOW_WORKER_INTERVAL_SECONDS: 'soon' }))
      .toBe(DEFAULT_WORKER_INTERVAL_SECONDS * 1000);
  });
});

describe('drain loop', () => {
  let handle: ShadowJobWorkerHandle | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    jest.useRealTimers();
  });

  test('a tick drains until the queue reports empty', async () => {
    const results = [
      { processed: true, jobId: 'a' },
      { processed: true, jobId: 'b' },
      { processed: false },
    ];
    const processOne = jest.fn(async () => results.shift() ?? { processed: false });

    handle = startShadowJobWorker({ processOne, intervalMs: 1_000 });
    expect(handle).not.toBeNull();

    await jest.advanceTimersByTimeAsync(1_000);

    // Two real jobs plus the empty-queue probe that ends the tick.
    expect(processOne).toHaveBeenCalledTimes(3);
  });

  test('a tick claims at most maxJobsPerTick even when the queue stays full', async () => {
    const processOne = jest.fn(async () => ({ processed: true, jobId: 'x' }));

    handle = startShadowJobWorker({ processOne, intervalMs: 1_000, maxJobsPerTick: 2 });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(2);

    // The backlog is picked up by the NEXT tick rather than one tick running
    // unbounded -- a full queue must never starve the event loop.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(4);
  });

  test('an infrastructure error is reported and the loop survives it', async () => {
    const onError = jest.fn();
    const processOne = jest.fn()
      .mockRejectedValueOnce(new Error('database unreachable'))
      .mockResolvedValue({ processed: false });

    handle = startShadowJobWorker({ processOne, intervalMs: 1_000, onError });

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);

    // The loop re-armed itself after the failure.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(2);
  });

  test('refuses to double-start, and stop() releases the slot', async () => {
    const processOne = jest.fn(async () => ({ processed: false }));

    handle = startShadowJobWorker({ processOne, intervalMs: 1_000 });
    expect(handle).not.toBeNull();

    // Hot reload re-running module init must not stack a second loop.
    expect(startShadowJobWorker({ processOne, intervalMs: 1_000 })).toBeNull();

    handle?.stop();
    handle = startShadowJobWorker({ processOne, intervalMs: 1_000 });
    expect(handle).not.toBeNull();
  });

  test('stop() halts future ticks', async () => {
    const processOne = jest.fn(async () => ({ processed: false }));

    handle = startShadowJobWorker({ processOne, intervalMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(1);

    handle?.stop();
    handle = null;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(processOne).toHaveBeenCalledTimes(1);
  });
});
