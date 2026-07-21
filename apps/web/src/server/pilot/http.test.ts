import { jsonError, parseSafeLimit } from './http';

describe('jsonError', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('maps an Unauthorized error to 401 and preserves the message', async () => {
    const res = jsonError(new Error('Unauthorized'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('maps a Forbidden error to 403 and preserves the message', async () => {
    const res = jsonError(new Error('Forbidden: role not allowed'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: role not allowed' });
  });

  test('maps a Missing error to 400 and preserves the message', async () => {
    const res = jsonError(new Error('Missing athlete_id'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing athlete_id' });
  });

  test('an unexpected database error returns a generic 500 message, not the raw internal message', async () => {
    const dbError = new Error(
      'connection to server at "prod-db.internal" (10.0.4.12), port 5432 failed: password authentication failed for user "ppbf_app"',
    );
    const res = jsonError(dbError);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('10.0.4.12');
    expect(JSON.stringify(body)).not.toContain('password authentication failed');
  });

  test('an unexpected parser error returns a generic 500 message', async () => {
    const parserError = new Error('Unexpected token in PDF xref table at offset 48213');
    const res = jsonError(parserError);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('a non-Error thrown value also returns a generic 500 message', async () => {
    const res = jsonError('raw string thrown from somewhere');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  test('logs the real error server-side even though the client response is generic', async () => {
    const dbError = new Error('relation "pilot.foo" does not exist');
    await jsonError(dbError).json();
    expect(consoleErrorSpy).toHaveBeenCalledWith('unhandled-route-error', dbError);
  });

  test('an explicit non-500 fallback status for an unrecognized message is preserved verbatim', async () => {
    // Routes that deliberately choose a specific status for a known
    // condition (not "unexpected") are left untouched.
    const res = jsonError(new Error('Video session not found'), 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Video session not found' });
  });
});

describe('parseSafeLimit', () => {
  test('returns the default when raw is null', () => {
    expect(parseSafeLimit(null, 50, 100)).toBe(50);
  });

  test('returns the default when raw is an empty string', () => {
    expect(parseSafeLimit('', 50, 100)).toBe(50);
  });

  test('parses a valid positive integer', () => {
    expect(parseSafeLimit('25', 50, 100)).toBe(25);
  });

  test('clamps a value above max down to max', () => {
    expect(parseSafeLimit('500', 50, 100)).toBe(100);
  });

  test.each(['0', '-1', '-100'])('rejects zero/negative value %s', (raw) => {
    expect(parseSafeLimit(raw, 50, 100)).toBeNull();
  });

  test.each(['3.5', 'abc', 'NaN', 'Infinity', '1e10', ' 10', '10 ', '+10'])(
    'rejects non-integer input %s',
    (raw) => {
      expect(parseSafeLimit(raw, 50, 100)).toBeNull();
    },
  );

  test('rejects a value larger than Number.MAX_SAFE_INTEGER', () => {
    expect(parseSafeLimit('999999999999999999999', 50, 100)).toBeNull();
  });
});
