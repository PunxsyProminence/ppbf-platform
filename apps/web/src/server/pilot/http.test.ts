import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PilotError,
  ValidationError,
} from './errors';
import { jsonError, parseSafeLimit } from './http';
import { ShadowRuntimeUnavailableError } from './shadowRuntimeError';

describe('jsonError', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('PilotError', () => {
    test.each([
      ['ValidationError', new ValidationError('Note must be at least 10 characters'), 400],
      ['ForbiddenError', new ForbiddenError('Only an organization admin may decide this'), 403],
      ['NotFoundError', new NotFoundError('That safety flag does not exist'), 404],
      ['ConflictError', new ConflictError('An external rule cannot be bypassed'), 409],
    ])('%s carries its own status and discloses its message', async (_name, error, status) => {
      const res = jsonError(error);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: error.message });
    });

    test('includes the machine code when the throw site supplied one', async () => {
      const res = jsonError(new ValidationError('resolution note too short', 'SAFETY_FLAG_NOTE_TOO_SHORT'));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'resolution note too short',
        code: 'SAFETY_FLAG_NOTE_TOO_SHORT',
      });
    });

    test('omits code entirely rather than emitting an undefined field', async () => {
      const body = await jsonError(new ValidationError('no code here')).json();
      expect(body).toEqual({ error: 'no code here' });
      expect('code' in body).toBe(false);
    });

    // The status comes from the type, not from the spelling. This is the whole
    // point: a PilotError whose message happens to begin with "Missing" must
    // not be re-derived by the prefix branches further down.
    test('a status wins over a message that would prefix-match differently', async () => {
      const res = jsonError(new ConflictError('Missing guardian consent for this athlete'));
      expect(res.status).toBe(409);
    });

    // The security property. Migrating call sites must never make it easier to
    // leak an internal message: a plain Error still means "redact me".
    test('does NOT weaken redaction for a plain Error with an unmatched message', async () => {
      const res = jsonError(new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
    });

    test('a base PilotError with an arbitrary status is honoured', async () => {
      const res = jsonError(new PilotError(422, 'Unprocessable in this state'));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'Unprocessable in this state' });
    });

    // Subclass identity must survive: these are checked with instanceof, and
    // an ES5 downlevel would silently break that for every subclass.
    test('every subclass is instanceof PilotError', () => {
      expect(new ValidationError('x')).toBeInstanceOf(PilotError);
      expect(new ForbiddenError('x')).toBeInstanceOf(PilotError);
      expect(new NotFoundError('x')).toBeInstanceOf(PilotError);
      expect(new ConflictError('x')).toBeInstanceOf(PilotError);
      expect(new ValidationError('x').name).toBe('ValidationError');
    });
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

  // An unapplied migration is a server-side availability problem. It previously
  // surfaced as a 400 because its message began with "Missing", which blamed the
  // caller for a deployment gap and is how the 400 on /api/pilot/shadow/metrics
  // went undiagnosed.
  test('maps an unmigrated SHADOW runtime to 503, not 400', async () => {
    const res = jsonError(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_chat_sessions', 'shadow_learning_events'],
    }));
    expect(res.status).toBe(503);
  });

  test('does not disclose missing table names or env var names to the caller', async () => {
    const res = jsonError(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_chat_sessions'],
      missingEnvVar: 'AZURE_POSTGRES_CONNECTION_STRING',
    }));
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('shadow_chat_sessions');
    expect(body).not.toContain('AZURE_POSTGRES_CONNECTION_STRING');
  });

  // The typed error above must not have widened the "Missing" prefix rule.
  // These are genuine client errors from shadowLibrary.ts and must stay 400,
  // otherwise a bad request gets reported as a platform outage.
  test.each([
    'Missing SHADOW library query',
    'Missing SHADOW library subject',
  ])('keeps %s as a 400 client error', async (message) => {
    const res = jsonError(new Error(message));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
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

  test('logs only a sanitized error class server-side', async () => {
    const dbError = new Error('relation "pilot.foo" does not exist');
    await jsonError(dbError).json();
    expect(consoleErrorSpy).toHaveBeenCalledWith('unhandled-route-error', {
      errorClass: 'Error',
    });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('pilot.foo');
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
