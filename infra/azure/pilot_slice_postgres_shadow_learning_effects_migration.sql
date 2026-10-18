-- Which learning effects one SHADOW feedback event has already had
-- (lane L46 item 1; ChatGPT non-video ML audit 2026-10-17; Overwatch GO,
-- option A "exactly once").
--
-- WHAT CHANGES. pilot.shadow_feedback gains learning_effects_done, a list of
-- the effects of this feedback that must not happen twice:
--   library_flag  this feedback has added one to its topic's flag_count in
--                 pilot.shadow_library_review_flags (client flag, approval
--                 flag or Library proposal);
--   facts         this feedback's observations are counted in the person's
--                 remembered facts (upsertRememberedFact counts every call);
--   complete      every effect that applied to the approval succeeded.
-- It is NOT NULL, empty by default, and the values are closed by a CHECK.
--
-- WHY. Approval used to report success because a learning-event row existed,
-- even when a fact, flag or research write had failed beside it, and a retry
-- after a failed log write repeated the remembered-fact increment. The flag
-- count skipped +1 only when the topic row's LATEST feedback was the same
-- one, so a feedback re-processed after another flag landed counted twice.
-- The code that ships with this column (lane L46 PR B) writes each mark in
-- the same transaction as the effect it records, so from then on one
-- feedback counts once and a retry skips what already happened.
--
-- WHY ON shadow_feedback. The feedback row is the one durable record per
-- feedback event; shadow_learning_events has a row per verification state,
-- and the flags table holds one row per topic. No personal data is added:
-- the values are effect names.
--
-- BACKFILL, ONCE, from what the learning log already records. It runs only in
-- the transaction that adds the column: on a re-apply (the workflow's `all`
-- runs every migration on every release) the column exists and nothing is
-- re-marked, so a later approval that PR B leaves without 'complete' on
-- purpose is never stamped complete by a release.
--   * 'complete' where a human_reviewed learning event exists and its logged
--     actions record no failure. An approval whose log shows a failed write
--     stays repairable: approving it again re-runs only what is safe to repeat.
--   * 'facts' where that event logs facts extracted, so a repair never
--     re-counts them.
--   * 'library_flag' where any of the feedback's learning events logs that its
--     flag or proposal write succeeded. The loop pushes those strings only
--     after the write returned (shadowLearningLoop.ts), so a logged action is
--     a counted flag.
--
-- DEPENDS ON shadow-runtime (pilot.shadow_feedback, pilot.shadow_learning_events).
-- No begin;/commit; here; the runner
-- (apps/web/scripts/pilot-apply-shadow-learning-effects-migration.mjs) opens
-- the transaction. Idempotent: the column and its backfill only when the
-- column is absent, the constraint only when absent.

do $$
begin
  if to_regclass('pilot.shadow_feedback') is null
     or to_regclass('pilot.shadow_learning_events') is null then
    raise exception 'SHADOW_LEARNING_EFFECTS_REQUIRES_SHADOW_RUNTIME: apply shadow-runtime first';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'pilot' and table_name = 'shadow_feedback'
       and column_name = 'learning_effects_done'
  ) then
    return;
  end if;

  alter table pilot.shadow_feedback
    add column learning_effects_done text[] not null default '{}'::text[];

  update pilot.shadow_feedback f
     set learning_effects_done = array_append(f.learning_effects_done, 'complete')
   where exists (
     select 1 from pilot.shadow_learning_events e
      where e.feedback_id = f.feedback_id
        and e.verification_state = 'human_reviewed'
        and not exists (
          select 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(e.actions_taken) = 'array' then e.actions_taken else '[]'::jsonb end
            ) as action(value)
           where action.value like '%failed%'
              or action.value like '%skipped%'
              or action.value like '%unavailable%'
        )
   );

  update pilot.shadow_feedback f
     set learning_effects_done = array_append(f.learning_effects_done, 'facts')
   where exists (
     select 1
       from pilot.shadow_learning_events e
       cross join lateral jsonb_array_elements_text(
         case when jsonb_typeof(e.actions_taken) = 'array' then e.actions_taken else '[]'::jsonb end
       ) as action(value)
      where e.feedback_id = f.feedback_id
        and e.verification_state = 'human_reviewed'
        and action.value like 'Extracted % fact(s) from positive signal'
   );

  update pilot.shadow_feedback f
     set learning_effects_done = array_append(f.learning_effects_done, 'library_flag')
   where exists (
     select 1
       from pilot.shadow_learning_events e
       cross join lateral jsonb_array_elements_text(
         case when jsonb_typeof(e.actions_taken) = 'array' then e.actions_taken else '[]'::jsonb end
       ) as action(value)
      where e.feedback_id = f.feedback_id
        and (
          action.value = 'Client feedback queued for human review; no learning was promoted'
          or action.value like 'Library entry flagged for review (topic: %'
          or action.value like 'Library ''%'' proposal queued for human review'
        )
   );
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shadow_feedback_learning_effects_done_check'
                 and conrelid = 'pilot.shadow_feedback'::regclass) then
    alter table pilot.shadow_feedback add constraint shadow_feedback_learning_effects_done_check
      check (learning_effects_done <@ array['library_flag', 'facts', 'complete']::text[]);
  end if;
end
$$;
