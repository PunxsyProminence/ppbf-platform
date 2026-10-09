/**
 * A stand-in for pilot.auth_rate_limit_buckets, shared by every "replica" a
 * burst test loads, so route tests can show what happens ACROSS replicas
 * without a database.
 *
 * It answers only the statements rateLimit.ts sends, matched by shape. Each
 * statement waits one macrotask (the round trip) and then runs in one step,
 * which is what Postgres gives a single statement: the reserve upsert is
 * atomic, and a read followed by a separate write is not. That the real
 * upsert admits exactly one of a concurrent burst is proven against real
 * Postgres in durableRateLimit.pg.test.ts; this fake models that, it does not
 * prove it.
 *
 * Usage: route under test loaded with jest.isolateModules (one per replica),
 * with '@/src/server/pilot/db' mocked so withPoolClient runs on this store,
 * and PPBF_DURABLE_RATE_LIMIT plus a connection string set so the durable half
 * is on (see enableDurable).
 */

interface Bucket {
  attemptCount: number;
  blockedUntil: number;
}

// Same schedule as rateLimit.ts backoffMsFor; the reserve statement carries
// these numbers as parameters, the record statement carries the delay itself.
function backoffMs(attempts: number, initial: number, multiplier: number, threshold: number, max: number): number {
  return Math.min(initial * Math.pow(multiplier, Math.max(0, attempts - threshold)), max);
}

function roundTrip(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createFakeDurableRateLimitStore() {
  const buckets = new Map<string, Bucket>();

  async function query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    await roundTrip();
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const now = Date.now();

    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [] };
    }
    if (sql.startsWith('delete from pilot.auth_rate_limit_buckets where updated_at')) {
      return { rows: [] };
    }
    if (sql.startsWith('delete from pilot.auth_rate_limit_buckets where bucket_key')) {
      buckets.delete(String(params[0]));
      return { rows: [] };
    }
    if (sql.startsWith('select attempt_count from pilot.auth_rate_limit_buckets')) {
      const bucket = buckets.get(String(params[0]));
      return { rows: bucket ? [{ attempt_count: bucket.attemptCount }] : [] };
    }
    if (sql.startsWith('select blocked_until from pilot.auth_rate_limit_buckets')) {
      const bucket = buckets.get(String(params[0]));
      return { rows: bucket ? [{ blocked_until: new Date(bucket.blockedUntil) }] : [] };
    }
    // recordDurableFailedAttempt: the count and delay were computed by the caller.
    if (sql.startsWith('insert into pilot.auth_rate_limit_buckets (bucket_key')) {
      const [key, attempts, delayMs] = params as [string, number, number];
      buckets.set(key, { attemptCount: attempts, blockedUntil: now + delayMs });
      return { rows: [] };
    }
    // reserveDurableAttempt: admitted only if the bucket is open, in one step.
    if (sql.startsWith('insert into pilot.auth_rate_limit_buckets as b')) {
      const [key, , initial, multiplier, threshold, max] = params as [string, number, number, number, number, number];
      const existing = buckets.get(key);
      if (existing && existing.blockedUntil > now) {
        return { rows: [] };
      }
      const attemptCount = (existing?.attemptCount ?? 0) + 1;
      buckets.set(key, {
        attemptCount,
        blockedUntil: now + backoffMs(attemptCount, initial, multiplier, threshold, max),
      });
      return { rows: [{ attempt_count: attemptCount }] };
    }
    throw new Error(`fakeDurableRateLimitStore: unexpected statement: ${sql.slice(0, 80)}`);
  }

  return {
    buckets,
    async withPoolClient<T>(work: (client: never) => Promise<T>): Promise<T> {
      return work({ query } as never);
    },
  };
}

/** Turns the durable half on for the duration of a test; returns the restore. */
export function enableDurable(): () => void {
  const saved = {
    flag: process.env.PPBF_DURABLE_RATE_LIMIT,
    connection: process.env.AZURE_POSTGRES_CONNECTION_STRING,
  };
  process.env.PPBF_DURABLE_RATE_LIMIT = 'true';
  process.env.AZURE_POSTGRES_CONNECTION_STRING = 'postgres://fake-durable-store/never-connected';
  return () => {
    for (const [name, value] of [
      ['PPBF_DURABLE_RATE_LIMIT', saved.flag],
      ['AZURE_POSTGRES_CONNECTION_STRING', saved.connection],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** Loads a fresh copy of a module and everything it imports: one "replica", with its own in-memory limiter. */
export function loadReplica<T>(load: () => T): T {
  let loaded: T | undefined;
  jest.isolateModules(() => {
    loaded = load();
  });
  return loaded as T;
}
