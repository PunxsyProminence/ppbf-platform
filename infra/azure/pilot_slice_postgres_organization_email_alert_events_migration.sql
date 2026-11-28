-- The gym's choice of which events send the email alert, per user type
-- (pilot.organization_email_alert_events): lane W4-1, PR EM-5 (W4 item 1,
-- docs/content-review/w4-sizing/W4_SIZING.md section 1).
--
-- WHY. OW27-10 A: "The gym's organization admin chooses, for each user type
-- (staff, parents, athletes 18 or over), which events can send the email, on
-- a gym settings page." This table is that choice: one row per gym, user type
-- and event that the organization admin has set.
--
-- ABSENCE MEANS TICKED. OW27-39 A: "All ticked; each person still opts in".
-- A gym with no row for a (user type, event) pair has that event turned on;
-- a row records the admin's choice, ticked or not. Deploying this migration
-- writes no row, so every gym starts with every event ticked. Each person's
-- own switch (pilot.email_alert_switches, EM-1) still starts off: nothing is
-- sent to anyone who has not switched email on.
--
-- WHICH EVENTS. The list per user type is in src/shared/emailAlerts.ts (EM-5b)
-- (EMAIL_ALERT_EVENTS; Overwatch's Q1.9 reading on #2050, the notice kind
-- only, GO on #2159 condition 1). It is checked in code, not here, so an event
-- can join the list without a migration (W4-4's "parent's new message", EM-4c,
-- GO on #2159 Q-2). The database holds only a well-formed key.
--
-- WHO SET IT. set_by_account_id names the organization admin who saved the
-- row; on delete set null, so a departed admin does not delete the setting.
-- The audit stream holds each change with the old and new value.
--
-- WHAT IS STORED. A gym setting: which events, for which user type, and who
-- set it. No athlete, parent or event content is stored here, and no address
-- column. The only person named is the admin who set it, by account id, which
-- is usually their sign-in address (see the email-alert-switches migration).
--
-- DELETION (Overwatch GO on #2159, condition 4). The gym key cascades: a
-- deleted gym takes its rows with it. Staff accounts are never hard-deleted
-- (the purge deletes parent accounts only), so the setter stays; were an
-- admin's account row deleted, the key would clear set_by_account_id and keep
-- the rows. The retention period is not ruled (docs/DATA_RETENTION.md row).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-email-alert-events-migration.mjs)
-- opens the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.organization_email_alert_events (
  organization_id    text not null
    references pilot.organizations(organization_id) on delete cascade,
  user_type          text not null
    constraint pilot_org_email_alert_event_user_type_check
      check (user_type in ('staff', 'parent', 'adult_athlete')),
  event_kind         text not null
    constraint pilot_org_email_alert_event_kind_check
      check (event_kind ~ '^[a-z][a-z_]{0,62}$'),
  ticked             boolean not null,
  set_by_account_id  text null references pilot.accounts(account_id) on delete set null,
  set_at             timestamptz not null default clock_timestamp(),
  primary key (organization_id, user_type, event_kind)
);

-- Read by gym (the drawer, EM-6) and by gym, user type and event (the sender,
-- EM-3, not yet built): the primary key is the access path for both.

comment on table pilot.organization_email_alert_events is
  'Which events send the opt-in email alert, per gym and user type (staff, parent, adult_athlete). No row = ticked (OW27-39 A). Set by the organization admin (OW27-10 A). Lane W4-1, EM-5.';
