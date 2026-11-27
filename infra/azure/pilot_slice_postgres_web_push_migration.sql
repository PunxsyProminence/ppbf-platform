-- Web push: each browser a person turned push on in, and the push send log
-- with its sweep checkpoints (pilot.push_subscriptions,
-- pilot.push_alert_sends, pilot.push_alert_checkpoints): lane W5-WP, PR WP-1a
-- (W4 item 2, docs/content-review/w4-sizing/W4_SIZING.md section 2; plan and
-- GO on #2228).
--
-- WHY. OD-2026-11-19-019 put web push "later"; Jason started it on
-- 2026-11-26. OW27-18 A: push follows the gym's email event picks, one per
-- event, to no switched-off account. OW27-17 B: a device marked as a gym
-- tablet never offers push (the mark is in that browser, gymTabletMark.ts, so
-- the screen enforces it, not this table). The pop-up says only "Open the
-- app" (QE A on #2228), so no table here holds what happened.
--
-- pilot.push_subscriptions: one row per browser a person turned push on in,
-- per gym, as the browser's PushSubscription gives it: the push service's
-- endpoint, the browser's public key (p256dh) and its auth secret (auth, a
-- secret: never logged, audited or shown). web-push 3.6.7 (QD A on #2228)
-- needs p256dh to decode to exactly 65 bytes and auth to at least 16 (its
-- src/encryption-helper.js). It does NOT limit where it sends: it parses the
-- endpoint with url.parse and posts to whatever host and port that gives
-- (src/web-push-lib.js), so the CHECK below takes only an https URL whose host
-- is a plain DNS name (letters, digits, dots, hyphens, ending in a letter
-- label: no IP literal, no port, no userinfo, no brackets) followed by a path
-- of printable characters with no '@' or backslash. That is a backstop, not
-- the guard: the store (WP-1b, not built yet) is to check the same, and the
-- sender (WP-2, not built yet) is to refuse a host that resolves to a private,
-- loopback or link-local address. One person per browser per gym: a browser
-- turned on in a gym by someone else is to move to them (WP-1b), and a person
-- in two gyms keeps a row in each. No user agent, device name or IP.
-- device_key_hash is to hold the SHA-256 (hex) of a random key the browser
-- holds in an HttpOnly cookie, written only if Jason answers QB B on #2228
-- (Logout on that device ends its push); under QB A it stays null. So either
-- answer fits without a migration (Overwatch GO on #2228). user_type records
-- which of the three it was saved under; the sender is to re-check the
-- person before every send.
--
-- pilot.push_alert_sends and pilot.push_alert_checkpoints: the shape of the
-- email send log (pilot.email_alert_sends, lane W4-1 EM-3a), for push (QC A1
-- on #2228). One row per gym, person, event kind and event row, so the sweep
-- queues one send per person per event; a send goes to every browser the
-- person has in that gym at send time, so a send row names no browser and
-- keeps one outcome for all of them. A person can still see an event twice,
-- as with the email: a send cut off after a push service took it but before
-- its row says sent is tried again when its lease runs out; a retry after one
-- browser took it and another failed goes to both again. The pop-up's one tag
-- (public/sw.js, WP-1c) makes a repeat replace the first on a device. No
-- content, no endpoint. 'switched_off' is a skip reason only if Jason answers
-- QA B (the email switch also gates push). The event id is not a foreign key
-- (events live in several tables). pilot.push_alert_checkpoints holds no
-- person data.
--
-- THE ACCOUNT ID IS USUALLY AN ADDRESS. As on pilot.email_alert_switches: an
-- invite with no account id gives the person their sign-in address as their
-- account_id (staffProvisioning.ts, `|| loginEmail`; guardianLoginMove.ts).
--
-- DELETION. Every person key cascades: a row goes when its gym, its account
-- or the person's membership of that gym is deleted. A parent account is
-- hard-deleted by the purge (docs/DATA_RETENTION.md Method 1), taking its
-- rows. An athlete login is kept by the purge (retired by UPDATE) and a staff
-- account is never hard-deleted, so their rows stay: the purge's athlete
-- branch is to delete a retired login's pilot.push_subscriptions rows, in the
-- first WP PR built after EM-2b-1 (#2218) merges (QG A on #2228); its send
-- rows stay, as the email send log's do. A soft-deleted account or a
-- membership switched off keeps its rows; the sender is to send to neither.
-- The retention period is not ruled (docs/DATA_RETENTION.md rows).
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-web-push-migration.mjs) opens the transaction
-- and checks every column, CHECK, key and index below in full. Idempotent.

create table if not exists pilot.push_subscriptions (
  subscription_id  bigint generated always as identity primary key,
  organization_id  text not null
    references pilot.organizations(organization_id) on delete cascade,
  account_id       text not null
    references pilot.accounts(account_id) on delete cascade,
  user_type        text not null
    constraint pilot_push_subscription_user_type_check
      check (user_type in ('staff', 'parent', 'adult_athlete')),
  endpoint         text not null
    constraint pilot_push_subscription_endpoint_check
      check (endpoint ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?[.])+[A-Za-z]{2,63}/[!-~]*$'
             and strpos(endpoint, '@') = 0 and strpos(endpoint, chr(92)) = 0
             and length(endpoint) <= 2048),
  key_p256dh       text not null
    constraint pilot_push_subscription_p256dh_check
      check (key_p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  key_auth         text not null
    constraint pilot_push_subscription_auth_check
      check (key_auth ~ '^[A-Za-z0-9_-]{22,128}$'),
  device_key_hash  text null
    constraint pilot_push_subscription_device_key_check
      check (device_key_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default clock_timestamp(),
  saved_at         timestamptz not null default clock_timestamp(),
  -- The person's membership of this gym (Codex P1 on #2168, as on
  -- pilot.email_alert_switches).
  constraint pilot_push_subscription_membership_fk
    foreign key (account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade,
  -- One person per browser per gym. Endpoint first, so "this browser is gone"
  -- (a push service's 404 or 410) finds every gym's row by endpoint alone.
  constraint pilot_push_subscription_endpoint_key unique (endpoint, organization_id)
);

-- The sweep asks "does this person have a browser on in this gym"; a person
-- lists their own.
create index if not exists idx_push_subscriptions_person
  on pilot.push_subscriptions (organization_id, account_id);

comment on table pilot.push_subscriptions is
  'Web push: one row per browser a person turned push on in, per gym (endpoint, the browser''s public key and its auth secret; no user agent, device or IP). One person per browser per gym. An account id can itself be a sign-in address. Lane W5-WP, WP-1a.';

create table if not exists pilot.push_alert_sends (
  send_id           bigint generated always as identity primary key,
  organization_id   text not null
    references pilot.organizations(organization_id) on delete cascade,
  account_id        text not null
    references pilot.accounts(account_id) on delete cascade,
  user_type         text not null
    constraint pilot_push_alert_send_user_type_check
      check (user_type in ('staff', 'parent', 'adult_athlete')),
  event_kind        text not null
    constraint pilot_push_alert_send_kind_check
      check (event_kind ~ '^[a-z][a-z_]{0,62}$'),
  event_id          text not null
    constraint pilot_push_alert_send_event_id_check
      check (event_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  status            text not null default 'queued'
    constraint pilot_push_alert_send_status_check
      check (status in ('queued', 'sending', 'sent', 'skipped', 'failed')),
  tries             integer not null default 0
    constraint pilot_push_alert_send_tries_check
      check (tries between 0 and 5),
  next_try_at       timestamptz not null default clock_timestamp(),
  lease_token       uuid null,
  lease_expires_at  timestamptz null,
  skip_reason       text null
    constraint pilot_push_alert_send_skip_reason_check
      check (skip_reason in ('switched_off', 'gym_unticked', 'sign_in_off', 'not_offered', 'no_subscription')),
  last_status_code  integer null
    constraint pilot_push_alert_send_status_code_check
      check (last_status_code between 100 and 599),
  last_error_code   text null
    constraint pilot_push_alert_send_error_code_check
      check (last_error_code ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  created_at        timestamptz not null default clock_timestamp(),
  finished_at       timestamptz null,
  constraint pilot_push_alert_send_membership_fk
    foreign key (account_id, organization_id)
    references pilot.organization_memberships(account_id, organization_id) on delete cascade,
  constraint pilot_push_alert_send_once_key
    unique (organization_id, account_id, event_kind, event_id),
  constraint pilot_push_alert_send_lease_check
    check ((status = 'sending') = (lease_token is not null)
           and (lease_token is null) = (lease_expires_at is null)),
  constraint pilot_push_alert_send_finished_check
    check ((status in ('sent', 'skipped', 'failed')) = (finished_at is not null)),
  constraint pilot_push_alert_send_skipped_check
    check ((status = 'skipped') = (skip_reason is not null)),
  -- A row back in the queue has a try left: the fifth failed try ends it.
  constraint pilot_push_alert_send_queued_tries_check
    check (status <> 'queued' or tries < 5)
);

create index if not exists idx_push_alert_sends_queued
  on pilot.push_alert_sends (next_try_at)
  where status = 'queued';
create index if not exists idx_push_alert_sends_leased
  on pilot.push_alert_sends (lease_expires_at)
  where status = 'sending';

comment on table pilot.push_alert_sends is
  'Web push send log: one row per gym, person, event kind and event row (OW27-18 A). Who, which event, when, and the send state. No content and no endpoint; an account id can itself be a sign-in address. Lane W5-WP, WP-1a.';

-- How far the push sweep has read each event source. The sweep re-reads an
-- overlap behind swept_to; the send log's one-row key absorbs it.
create table if not exists pilot.push_alert_checkpoints (
  event_kind  text primary key
    constraint pilot_push_alert_checkpoint_kind_check
      check (event_kind ~ '^[a-z][a-z_]{0,62}$'),
  swept_to    timestamptz not null,
  updated_at  timestamptz not null default clock_timestamp()
);

comment on table pilot.push_alert_checkpoints is
  'How far the web push sweep has read each event source. No person data. Lane W5-WP, WP-1a.';
