/**
 * Raised when the SHADOW runtime cannot serve a request because its
 * infrastructure is not in place -- a required migration has not been applied,
 * or a required environment variable is unset.
 *
 * This is deliberately a typed error rather than a message-prefixed one.
 * `jsonError` maps any message beginning with "Missing" to HTTP 400, which
 * meant an unapplied migration surfaced to callers as a client error -- the
 * request was blamed for a server-side deployment gap. That is how the 400 on
 * /api/pilot/shadow/metrics went undiagnosed. The `Missing` prefix rule is
 * still correct for genuine client errors (see 'Missing SHADOW library query'
 * in shadowLibrary.ts) and is left alone; only this typed error maps to 503.
 *
 * It lives in its own module rather than in shadowReadiness.ts on purpose.
 * Route tests routinely stub readiness with a whole-module factory --
 * `jest.mock('.../shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }))`
 * -- which would leave this export undefined and make the `instanceof` check in
 * jsonError throw a TypeError at runtime. Keeping the type in a module nobody
 * needs to mock removes that failure mode entirely.
 *
 * The diagnostic detail is carried on the instance for server-side logging and
 * is never serialized into the HTTP response -- `missingEnvVar` in particular
 * would otherwise disclose infrastructure configuration to callers.
 */
export class ShadowRuntimeUnavailableError extends Error {
  readonly missingTables: readonly string[];
  readonly missingEnvVar: string | null;

  constructor(input: { missingTables?: readonly string[]; missingEnvVar?: string | null }) {
    super('SHADOW runtime is unavailable');
    this.name = 'ShadowRuntimeUnavailableError';
    this.missingTables = input.missingTables ?? [];
    this.missingEnvVar = input.missingEnvVar ?? null;
  }
}
