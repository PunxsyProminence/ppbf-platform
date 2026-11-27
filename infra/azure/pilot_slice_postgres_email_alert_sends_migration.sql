-- The email alert send log and the sweep's checkpoints
-- (pilot.email_alert_sends, pilot.email_alert_checkpoints): lane W4-1, PR EM-3
-- (W4 item 1, docs/content-review/w4-sizing/W4_SIZING.md section 1; plan on
-- #2159, sections 4 and 5).
--
-- WHY. OD-2026-11-19-019: an opt-in, content-free email that says only "open
-- the app". OW27-03 B: one email per event per person. Q1.10: "a send log
-- (who, when, which kind) to prevent repeats and resume after a restart". The
-- sender (src/server/pilot/emailAlertSender.ts, EM-3b, not yet built) is to
-- work from this table: one row per (gym, person, event kind, event row),
-- written only for a person whose switch is on, and whose gym has that event
-- ticked for their user type, when the sweep finds an event they can read.
-- Nothing in this table ties a row to a switch; that rule is the sender's.
-- Each row is claimed, re-checked and sent on the server's worker tick.
--
-- WHAT A ROW HOLDS. Who (gym, account, user type), which event (its kind and
-- its row id), when, and the send's state: queued, sending (claimed under a
-- lease), sent, skipped (a re-check before the send said no, with the reason)
-- or failed (no more tries), the try count, the next try time and the last
-- error's code. No address column and no content: the address is read at send
-- time (the sign-in address, or an adult athlete's confirmed one on
-- pilot.email_alert_switches) and the email says only "open the app".
-- THE ACCOUNT ID IS USUALLY AN ADDRESS. An invite with no account id (the
-- admin console's invite sends none) gives the person their sign-in address as
-- their account_id, staff and parents alike (staffProvisioning.ts,
-- `|| loginEmail`), and a guardian move makes a parent login the same way
-- (guardianLoginMove.ts). Other ids are typed by an admin, with no shape
-- check. So for most staff and parents this row's account_id is their address,
-- as in every table keyed by account.
--
-- WHAT THE DATABASE REFUSES (each a named CHECK, compared in full by the
-- runner):
--   * a user type other than the three, or an event kind of the wrong shape
--     (the same rules as pilot.organization_email_alert_events);
--   * an event id that is not a UUID: every event source mints one
--     (randomUUID in escalationLadder.ts; uuid columns for family message
--     replies, coach notes, announcements and family thread posts);
--   * an error code of any shape but a bare word (extractGraphErrorCode's
--     shape in graphMailer.ts), so no address fits (a single word still does);
--   * a status other than the five; more than 5 tries (plan 5.4), or a
--     queued row with none left;
--   * a lease on a row that is not being sent, or a row being sent without
--     one; a finished time on an unfinished row, or the reverse;
--   * a skip without its reason, a reason off the list, or a reason on a row
--     that was not skipped; an HTTP status outside 100-599.
-- One row per (gym, account, event kind, event id), so the sweep's overlap and
-- a restart never make a second row. A person can still get a second email
-- for one event (EM-3b): a send cut off after Graph took it but before its row
-- says sent is sent again when its lease runs out, if it has a try left (cut
-- off on its fifth try, it is marked failed: a queued row must have a try
-- left); a Graph timeout or 5xx after Graph accepted the mail is retried; and
-- a person with two accounts at one address gets one email per account.
--
-- DELETION (Overwatch GO on #2159, condition 4). All three keys cascade, as on
-- pilot.email_alert_switches: a row goes when its gym's row, its account row
-- or the person's membership of that gym is deleted. Which of those are ever
-- deleted (scripts/pilot-cleanup-deleted-data.mjs, docs/DATA_RETENTION.md
-- Method 1):
--   * a parent account is hard-deleted by the purge, a manual apply=APPLY
--     run, once its account retention window has passed (later for a guardian
--     held for safeguarding chats), and its rows go with it;
--   * an athlete login is kept by the purge (retired by UPDATE) and a staff
--     account is never hard-deleted, so their rows stay;
--   * a soft-deleted account, or a membership switched off (the app switches
--     memberships off, it does not delete them), keeps its rows.
-- A row that stays holds the account id (usually an address, above), gym,
-- user type, event kind and id, status, skip reason (which can
-- say the person's sign-in was off or they were no longer offered alerts) and
-- times. The event id is not a foreign key (the events live in several
-- tables), so a purged event leaves its id here. The retention period is not
-- ruled (docs/DATA_RETENTION.md row). pilot.email_alert_checkpoints holds no
-- person data.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-email-alert-sends-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.email_alert_sends (
  send_id           bigint generated always as identity primary key,
  organization_id   text not null
    references pilot.organizations(organization_id) on delete cascade,
  account_id        text not null
    references pilot.accounts(account_id) on delete cascade,
  user_type         text not null
    constraint pilot_email_alert_send_user_type_check
      check (user_type in ('staff', 'parent', 'adult_athlete')),
  event_kind        text not null
    constraint pilot_email_alert_send_kind_check
      check (event_kind ~ '^[a-z][a-z_]{0,62}$'),
  event_id          text not null
    constraint pilot_email_alert_send_event_id_check
      check (event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  status            text not null default 'queued'
    constraint pilot_email_alert_send_status_check
      check (status in ('queued', 'sending', 'sent', 'skipped', 'failed')),
  tries             integer not null default 0
    constraint pilot_email_alert_send_tries_check
      check (tries between 0 and 5),
  next_try_at       timestamptz not null default clock_timestamp(),
  lease_token       uuid null,
  lease_expires_at  timestamptz null,
  skip_reason       text null
    constraint pilot_email_alert_send_skip_reason_check
      check (skip_reason in ('switched_off', 'gym_unticked', 'sign_in_off', 'not_offered', 'no_address')),
  last_status_code  integer null
    constraint pilot_email_alert_send_status_code_check
      check (last_status_code between 100 and 599),
  last_error_code   text null
    constraint pilot_email_alert_send_error_code_check
      check (last_error_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  created_at        timestamptz not null default clock_timestamp(),
  finished_at       timestamptz null,
  -- The person's membership of this gym, as on pilot.email_alert_switches
  -- (Codex P1 on #2168): a send can only name an account in a gym it has a
  -- membership row in.
  constraint pilot_email_alert_send_membership_fk
    foreign key (account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade,
  constraint pilot_email_alert_send_once_key
    unique (organization_id, account_id, event_kind, event_id),
  constraint pilot_email_alert_send_lease_check
    check ((status = 'sending') = (lease_token is not null)
           and (lease_token is null) = (lease_expires_at is null)),
  constraint pilot_email_alert_send_finished_check
    check ((status in ('sent', 'skipped', 'failed')) = (finished_at is not null)),
  constraint pilot_email_alert_send_skipped_check
    check ((status = 'skipped') = (skip_reason is not null)),
  -- A row back in the queue has a try left: the fifth failed try ends it.
  constraint pilot_email_alert_send_queued_tries_check
    check (status <> 'queued' or tries < 5)
);

-- The sender claims queued rows whose time has come, oldest first, and
-- recovers rows whose lease ran out (a server stopped mid-send).
create index if not exists idx_email_alert_sends_queued
  on pilot.email_alert_sends (next_try_at)
  where status = 'queued';
create index if not exists idx_email_alert_sends_leased
  on pilot.email_alert_sends (lease_expires_at)
  where status = 'sending';

comment on table pilot.email_alert_sends is
  'Email alert send log: one row per gym, person, event kind and event row (OW27-03 B; Q1.10). Who, which event, when, and the send state. No address column and no content; an account id can itself be a sign-in address. Lane W4-1, EM-3.';

-- How far the sweep has read each event kind's source (plan 5.1). The sweep
-- re-reads a 10-minute overlap behind swept_to, so a row that commits late is
-- not missed; the send log's one-row key absorbs the overlap.
create table if not exists pilot.email_alert_checkpoints (
  event_kind  text primary key
    constraint pilot_email_alert_checkpoint_kind_check
      check (event_kind ~ '^[a-z][a-z_]{0,62}$'),
  swept_to    timestamptz not null,
  updated_at  timestamptz not null default clock_timestamp()
);

comment on table pilot.email_alert_checkpoints is
  'How far the email alert sweep has read each event kind (plan 5.1). No person data. Lane W4-1, EM-3.';
