// The engine behind `pilot:runtime-verify`.
//
// WHY THIS EXISTS
//
// The queue's state machine has a rung between PRODUCTION_DEPLOYED and
// PRODUCTION_VERIFIED called RUNTIME_VERIFIED, and as of 2026-08-09 thirty-two
// items skipped it. That is not a bookkeeping gap. `docs/current/WORK_QUEUE.md`
// says it plainly: what those rows attest is that the code is *running*, not
// that any of its surfaces has been exercised. This repo has shipped a chat
// tier whose every request failed and a job system that 400'd on every call,
// both green in CI, so "deployed" and "works" are genuinely different claims.
//
// Clearing that rung means running probes, not editing rows. Doing it by hand
// thirty-two times is how it stays undone, so this makes a probe a declaration
// in `runtime-probes.manifest.mjs` and runs the whole set in one pass.
//
// WHAT IT REFUSES TO DO
//
// A verification tool that can damage the thing it verifies is worse than no
// tool. Four invariants are enforced here rather than left to manifest authors
// to remember:
//
//   1. NO PROBE MAY SUCCESSFULLY MUTATE. A probe whose method is not read-only
//      and whose expectation includes a 2xx is rejected as a configuration
//      error *before any network call*. Mutating methods are still probeable --
//      that is how you prove an authorization boundary holds -- but only where
//      the expected answer is a refusal.
//   2. SQL IS READ ONLY TWICE OVER. Every statement runs inside
//      `BEGIN TRANSACTION READ ONLY`, so Postgres itself refuses a write, and
//      the text is checked to be a select/with before it is sent. The doubling
//      is deliberate: the transaction catches what the string check misses, and
//      the string check makes the intent legible at the call site.
//   3. NO SESSION IS MINTED AGAINST PRODUCTION unless the operator says so in
//      words. T-003 is the only item that ever reached PRODUCTION_VERIFIED and
//      its recorded evidence says probe sessions were minted on staging only.
//      That is the standing practice; this encodes it, with a documented escape
//      hatch rather than a hard wall, because a future acceptance criterion may
//      legitimately need one and a tool that cannot be overridden gets bypassed
//      instead of extended.
//   4. EVERY MINTED SESSION IS REVOKED, and the count of any that survive is
//      reported rather than swallowed. A failed run is exactly when a live
//      privileged session must not be left behind.
//
// WHAT IT DOES NOT DO
//
// It does not write `docs/current/PRODUCTION_STATE.json`, and it must not be
// made to. That file is gatekeeper-owned and its own header explains why: a
// tool that both produces evidence and promotes it to truth removes the
// observation step the file exists to guarantee. This emits a ledger; a human
// reads it and decides.

import { Client } from 'pg';

import { mintGateSession } from './gate-session.mjs';

/** Methods that cannot change state, so a 2xx expectation is safe on them. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Role key -> the environment variable holding that fixture's account id.
 *
 * The first three names already exist and are set by the deploy workflows for
 * the SHADOW intake gate; reusing them means those roles need no new
 * configuration. The last two are new because no gate has ever needed to
 * authenticate as a coach or as the platform owner, and inventing values for
 * them is not this file's business -- an unset one produces a SKIPPED probe
 * naming the variable, never an invented fixture.
 */
export const ROLE_FIXTURE_ENV = {
  organization_admin: 'PILOT_ADMIN_ACCOUNT_ID',
  athlete: 'PILOT_SHADOW_ATHLETE_ACCOUNT_ID',
  guardian: 'PILOT_SHADOW_GUARDIAN_ACCOUNT_ID',
  coach: 'PILOT_PROBE_COACH_ACCOUNT_ID',
  platform_owner: 'PILOT_PROBE_PLATFORM_OWNER_ACCOUNT_ID',
};

export class ProbeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeConfigurationError';
  }
}

function expectedStatuses(probe) {
  const raw = probe.expect;
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Invariant 1. Throws for a probe that could succeed at changing something.
 *
 * Exported because the manifest's own test asserts every declared probe passes
 * this, which turns the invariant into a build-time property of the manifest
 * rather than something only discovered on a live run.
 */
export function assertProbeCannotMutate(probe) {
  if (probe.kind !== 'http') return;

  const method = (probe.method || 'GET').toUpperCase();
  if (READ_ONLY_METHODS.has(method)) return;

  const succeeds = expectedStatuses(probe).filter((status) => status >= 200 && status < 300);
  if (succeeds.length > 0) {
    throw new ProbeConfigurationError(
      `Probe "${probe.id}" would send ${method} ${probe.path} and treat ${succeeds.join('/')} `
      + 'as a pass. A probe may never succeed at mutating a real environment. Expect a refusal '
      + '(401/403/404/405/409/422) instead, or move the success case into a pg test where the '
      + 'database is disposable.',
    );
  }
}

/** Invariant 2, the string half. */
export function assertSqlIsRead(probe) {
  const text = String(probe.sql || '').trim();
  if (!/^(select|with)\b/i.test(text)) {
    throw new ProbeConfigurationError(
      `Probe "${probe.id}" declares SQL that is not a select or a with-query. `
      + 'Runtime probes read; they never write.',
    );
  }
}

export function validateProbe(probe) {
  if (!probe.id) throw new ProbeConfigurationError('Every probe needs an id.');
  if (!probe.because) {
    throw new ProbeConfigurationError(
      `Probe "${probe.id}" has no "because". A probe whose reason is not written down cannot be `
      + 'reviewed, and an unreviewable check is how a wrong expectation survives.',
    );
  }

  if (probe.kind === 'http' || probe.kind === 'page') {
    if (!probe.path?.startsWith('/')) {
      throw new ProbeConfigurationError(`Probe "${probe.id}" needs an absolute path.`);
    }
    if (expectedStatuses(probe).some((status) => !Number.isInteger(status))) {
      throw new ProbeConfigurationError(`Probe "${probe.id}" must expect integer status codes.`);
    }
    assertProbeCannotMutate(probe);
    if (probe.as && !ROLE_FIXTURE_ENV[probe.as]) {
      throw new ProbeConfigurationError(
        `Probe "${probe.id}" wants a "${probe.as}" session, which is not a known role fixture. `
        + `Known: ${Object.keys(ROLE_FIXTURE_ENV).join(', ')}.`,
      );
    }
  } else if (probe.kind === 'sql') {
    assertSqlIsRead(probe);
    if (typeof probe.predicate !== 'function') {
      throw new ProbeConfigurationError(`Probe "${probe.id}" needs a predicate function.`);
    }
    if (!probe.expectation) {
      throw new ProbeConfigurationError(
        `Probe "${probe.id}" needs an "expectation" string -- the predicate says what passes in `
        + 'code, and the ledger needs it in words.',
      );
    }
  } else {
    throw new ProbeConfigurationError(
      `Probe "${probe.id}" has unknown kind "${probe.kind}". Use http, page or sql.`,
    );
  }

  return probe;
}

async function runHttpProbe(probe, { baseUrl, cookie, timeoutMs }) {
  const method = (probe.method || 'GET').toUpperCase();
  const headers = {};
  if (cookie) headers.cookie = cookie;

  let body;
  if (probe.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(probe.body);
  }

  const response = await fetch(new URL(probe.path, baseUrl), {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const allowed = expectedStatuses(probe);
  return {
    passed: allowed.includes(response.status),
    observed: String(response.status),
    expected: allowed.join(' or '),
    // Captured because a 405 that fails to advertise Allow is a different
    // defect from a 405 that does, and T-003's criteria turned on exactly that.
    detail: response.headers.get('allow')
      ? `allow: ${response.headers.get('allow')}`
      : undefined,
  };
}

async function runSqlProbe(probe, { client }) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const { rows } = await client.query(probe.sql, probe.params || []);
    await client.query('COMMIT');
    return {
      passed: Boolean(probe.predicate(rows)),
      observed: JSON.stringify(rows.slice(0, 3)),
      expected: probe.expectation,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function resolveFixtureId(role, env) {
  const variable = ROLE_FIXTURE_ENV[role];
  const value = env[variable];
  return { variable, accountId: value?.trim() || null };
}

/**
 * Runs a set of probes and returns a ledger.
 *
 * Never throws for a failing probe -- a failure is a result, and the caller
 * decides the exit code. It throws only for a configuration error, which is a
 * fault in the manifest rather than a finding about the environment.
 */
export async function runProbes({
  probes,
  baseUrl,
  target,
  connectionString = null,
  env = process.env,
  allowProductionSessionMint = false,
  timeoutMs = 15_000,
  sessionTtlMinutes = 10,
}) {
  probes.forEach(validateProbe);

  const results = [];
  const minted = new Map(); // role -> session
  const sessionsToRevoke = [];
  let client = null;

  const needsDb = probes.some((probe) => probe.kind === 'sql');
  if (needsDb) {
    if (!connectionString) {
      throw new ProbeConfigurationError(
        'SQL probes were requested but no connection string was supplied. Set '
        + 'AZURE_POSTGRES_CONNECTION_STRING, or select only http/page probes.',
      );
    }
    client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
    await client.connect();
  }

  /**
   * Mints at most one session per role for the whole run and reuses it. Two
   * probes for the same role do not need two credentials, and every extra
   * session is another row that has to be cleaned up.
   */
  async function sessionFor(role) {
    if (minted.has(role)) return minted.get(role);

    if (target === 'production' && !allowProductionSessionMint) {
      const refusal = {
        skipped: `Refusing to mint a "${role}" session against production. Standing practice `
          + '(see T-003 evidence in PRODUCTION_STATE.json) is that probe sessions are minted on '
          + 'staging only. Pass --allow-production-session-mint to override deliberately.',
      };
      minted.set(role, refusal);
      return refusal;
    }

    const { variable, accountId } = resolveFixtureId(role, env);
    if (!accountId) {
      const refusal = { skipped: `${variable} is not set, so no "${role}" fixture is available.` };
      minted.set(role, refusal);
      return refusal;
    }
    if (!connectionString) {
      const refusal = { skipped: 'No connection string, so no session can be minted.' };
      minted.set(role, refusal);
      return refusal;
    }

    const session = await mintGateSession({
      connectionString,
      accountId,
      expectedRole: role,
      ttlMinutes: sessionTtlMinutes,
    });
    sessionsToRevoke.push(session);
    minted.set(role, session);
    return session;
  }

  try {
    for (const probe of probes) {
      const record = { id: probe.id, item: probe.item, kind: probe.kind, because: probe.because };

      try {
        if (probe.kind === 'sql') {
          Object.assign(record, await runSqlProbe(probe, { client }));
        } else {
          let cookie = null;
          if (probe.as) {
            const session = await sessionFor(probe.as);
            if (session.skipped) {
              results.push({ ...record, status: 'SKIPPED', reason: session.skipped });
              continue;
            }
            cookie = session.cookie;
          }
          Object.assign(record, await runHttpProbe(probe, { baseUrl, cookie, timeoutMs }));
        }

        record.status = record.passed ? 'PASS' : 'FAIL';
      } catch (error) {
        // An unreachable host or a refused fixture is a finding about the
        // environment, not a crash of the run -- the remaining probes still
        // carry information and should still get to run.
        record.status = 'ERROR';
        record.reason = String(error?.message || error);
      }

      results.push(record);
    }
  } finally {
    for (const session of sessionsToRevoke) {
      try {
        await session.revoke();
      } catch (error) {
        // Reported, never thrown: a revoke failure must not mask the real
        // result or turn a passing run into a failing one.
        results.push({
          id: 'session-revoke',
          kind: 'hygiene',
          status: 'ERROR',
          reason: `Could not revoke a probe session: ${String(error?.message || error)}`,
        });
      }
    }
    if (client) await client.end().catch(() => {});
  }

  const tally = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});

  return {
    target,
    baseUrl,
    sessionsMinted: sessionsToRevoke.length,
    sessionsRevoked: sessionsToRevoke.length
      - results.filter((r) => r.id === 'session-revoke').length,
    results,
    tally,
    // A run with a failure and a run that could not reach the environment are
    // different outcomes, and only the first is evidence of anything.
    ok: !results.some((r) => r.status === 'FAIL' || r.status === 'ERROR'),
  };
}
