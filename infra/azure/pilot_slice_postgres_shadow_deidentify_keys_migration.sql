-- SHADOW de-identification keys: let a purged person's SHADOW rows outlive
-- the person, with their keys replaced by a token.
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
-- Deleting an account or an athlete no longer removes these rows: the purge
-- de-identifies them instead, in the same transaction, and until that code
-- ships (the next PR) nothing deletes a pilot.accounts row except that purge,
-- which already deletes a guardian's SHADOW rows explicitly. Keys that name
-- staff (reviewed_by, decided_by, created_by, evaluated_by, actor) stay.
--
-- WHAT IS ADDED. deidentified_at on shadow_chat_sessions and
-- shadow_human_review_queue: the purge stamps it, readers and the Q7 sweep
-- key on it, and it is how a row says it no longer names anyone.
--
-- Found by shape, not by name: the original keys were auto-named by
-- Postgres. Idempotent: a re-run finds nothing to drop and every named key
-- present. No begin;/commit; here, matching the runner-opens-the-transaction
-- convention; the runner is
-- apps/web/scripts/pilot-apply-shadow-deidentify-keys-migration.mjs, whose
-- readiness query refuses if any of the dropped shapes remains or any of the
-- six deferrable keys is missing.

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
       and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (account_id) REFERENCES pilot.accounts(account_id)%'
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
  add column if not exists deidentified_at timestamptz null;

alter table pilot.shadow_human_review_queue
  add column if not exists deidentified_at timestamptz null;

comment on column pilot.shadow_chat_sessions.deidentified_at is
  'Set by the retention purge when this conversation stopped naming anyone: account_id and athlete_id are then a per-person anon_<uuid> token, never a login or an athlete record.';

comment on column pilot.shadow_human_review_queue.deidentified_at is
  'Set when this review entry stopped naming anyone (two years after the person''s deletion, Jason 2026-10-07): account_id is then a per-person anon_<uuid> token, and summary/metadata hold no name.';
