/**
 * The startup configuration guards exist to refuse an unsafe boot. Both were
 * written and exported during the security pass, and for a while nothing called
 * either one -- so they protected nothing. These tests hold the wiring itself:
 * that register() invokes them, that it exits rather than serving when one
 * fails, and that the edge runtime never touches the node-only server stack.
 */

const validateSslConfiguration = jest.fn();
const validateDurableRateLimitConfiguration = jest.fn();
const isShadowWorkerEnabled = jest.fn(() => false);

jest.mock('./src/server/pilot/db', () => ({ validateSslConfiguration }));
jest.mock('./src/server/pilot/rateLimit', () => ({ validateDurableRateLimitConfiguration }));
jest.mock('./src/server/pilot/shadowJobWorker', () => ({
  isShadowWorkerEnabled,
  resolveShadowWorkerIntervalMs: jest.fn(() => 30_000),
  startShadowJobWorker: jest.fn(() => null),
}));

const originalRuntime = process.env.NEXT_RUNTIME;
let exitSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  validateSslConfiguration.mockImplementation(() => undefined);
  validateDurableRateLimitConfiguration.mockImplementation(() => undefined);
  isShadowWorkerEnabled.mockReturnValue(false);
  // Thrown rather than returning, so a test asserting "exits" also proves nothing
  // after the exit call runs -- a real process.exit does not return either.
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  if (originalRuntime === undefined) {
    delete process.env.NEXT_RUNTIME;
  } else {
    process.env.NEXT_RUNTIME = originalRuntime;
  }
});

async function loadRegister() {
  // Re-imported per test: register() is module-scoped and the mocks above are
  // asserted per call.
  const instrumentation = await import('./instrumentation');
  return instrumentation.register;
}

describe('startup configuration guards', () => {
  test('both guards run on a nodejs server start', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const register = await loadRegister();
    await register();

    expect(validateSslConfiguration).toHaveBeenCalledTimes(1);
    expect(validateDurableRateLimitConfiguration).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // The worker is off in most environments, and an early return above the guards
  // would have made them dead code exactly there.
  test('the guards run even when the SHADOW worker is disabled', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    isShadowWorkerEnabled.mockReturnValue(false);

    const register = await loadRegister();
    await register();

    expect(validateSslConfiguration).toHaveBeenCalledTimes(1);
    expect(validateDurableRateLimitConfiguration).toHaveBeenCalledTimes(1);
  });

  test('a failed TLS check exits the process instead of serving', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    validateSslConfiguration.mockImplementation(() => {
      throw new Error('FATAL: Cannot disable PostgreSQL SSL in non-test environments.');
    });

    const register = await loadRegister();
    await expect(register()).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('a failed rate-limit check exits the process instead of serving', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    validateDurableRateLimitConfiguration.mockImplementation(() => {
      throw new Error('FATAL: Production deployment requires PPBF_DURABLE_RATE_LIMIT=true.');
    });

    const register = await loadRegister();
    await expect(register()).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // The reason has to reach the operator: a container that exits silently on boot
  // is indistinguishable from one that crashed for an unrelated reason.
  test('the refusal names the reason it refused', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    validateDurableRateLimitConfiguration.mockImplementation(() => {
      throw new Error('FATAL: Production deployment requires PPBF_DURABLE_RATE_LIMIT=true.');
    });

    const register = await loadRegister();
    await expect(register()).rejects.toThrow('process.exit called');

    expect(JSON.stringify(errorSpy.mock.calls)).toContain('PPBF_DURABLE_RATE_LIMIT');
  });

  // instrumentation is evaluated for the edge runtime too, where pg must never be
  // pulled into the bundle -- so the guards cannot run there, and must not try.
  test('the edge runtime returns without touching the node-only server stack', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    const register = await loadRegister();
    await register();

    expect(validateSslConfiguration).not.toHaveBeenCalled();
    expect(validateDurableRateLimitConfiguration).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
