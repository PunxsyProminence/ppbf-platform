-- Each person's email alert switch (pilot.email_alert_switches): lane W4-1,
-- PR EM-1 (W4 item 1, docs/content-review/w4-sizing/W4_SIZING.md section 1).
--
-- WHY. Jason, OD-2026-11-19-019: an opt-in, content-free email that says only
-- "open the app". OW27-10 A: the gym picks the events per user type (EM-5),
-- and "each person turns their own email on or off with one switch on their
-- own settings page". This table is that switch: one row per person per gym.
--
-- WHO MAY HAVE ONE (OW27-02 C, "B plus athletes 18 or over"): coach, admin
-- and organization admin (user type 'staff'), parents ('parent'), and
-- athletes 18 or over ('adult_athlete'; no date of birth counts as a minor,
-- OD-2026-10-04-010). The roles 'staff', 'volunteer', 'board' and
-- 'platform_owner' get none. NOTE: the user type 'staff' is OW27-10's word
-- for coaches and admins; it is NOT the 'staff' account role, which has no
-- switch. src/shared/emailAlerts.ts maps role to user type, explicitly.
-- user_type records which of the three the switch was set under: the sender
-- (EM-3, not yet built) is to re-read the person's role and age before every
-- send and send nothing when they no longer match.
--
-- OFF UNTIL THE PERSON TURNS IT ON. Each person's switch starts off
-- (OD-2026-11-19-019, opt-in; OW27-39 A keeps it so). A person with no row
-- is off. Deploying this migration writes no row.
--
-- THE ADULT ATHLETE'S ADDRESS (OW27-38 B, "Typed, then confirmed with a
-- code"). Athletes sign in with a PIN and have no address
-- (credentialPolicy.ts), so an adult athlete types one. It is used only after
-- they enter the code the app emails to it (EM-2b). The pending_* columns hold
-- the typed address and the hash of its code until then; confirmed_address is
-- the only address the sender may use. EM-1 writes none of these columns;
-- they are here so EM-2b needs no migration. Every other person's alerts go to
-- their sign-in address (pilot.accounts.login_email), which this table has no
-- column for. BUT THE ACCOUNT ID IS USUALLY THAT ADDRESS: an invite with no
-- account id (the admin console's invite sends none) gives the person their
-- sign-in address as their account_id, staff and parents alike
-- (staffProvisioning.ts, `|| loginEmail`), and a guardian move makes a parent
-- login the same way (guardianLoginMove.ts). Other ids are typed by an admin,
-- with no shape check. So for most staff and parents this row's account_id is
-- their address, as in every table keyed by account.
--
-- WHAT THE DATABASE REFUSES (each a named CHECK, compared in full by the
-- runner):
--   * a user type other than the three;
--   * an adult athlete's switch on with no confirmed address (Overwatch GO on
--     #2159, condition 3: no control that does nothing);
--   * an address on a staff or parent row (their address is the sign-in one);
--   * a switch on with no time it was turned on;
--   * a code without its expiry, or the reverse; a code with no typed address;
--     a confirmed address without its time, or the reverse; a negative try
--     count.
--
-- DELETION (Overwatch GO on #2159, condition 4). All three keys cascade, so a
-- row goes when its gym's pilot.organizations row, its pilot.accounts row or
-- the person's pilot.organization_memberships row for that gym is deleted.
-- Which accounts are ever deleted (scripts/pilot-cleanup-deleted-data.mjs,
-- docs/DATA_RETENTION.md Method 1):
--   * a parent account is hard-deleted by the purge -> its row goes;
--   * an athlete login is NOT deleted: the purge keeps it, retired, and clears
--     its email, PIN and password by UPDATE, so the cascade never fires and
--     the switch row, and from EM-2b an adult athlete's confirmed address,
--     would stay. EM-1 writes no address. Overwatch's answer A on #2168 puts
--     the removal of the row, in the purge's athlete branch, into EM-2b (the
--     purge already deletes such a login's SHADOW memory corrections there for
--     the same reason);
--   * a staff account (coach, admin) is never hard-deleted: its row stays,
--     with no address column filled (a CHECK forbids it), holding its
--     account_id (which can be the sign-in address, above), on/off and times.
-- A soft-deleted account (accounts.deleted_at set, Method 2), or a membership
-- switched off (the app switches memberships off, it does not delete them),
-- keeps its row. So the sender (EM-3, not yet built) is to send only to an
-- active, not-deleted account with an active membership in that gym, checked
-- before every send.
-- The retention period is not ruled (docs/DATA_RETENTION.md row).
--
-- AUDIT. Every change of the switch writes an audit row (on/off, before and
-- after). No address column is ever written to the audit stream; the audit row
-- names the account by its account_id, which can be the address (above).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-email-alert-switches-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.email_alert_switches (
  organization_id          text not null
    references pilot.organizations(organization_id) on delete cascade,
  account_id               text not null
    references pilot.accounts(account_id) on delete cascade,
  user_type                text not null
    constraint pilot_email_alert_switch_user_type_check
      check (user_type in ('staff', 'parent', 'adult_athlete')),
  switched_on              boolean not null default false,
  switched_on_at           timestamptz null,
  switched_off_at          timestamptz null,
  set_at                   timestamptz not null default clock_timestamp(),
  pending_address          text null,
  pending_code_hash        text null,
  pending_code_expires_at  timestamptz null,
  pending_code_attempts    integer not null default 0,
  confirmed_address        text null,
  confirmed_at             timestamptz null,
  primary key (organization_id, account_id),
  -- The person's membership of this gym (Codex P1 on #2168): a switch can only
  -- name an account in a gym it has a membership row in, active or not (the
  -- sender checks it is active). The coach_development pattern.
  constraint pilot_email_alert_switch_membership_fk
    foreign key (account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade,
  constraint pilot_email_alert_switch_athlete_confirmed_check
    check (user_type <> 'adult_athlete' or not switched_on or confirmed_address is not null),
  constraint pilot_email_alert_switch_address_athlete_only_check
    check (user_type = 'adult_athlete'
           or (pending_address is null and pending_code_hash is null and confirmed_address is null)),
  constraint pilot_email_alert_switch_on_time_check
    check (not switched_on or switched_on_at is not null),
  constraint pilot_email_alert_switch_code_pair_check
    check ((pending_code_hash is null) = (pending_code_expires_at is null)),
  constraint pilot_email_alert_switch_confirmed_pair_check
    check ((confirmed_address is null) = (confirmed_at is null)),
  constraint pilot_email_alert_switch_attempts_check
    check (pending_code_attempts >= 0),
  constraint pilot_email_alert_switch_code_needs_address_check
    check (pending_code_hash is null or pending_address is not null)
);

-- The sender (EM-3, not yet built) is to read the switched-on rows of one gym;
-- the primary key serves a person's own read. The partial index holds only
-- switched-on rows. A switched-on row is not proof the person may still
-- receive: a role, age or membership can change after the switch was set, so
-- the sender is to re-check each person before every send.
create index if not exists idx_email_alert_switches_on
  on pilot.email_alert_switches (organization_id, account_id)
  where switched_on;

comment on table pilot.email_alert_switches is
  'Each person''s opt-in email alert switch, one row per person per gym (no row = off). User type staff (coach/admin/organization admin), parent or adult_athlete (OW27-02 C). An adult athlete''s confirmed address is the only address stored here (OW27-38 B). Lane W4-1, EM-1.';
