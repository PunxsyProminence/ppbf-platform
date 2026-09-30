import { PilotError, ServiceUnavailableError, SERVICE_UNAVAILABLE_MESSAGE } from './errors';
import { getAzurePostgresConnectionString, getAzureStorageConnectionString } from './env';

/*
  WHAT AN ABSENT CONNECTION STRING IS ALLOWED TO SAY.

  These two getters are the only callers of `requireEnv`, and both of them run
  on paths an unauthenticated visitor can reach -- POST /api/pilot/auth/login
  resolves a database connection before it has decided who is asking. So the
  refusal they raise is a public artefact, and this file pins both halves of
  it: the STATUS, which must describe an unavailable server rather than a bad
  request, and the BODY, which must not name the thing that is missing.

  The old behaviour failed both. `requireEnv` threw a plain Error reading
  "Missing required environment variable: AZURE_POSTGRES_CONNECTION_STRING",
  `jsonError` routed anything starting with "Missing" to 400 and returned it
  verbatim, and a misconfigured server told a child at the gym tablet that
  they had sent a bad request, while handing whoever asked the name of an
  infrastructure variable.
*/

const POSTGRES = 'AZURE_POSTGRES_CONNECTION_STRING';
const STORAGE = 'AZURE_STORAGE_CONNECTION_STRING';

describe('required runtime configuration', () => {
  const original = { ...process.env };
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = { ...original };
  });

  test.each([
    ['Postgres', POSTGRES, getAzurePostgresConnectionString],
    ['Storage', STORAGE, getAzureStorageConnectionString],
  ])('an absent %s connection string is an unavailable SERVER, not a bad request', (_label, name, read) => {
    delete process.env[name];

    expect(read).toThrow(ServiceUnavailableError);
    try {
      read();
    } catch (error) {
      expect(error).toBeInstanceOf(PilotError);
      expect((error as PilotError).status).toBe(503);
    }
  });

  /* The disclosure half, asserted on the MESSAGE rather than on the status,
     because a PilotError's message is disclosed by definition: the type's
     whole contract is "this was authored for the caller to read". A helpful
     message here is a leak, so the test names the strings that may not
     appear rather than trusting the one that should. */
  test.each([
    ['Postgres', POSTGRES, getAzurePostgresConnectionString],
    ['Storage', STORAGE, getAzureStorageConnectionString],
  ])('the refusal for %s tells the caller nothing about what is missing', (_label, name, read) => {
    delete process.env[name];

    try {
      read();
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toBe(SERVICE_UNAVAILABLE_MESSAGE);
      expect(message).not.toContain(name);
      expect(message).not.toMatch(/AZURE|POSTGRES|STORAGE|CONNECTION_STRING/i);
    }
  });

  /* Redacting it from the caller must not lose it. Whoever can fix a missing
     connection string is reading the server's logs, and an outage that names
     nothing is the reason the 400 went undiagnosed in the first place. */
  test.each([
    ['Postgres', POSTGRES, getAzurePostgresConnectionString],
    ['Storage', STORAGE, getAzureStorageConnectionString],
  ])('%s is still named where it is useful: the server log', (_label, name, read) => {
    delete process.env[name];

    expect(read).toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'required-environment-unavailable',
      { missingEnvVar: name },
    );
  });

  test.each([
    ['Postgres', POSTGRES, getAzurePostgresConnectionString],
    ['Storage', STORAGE, getAzureStorageConnectionString],
  ])('a present %s connection string is returned unchanged', (_label, name, read) => {
    process.env[name] = 'value-for-this-test';

    expect(read()).toBe('value-for-this-test');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  /* Whitespace is not configuration. A variable set to spaces by a broken
     deployment template reads as absent, and must refuse the same way rather
     than handing a blank connection string to the driver. */
  test('a whitespace-only value is absent, and refuses identically', () => {
    process.env[POSTGRES] = '   ';

    expect(getAzurePostgresConnectionString).toThrow(ServiceUnavailableError);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'required-environment-unavailable',
      { missingEnvVar: POSTGRES },
    );
  });
});
