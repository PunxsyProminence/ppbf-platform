-- The gym's "no present mark for" number for the "who has stopped coming" page,
-- per organization (pilot.organization_stopped_coming_policy): lane W4-6, PR SC-0a-1
-- (the table; its module and routes are SC-0a-2).
--
-- WHY. The stopped-coming page lists the gym's active athletes who have come
-- before and have not come for this many days (W4 item 6, app scrub CF-14).
-- Jason's ruling OW27-30 A (OD-2026-11-21-006): "a gym setting the
-- organization admin can change; first value 2 weeks". This table holds that
-- one setting. The list itself is read elsewhere (lane W4-6, SC-1).
--
-- ABSENCE MEANS TWO WEEKS. An organization with no row gets 14 days, stated
-- once in stoppedComingPolicy.ts (SC-0a-2). Deploying this migration writes no
-- row, so every gym starts at the ruled first value; "Use the default" deletes
-- the row (SC-0a-2).
--
-- A FIXED LIST, NOT ANY NUMBER. Overwatch's answer to W4-6 Q1 (2026-11-25):
-- 7, 14, 21, 28, 42 or 56 days (1, 2, 3, 4, 6 or 8 weeks), held by a CHECK,
-- as the tablet idle time is. A route bug cannot store 0 days (every athlete
-- listed) or 900.
--
-- WHY A TABLE AND NOT A COLUMN ON pilot.organizations. The same reason as
-- pilot.organization_tablet_idle_policy: that table is identity, and a typed
-- table per setting keeps its CHECK and its "who set it, when" beside it.
--
-- WHO SET IT. set_by_account_id names the gym admin who saved the value; on
-- delete set null, so a departed admin does not delete the setting. The audit
-- stream holds each change with the old and new value (written by
-- stoppedComingPolicy.ts, SC-0a-2).
--
-- NO PERSON DATA. One number per gym and who set it. No athlete, attendance
-- or session is stored here.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-stopped-coming-policy-migration.mjs)
-- opens the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.organization_stopped_coming_policy (
  organization_id    text primary key
    references pilot.organizations(organization_id) on delete cascade,
  gap_days           integer not null
    constraint pilot_org_stopped_coming_gap_days_check check (gap_days in (7, 14, 21, 28, 42, 56)),
  set_by_account_id  text null references pilot.accounts(account_id) on delete set null,
  set_at             timestamptz not null default clock_timestamp()
);

-- Read once per stopped-coming page load, by organization: the primary key is
-- the access path, so there is no other index.

comment on table pilot.organization_stopped_coming_policy is
  'How many days without a present mark put an athlete on the "who has stopped coming" list, per organization (7, 14, 21, 28, 42 or 56; no row = 14). Set by the gym admin (OW27-30 A). Lane W4-6, SC-0a.';
