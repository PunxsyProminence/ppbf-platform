-- Gym tablet idle sign-out time, per organization
-- (pilot.organization_tablet_idle_policy): lane U1, PR AS2-a.
--
-- WHY. A gym tablet is shared. Left signed in, the next child to pick it up
-- sees the last athlete's screen (app scrub ATH-10, stage 3 AS-2). Jason's
-- ruling OW25-53 A: the gym admin sets the idle time in gym settings; his
-- first value is 1 hour ("1 goahead and make it 1 hr for now").
-- This table holds that one setting. The sign-out itself runs in the
-- browser, on a device a gym admin has marked as a gym tablet (lane U1,
-- AS2-b); this table decides only how long that device may sit idle.
--
-- ABSENCE MEANS ONE HOUR. An organization with no row gets 60 minutes,
-- stated once in tabletIdlePolicy.ts (DEFAULT_TABLET_IDLE_MINUTES). Deploying
-- this migration writes no row, so every gym starts at the ruled default.
--
-- A FIXED LIST, NOT ANY NUMBER. Overwatch Q3 (2026-11-19): 15, 30, 60, 120 or
-- 240 minutes. The CHECK holds the list in the database, so a route bug
-- cannot store 1 minute (a tablet that signs out mid-round) or 0.
--
-- WHY A TABLE AND NOT A COLUMN ON pilot.organizations. The same reason as
-- pilot.organization_video_policy: that table is identity, and a typed table
-- per setting keeps its CHECK and its "who set it, when" beside it.
--
-- WHO SET IT. set_by_account_id names the gym admin who saved the value;
-- on delete set null, so a departed admin does not delete the setting. The
-- audit stream holds each change with the old and new value.
--
-- NO PERSON DATA. One number per gym and who set it. No athlete, device or
-- session is stored here.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-tablet-idle-policy-migration.mjs)
-- opens the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.organization_tablet_idle_policy (
  organization_id    text primary key
    references pilot.organizations(organization_id) on delete cascade,
  idle_minutes       integer not null
    constraint pilot_org_tablet_idle_minutes_check check (idle_minutes in (15, 30, 60, 120, 240)),
  set_by_account_id  text null references pilot.accounts(account_id) on delete set null,
  set_at             timestamptz not null default clock_timestamp()
);

-- Read on every signed-in page load of a marked tablet, by organization:
-- the primary key is the access path, so there is no other index.

comment on table pilot.organization_tablet_idle_policy is
  'How long a marked gym tablet may sit idle before it signs itself out, per organization (15, 30, 60, 120 or 240 minutes; no row = 60). Set by the gym admin (OW25-53 A). Lane U1, AS2-a.';
