-- SHADOW de-identification keys: let a purged person's SHADOW rows outlive
-- the person, with their keys replaced by a token -- and until the purge
-- that does the replacing is running, keep deleting them exactly as before.
--
-- Owner rulings (Jason): 2026-10-06 "delete any thing that personally
-- Identifys the person but we keep data that [makes] the Ai and ML better";
-- Q5 "Keep coaching, delete medical (Recommended)" (film-study proposals
-- and decision outcomes are de-identified and kept; medical and body-mass
-- rows are deleted); 2026-10-07 Q7 "2 years after deletion (Recommended)"
-- (safeguarding-flagged chats and their review-queue rows stay identified
-- until two years after the person's deletion, then are de-identified).
--
-- WHY. The retention purge (scripts/pilot-cleanup-deleted-data.mjs and
-- dataDeletion.ts purgeExpiredDeletedData) will replace account_id,
-- athlete_id and subject_id on these tables with one random token per
-- person (`anon_<uuid>`, kept nowhere else). A token satisfies no foreign
-- key onto pilot.accounts or pilot.athletes, so those keys go. Where a
-- table's own composite keys carry account_id onward (the evidence tables
-- key on (bundle_id, organization_id, account_id) and on the message's
-- (message_id, organization_id, account_id)), the purge has to update every
-- table in one transaction and have the keys checked at its end, so those
-- six keys become DEFERRABLE INITIALLY IMMEDIATE: unchanged for the app,
-- which never defers them, and deferrable for the purge (SET CONSTRAINTS
-- ... DEFERRED). Nothing here cascades on update: the purge writes every
-- table itself and counts what it wrote.
--
-- WHAT GOES. The ON DELETE CASCADE keys onto pilot.accounts(account_id) from
-- shadow_chat_sessions, shadow_chat_messages, shadow_evidence_bundles,
-- shadow_learning_events, shadow_recommendation_effectiveness,
-- shadow_human_review_queue and shadow_data_deletion_requests; the ON DELETE
-- CASCADE keys onto pilot.athletes(organization_id, athlete_id) from
-- shadow_chat_sessions, shadow_evidence_bundles (subject_id),
-- shadow_decisions, shadow_recommendations and shadow_film_study_proposals.
-- Keys that name staff (reviewed_by, decided_by, created_by, evaluated_by,
-- actor) stay.
--
-- WHAT TAKES THEIR PLACE, AND WHY THE ORDER OF RELEASE CANNOT MATTER. Today
-- neither purge path deletes these rows itself: both delete the account or
-- the athlete and the cascades take the SHADOW rows with it (the only SHADOW
-- table either path names is shadow_chat_memory_corrections; #1306 adds the
-- profiles, jobs, buckets, snapshots and the chat log). Dropping the
-- cascades alone would therefore make the purge KEEP a guardian's chat
-- sessions and messages (their own words, under an account_id that is their
-- email) and a child's decisions, recommendations and film-study proposals
-- (under an athlete_id the roster can reissue) whenever this migration is
-- applied before the de-identifying purge is deployed -- which is the normal
-- order here, because the deploy gate (pilot-verify-schema) requires every
-- migration applied first. So this migration also installs two BEFORE
-- DELETE row triggers, on pilot.accounts and pilot.athletes, that delete
-- exactly the rows the dropped cascades deleted, from the same tables, with
-- the same downstream cascades (messages follow their session, outcomes
-- their decision, items and claims and citations their bundle and message).
-- A delete that has NOT de-identified first behaves as it did before this
-- migration: nothing identified survives. The de-identifying purge, and only
-- it, declares itself with `set local ppbf.shadow_purge = 'deidentify'` in
-- the transaction that first re-keys the rows to tokens; the triggers then
-- yield, so the tokened rows and the rows Q7 holds back stay. A setting made
-- with `set local` dies with its transaction, so the declaration cannot leak.
--
-- WHAT IS ADDED. On shadow_chat_sessions and shadow_human_review_queue:
-- deidentified_at (the purge stamps it; readers and the Q7 sweep key on it;
-- it is how a row says it no longer names anyone) and subject_deleted_at
-- (when the person the row names was deleted: a guardian's account row, and
-- the deleted_at on it, is purged a year after deletion, and the Q7 sweep two
-- years after needs the date it would otherwise have lost). A check on each
-- table ties the stamp to the token: deidentified_at is set exactly when
-- account_id is an anon_ token (and, on sessions, athlete_id is null or a
-- token), so a half-written purge cannot report a row de-identified.
--
-- Found by shape, not by name: the original keys were auto-named by
-- Postgres. The account keys are matched by their column (conkey), not by
-- the text of pg_get_constraintdef, which drops the `pilot.` qualifier when
-- pilot is on the role's search_path and would then match nothing.
-- Idempotent: a re-run finds nothing to drop and every named object present.
-- No begin;/commit; here, matching the runner-opens-the-transaction
-- convention; the runner is
-- apps/web/scripts/pilot-apply-shadow-deidentify-keys-migration.mjs, whose
-- readiness query refuses if any of the dropped shapes remains, any of the
-- six deferrable keys, two triggers, four columns or two checks is missing.

do $shadow_deidentify_keys$
declare
  stale record;
begin
  for stale in
    select c.conrelid::regclass as rel, c.conname
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid in (
         to_regclass('pilot.shadow_chat_sessions'),
         to_regclass('pilot.shadow_chat_messages'),
         to_regclass('pilot.shadow_evidence_bundles'),
         to_regclass('pilot.shadow_learning_events'),
         to_regclass('pilot.shadow_recommendation_effectiveness'),
         to_regclass('pilot.shadow_human_review_queue'),
         to_regclass('pilot.shadow_data_deletion_requests')
       )
       and c.confrelid = to_regclass('pilot.accounts')
       and c.conkey = array(
             select a.attnum from pg_attribute a
              where a.attrelid = c.conrelid and a.attname = 'account_id'
           )::int2[]
  loop
    execute format('alter table %s drop constraint %I', stale.rel, stale.conname);
  end loop;

  for stale in
    select c.conrelid::regclass as rel, c.conname
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid in (
         to_regclass('pilot.shadow_chat_sessions'),
         to_regclass('pilot.shadow_evidence_bundles'),
         to_regclass('pilot.shadow_decisions'),
         to_regclass('pilot.shadow_recommendations'),
         to_regclass('pilot.shadow_film_study_proposals')
       )
       and c.confrelid = to_regclass('pilot.athletes')
  loop
    execute format('alter table %s drop constraint %I', stale.rel, stale.conname);
  end loop;

  -- The six composite keys that carry account_id between the evidence tables
  -- and the messages: same columns, same delete actions, now deferrable.
  for stale in
    select c.conrelid::regclass as rel, c.conname
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid in (
         to_regclass('pilot.shadow_evidence_items'),
         to_regclass('pilot.shadow_evidence_claims'),
         to_regclass('pilot.shadow_message_citations')
       )
       and c.confrelid in (
         to_regclass('pilot.shadow_evidence_bundles'),
         to_regclass('pilot.shadow_evidence_items'),
         to_regclass('pilot.shadow_chat_messages')
       )
       and not c.condeferrable
  loop
    execute format('alter table %s drop constraint %I', stale.rel, stale.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_evidence_items_bundle_fk') then
    alter table pilot.shadow_evidence_items
      add constraint pilot_shadow_evidence_items_bundle_fk
      foreign key (bundle_id, organization_id, account_id)
      references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
      on delete cascade deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_evidence_claims_message_fk') then
    alter table pilot.shadow_evidence_claims
      add constraint pilot_shadow_evidence_claims_message_fk
      foreign key (assistant_message_id, organization_id, account_id)
      references pilot.shadow_chat_messages(message_id, organization_id, account_id)
      on delete cascade deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_evidence_claims_bundle_fk') then
    alter table pilot.shadow_evidence_claims
      add constraint pilot_shadow_evidence_claims_bundle_fk
      foreign key (bundle_id, organization_id, account_id)
      references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
      deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_message_citations_message_fk') then
    alter table pilot.shadow_message_citations
      add constraint pilot_shadow_message_citations_message_fk
      foreign key (assistant_message_id, organization_id, account_id)
      references pilot.shadow_chat_messages(message_id, organization_id, account_id)
      on delete cascade deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_message_citations_item_fk') then
    alter table pilot.shadow_message_citations
      add constraint pilot_shadow_message_citations_item_fk
      foreign key (evidence_id, bundle_id, organization_id, account_id)
      references pilot.shadow_evidence_items(evidence_id, bundle_id, organization_id, account_id)
      deferrable initially immediate;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_message_citations_bundle_fk') then
    alter table pilot.shadow_message_citations
      add constraint pilot_shadow_message_citations_bundle_fk
      foreign key (bundle_id, organization_id, account_id)
      references pilot.shadow_evidence_bundles(bundle_id, organization_id, account_id)
      deferrable initially immediate;
  end if;
end
$shadow_deidentify_keys$;

alter table pilot.shadow_chat_sessions
  add column if not exists deidentified_at timestamptz null,
  add column if not exists subject_deleted_at timestamptz null;

alter table pilot.shadow_human_review_queue
  add column if not exists deidentified_at timestamptz null,
  add column if not exists subject_deleted_at timestamptz null;

-- The stamp means the token, and the token means the stamp. `anon\_`: the
-- underscore is literal, not LIKE's any-one-character.
do $shadow_deidentify_checks$
begin
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_chat_sessions_deidentified_check') then
    alter table pilot.shadow_chat_sessions
      add constraint pilot_shadow_chat_sessions_deidentified_check
      check (
        (deidentified_at is not null) = (account_id like 'anon\_%')
        and (deidentified_at is null or athlete_id is null or athlete_id like 'anon\_%')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilot_shadow_human_review_queue_deidentified_check') then
    alter table pilot.shadow_human_review_queue
      add constraint pilot_shadow_human_review_queue_deidentified_check
      check ((deidentified_at is not null) = (account_id like 'anon\_%'));
  end if;
end
$shadow_deidentify_checks$;

comment on column pilot.shadow_chat_sessions.deidentified_at is
  'Set by the retention purge when this conversation stopped naming anyone: account_id and athlete_id are then a per-person anon_<uuid> token, never a login or an athlete record.';

comment on column pilot.shadow_chat_sessions.subject_deleted_at is
  'When the person this conversation names was deleted (their deleted_at, copied before their account row is purged): a flagged conversation is de-identified two years after this (Jason 2026-10-07).';

comment on column pilot.shadow_human_review_queue.deidentified_at is
  'Set when this review entry stopped naming anyone (two years after the person''s deletion, Jason 2026-10-07): account_id is then a per-person anon_<uuid> token, and summary/metadata hold no name.';

comment on column pilot.shadow_human_review_queue.subject_deleted_at is
  'When the person this review entry names was deleted (their deleted_at, copied before their account row is purged): the entry is de-identified two years after this (Jason 2026-10-07).';

-- The cascades, continued by hand until the purge declares that it has
-- de-identified first. Same tables, same rows, same downstream cascades as
-- the keys this migration drops: nothing a delete used to take is left.
create or replace function pilot.shadow_rows_follow_account()
returns trigger
language plpgsql
as $pilot_shadow_rows_follow_account$
begin
  if current_setting('ppbf.shadow_purge', true) = 'deidentify' then
    return old;
  end if;
  delete from pilot.shadow_chat_sessions where account_id = old.account_id;
  delete from pilot.shadow_chat_messages where account_id = old.account_id;
  delete from pilot.shadow_evidence_bundles where account_id = old.account_id;
  delete from pilot.shadow_learning_events where account_id = old.account_id;
  delete from pilot.shadow_recommendation_effectiveness where account_id = old.account_id;
  delete from pilot.shadow_human_review_queue where account_id = old.account_id;
  delete from pilot.shadow_data_deletion_requests where account_id = old.account_id;
  return old;
end;
$pilot_shadow_rows_follow_account$;

drop trigger if exists pilot_shadow_rows_follow_account on pilot.accounts;
create trigger pilot_shadow_rows_follow_account
  before delete on pilot.accounts
  for each row
  execute function pilot.shadow_rows_follow_account();

create or replace function pilot.shadow_rows_follow_athlete()
returns trigger
language plpgsql
as $pilot_shadow_rows_follow_athlete$
begin
  if current_setting('ppbf.shadow_purge', true) = 'deidentify' then
    return old;
  end if;
  delete from pilot.shadow_chat_sessions
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  delete from pilot.shadow_evidence_bundles
   where organization_id = old.organization_id and subject_id = old.athlete_id;
  delete from pilot.shadow_decisions
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  delete from pilot.shadow_recommendations
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  delete from pilot.shadow_film_study_proposals
   where organization_id = old.organization_id and athlete_id = old.athlete_id;
  return old;
end;
$pilot_shadow_rows_follow_athlete$;

drop trigger if exists pilot_shadow_rows_follow_athlete on pilot.athletes;
create trigger pilot_shadow_rows_follow_athlete
  before delete on pilot.athletes
  for each row
  execute function pilot.shadow_rows_follow_athlete();
