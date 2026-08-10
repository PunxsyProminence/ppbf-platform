-- Durable auth rate-limit buckets (pilot.auth_rate_limit_buckets) -- the table
-- that was being created by an unauthenticated login request.
--
-- This table already exists in every deployed environment, and no file in this
-- repository created it. ensureDurableRateLimitTable() in
-- apps/web/src/server/pilot/rateLimit.ts issued
-- `create table if not exists pilot.auth_rate_limit_buckets` from inside a
-- request handler on the LOGIN path -- so the first anonymous sign-in attempt
-- against a fresh database executed DDL to bring it into being.
--
-- That is the pattern #111 removed ("An anonymous request could execute DDL
-- against production Postgres"). It was removed from the surface that made it
-- obvious and survived here, in the one path that by definition runs before
-- anybody has authenticated.
--
-- Two consequences, both fixed by this file existing:
--
--   1. A database built the sanctioned way -- pilot:apply-schema followed by
--      the migrations -- did not have this table. It appeared only once a
--      request happened to need it, which means the schema of an environment
--      depended on whether anyone had tried to log in yet.
--
--   2. The application held DDL rights on the login path. The application's
--      database role should be able to read and write rows here, not create
--      relations, and it cannot be narrowed to that while a request handler
--      needs `create table`.
--
-- SAFE TO APPLY OVER THE RUNTIME-CREATED TABLE. The column list, types and
-- primary key below are exactly what ensureDurableRateLimitTable created, so
-- `if not exists` is a no-op in every environment that already has it and a
-- creation in one built from nothing. No data is moved and no bucket is lost.
--
-- WHAT HAPPENS WHEN THIS TABLE IS ABSENT: nothing bad, deliberately. Rate
-- limiting is a guard, not the operation. withDurableClient() in rateLimit.ts
-- returns null on ANY failure -- connection, permission, missing relation --
-- and every caller treats null as "fall back to the in-memory limiter", never
-- as "deny". An unmigrated environment therefore rate-limits in process memory
-- instead of locking every athlete out of the platform. That property is what
-- makes deleting the runtime DDL safe, and it is tested.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: no account identifier, no
-- organization, no IP address in a column of its own. bucket_key is an opaque
-- composite the application builds and salts; a row here says "this bucket is
-- blocked until this time", not "this child failed to sign in from this
-- address". Nothing in it identifies a person, which is why it needs no
-- organization scoping and no retention rule beyond the sweep below.

create table if not exists pilot.auth_rate_limit_buckets (
  bucket_key text primary key,
  attempt_count integer not null default 0,
  blocked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Expired buckets are dead weight: once blocked_until is in the past the row
-- says nothing the absence of a row would not say. The application already
-- overwrites a stale row when a key comes back, so this index exists for the
-- sweep that removes the ones that never do.
create index if not exists idx_auth_rate_limit_buckets_blocked_until
  on pilot.auth_rate_limit_buckets (blocked_until);
