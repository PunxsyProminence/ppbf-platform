-- The email alert send log and the sweep's checkpoints
-- (pilot.email_alert_sends, pilot.email_alert_checkpoints): lane W4-1, PR EM-3
-- (W4 item 1, docs/content-review/w4-sizing/W4_SIZING.md section 1; plan on
-- #2159, sections 4 and 5).
--
-- WHY. OD-2026-11-19-019: an opt-in, content-free email that says only "open
-- the app". OW27-03 B: one email per event per person. Q1.10: "a send log
-- (who, when, which kind) to prevent repeats and resume after a restart". The
-- sender (src/server/pilot/emailAlertSender.ts) works from this table: one row
-- per (gym, person, event kind, event row), written when the sweep finds an
-- event the person can read, and claimed, re-checked and sent on the server's
-- worker tick.
--
-- WHAT A ROW HOLDS. Who (gym, account, user type), which event (its kind and
-- its row id), when, and the send's state: queued, sending (claimed under a
-- lease), sent, skipped (a re-check before the send said no, with the reason)
-- or failed (no more tries), the try count, the next try time and the last
-- error's code. NO ADDRESS AND NO CONTENT: the address is read at send time
-- (the sign-in address, or an adult athlete's confirmed one on
-- pilot.email_alert_switches) and the email says only "open the app".
--
-- WHAT THE DATABASE REFUSES (each a named CHECK, compared in full by the
-- runner):
--   * a user type other than the three, or an event kind of the wrong shape
--     (the same rules as pilot.organization_email_alert_events);
--   * an event id or an error code of any shape an address or free text could
--     take: letters, digits and a few separators only, no '@', bounded;
--   * a status other than the five; more than 5 tries (plan 5.4);
--   * a lease on a row that is not being sent, or a row being sent without
--     one; a finished time on an unfinished row, or the reverse;
--   * a skip without its reason, a reason off the list, or a reason on a row
--     that was not skipped; an HTTP status outside 100-599.
-- One row per (gym, account, event kind, event id), so a restart neither
-- resends nor skips (OW27-03 B, Q1.10).
--
-- DELETION (Overwatch GO on #2159, condition 4). All three keys cascade, as on
-- pilot.email_alert_switches: a row goes when its gym's row, its account row
-- or the person's membership of that gym is deleted. A parent account
-- hard-deleted by the purge takes its rows. An athlete login is kept by the
-- purge (retired by UPDATE) and a staff account is never hard-deleted, so
-- their rows stay; they hold no address and no content, only the account id,
-- gym, user type, event kind and event id, and times. The event id is not a
-- foreign key (the events live in several tables), so a purged event leaves
-- its id here. The retention period is not ruled (docs/DATA_RETENTION.md row).
-- pilot.email_alert_checkpoints holds no person data.
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
      check (event_id ~ '^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$'),
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
    check ((status = 'skipped') = (skip_reason is not null))
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
  'Email alert send log: one row per gym, person, event kind and event row (OW27-03 B; Q1.10). Who, which event, when, and the send state. No address and no content. Lane W4-1, EM-3.';

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
