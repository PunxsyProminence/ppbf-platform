-- Gym TVs: a paired television the coach dashboard can send a live session to.
--
-- WHY. The gym TV shows the coach's live session (gym TV lane, slice S2a of the plan in
-- Documents/PPBF-overwatch/lane-inbox/GYM-TV-WORKOUT-plan-2026-10-06.md). Jason ruled the display
-- is "a capability in the coaches dashboard" (Q3), not public /wall content, and chose pairing:
-- "Pair with code (Recommended)" -- a 6-character one-time code shown on the coach dashboard, typed
-- once on the TV, after which the TV holds its own device key "Until disconnected". The TV never
-- holds a person's account, so a coach's session expiring does nothing to it, and a stranger with
-- the URL sees only a code box.
--
-- WHAT CHANGES. One table, pilot.gym_tvs, one row per TV, scoped to the organization:
--   pair_code_hash / pair_code_expires_at  the one-time code, hashed; both null once redeemed.
--   device_key_hash / paired_at            the TV's key, hashed; both set by redeeming the code.
--   last_seen_at                           touched on every keyed read (S2b).
--   revoked_at                             Disconnect. The row stays for the Paired TVs history;
--                                          the key is refused from then on.
--   current_run_id                         the live session a coach sent to this TV (S2a-2 sets
--                                          it; "one session per TV", Jason "A"). Composite FK to
--                                          the run, SET NULL (current_run_id) when the run row is
--                                          deleted, so a TV can never point at a run that is gone.
-- Only hashes are stored: the code is shown once to the coach and the key lives only in the TV's
-- cookie, so a database read gives neither.
--
-- POSTGRESQL 15 IS REQUIRED for the column-list SET NULL on a composite key (same guard as
-- pilot_slice_postgres_video_clip_tags_sparring_link_migration.sql; production and staging run 16).
--
-- Requires pilot.organizations, pilot.accounts (pilot_slice_postgres.sql) and
-- pilot.session_script_runs (pilot_slice_postgres_session_scripts_migration.sql); the `all` chain
-- runs those first.
--
-- Idempotent: create if not exists throughout. No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-gym-tvs-migration.mjs) opens the transaction.

do $pilot_gym_tvs_pg15$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'GYM_TVS_REQUIRES_PG15: server_version_num is %, and ON DELETE SET NULL (column) needs 150000 or later. Nothing was changed.',
      current_setting('server_version_num');
  end if;
end
$pilot_gym_tvs_pg15$;

create table if not exists pilot.gym_tvs (
  organization_id        text        not null references pilot.organizations(organization_id) on delete cascade,
  tv_id                  text        not null,
  tv_name                text        not null,
  -- The coach who minted the code. Nullable with SET NULL so purging that account later does not
  -- take the gym's TV with it: the TV belongs to the gym, not to the person who paired it.
  created_by_account_id  text        null references pilot.accounts(account_id) on delete set null,
  created_at             timestamptz not null default now(),
  pair_code_hash         text        null,
  pair_code_expires_at   timestamptz null,
  device_key_hash        text        null,
  paired_at              timestamptz null,
  last_seen_at           timestamptz null,
  revoked_at             timestamptz null,
  current_run_id         text        null,
  current_run_set_by_account_id text null references pilot.accounts(account_id) on delete set null,
  constraint pilot_gym_tvs_pkey primary key (organization_id, tv_id),
  constraint pilot_gym_tvs_current_run_fk
    foreign key (organization_id, current_run_id)
    references pilot.session_script_runs(organization_id, run_id)
    on delete set null (current_run_id),
  -- A code always carries its expiry, and a redeemed row has neither.
  constraint pilot_gym_tvs_code_with_expiry
    check ((pair_code_hash is null) = (pair_code_expires_at is null)),
  -- Pending XOR paired: the key and paired_at arrive together, and a paired row holds no code.
  constraint pilot_gym_tvs_paired_xor_pending
    check ((device_key_hash is null) = (paired_at is null)
           and (pair_code_hash is null or device_key_hash is null)),
  -- A session can only be sent to a TV that is paired and not disconnected.
  constraint pilot_gym_tvs_run_only_when_paired
    check (current_run_id is null or (device_key_hash is not null and revoked_at is null)),
  constraint pilot_gym_tvs_name_present
    check (length(btrim(tv_name)) between 1 and 60)
);

-- Each key and each live code is unique across every gym: the TV endpoint looks a code or key up
-- without knowing the organization, and the row it finds says which gym it belongs to.
create unique index if not exists pilot_gym_tvs_device_key_uidx
  on pilot.gym_tvs(device_key_hash) where device_key_hash is not null;
create unique index if not exists pilot_gym_tvs_pair_code_uidx
  on pilot.gym_tvs(pair_code_hash) where pair_code_hash is not null;

comment on table pilot.gym_tvs is
  'A gym television paired from the coach dashboard with a one-time code. Holds only hashes of the code and the device key; current_run_id is the live session a coach sent to it.';
