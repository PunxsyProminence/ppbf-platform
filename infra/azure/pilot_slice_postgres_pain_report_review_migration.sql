-- Pain report review: the athlete's optional note on a pain report, and the
-- coach's "Mark reviewed" record of who reviewed it and when.
--
-- WHY. A pain report carried only a body location, a pain type and a 1-10
-- severity, and nothing on it ever changed after it was filed: the coach's
-- pain list could not say whether anyone had looked at it (DR-25). Jason
-- 2026-11-23, DR-25 A (to be recorded): "A: Add both". The plan and
-- Overwatch's GO (Q1-Q5 all A) are on PR #2133.
--
-- WHERE IT LIVES, AND WHY HERE. A pain report is a pilot.shadow_near_misses
-- row whose metadata->>'trigger' is 'athlete_pain_report'
-- (apps/web/src/server/pilot/formulas/painReportAlert.ts). The coach's pain
-- list reads exactly those rows, gated to coach, organization_admin and admin
-- and then per athlete (GET /api/pilot/coach/pain-reports). Columns, not
-- metadata, for two reasons: the note's length limit and the reviewer's
-- foreign key are held by the database, and the other near-miss reader
-- (listNearMisses, shadowNearMisses.ts) selects an explicit column list, so a
-- new column reaches no reader until code names it. Nothing here is written
-- to the observation row, the shadow event payload, the near-miss
-- description or any escalation: those reach other readers (the SHADOW feed
-- reaches athletes and parents), and this note must not.
--
-- WHAT CHANGES. Four nullable-or-defaulted columns on pilot.shadow_near_misses:
--   athlete_note             -- the athlete's own words, or NULL when none
--                               were written. Every existing row stays NULL.
--                               No default: an empty string would make "no
--                               note" look like "a note of nothing".
--   athlete_note_admin_only  -- true when the note's safety scan said it is
--                               for an admin only (it names gym staff, or it
--                               carries a grooming, secrecy or touch cue):
--                               coaches are then not shown the note at all.
--                               Stored on the same row as the note, so a note
--                               can never reach a coach ahead of its flag.
--                               Default false, which is every existing row.
--   reviewed_by_account_id   -- the staff account that pressed "Mark
--                               reviewed", or NULL. ON DELETE SET NULL: the
--                               review stays recorded when the account goes.
--   reviewed_at              -- when it was reviewed, or NULL.
-- Two checks:
--   pilot_shadow_near_misses_athlete_note_check -- a note, when present, is 1
--     to 500 characters (characters, not bytes) with no leading or trailing
--     space. btrim strips only the ASCII space; the application trims all
--     whitespace and turns an empty note into NULL, and this check is what
--     holds when a later writer forgets to.
--   pilot_shadow_near_misses_reviewed_check -- a reviewer is never recorded
--     without a time. A time without a reviewer is allowed: it is what a
--     review looks like after the reviewer's account is deleted.
-- One foreign key: pilot_shadow_near_misses_reviewed_by_fk ->
--   pilot.accounts(account_id) ON DELETE SET NULL.
-- Who may write a note (the athlete, about themselves) and who may mark a
-- report reviewed (the readers of the coach pain list) are application rules,
-- enforced where they are written; this file adds no role check.
--
-- Requires pilot.shadow_near_misses
-- (pilot_slice_postgres_shadow_decision_loop_migration.sql) and pilot.accounts
-- (the base schema); the `all` chain runs both first.
--
-- Idempotent: add column if not exists; each check and the foreign key are
-- added only when the table has no constraint of that name, so a re-run (the
-- `all` chain) does not re-scan the table. A same-named constraint with any
-- other definition is left for the runner's readiness check to refuse.
-- Additive only: nothing is dropped or rewritten. No `begin;`/`commit;` here:
-- the runner (apps/web/scripts/pilot-apply-pain-report-review-migration.mjs)
-- opens the transaction.

alter table pilot.shadow_near_misses
  add column if not exists athlete_note text null;

alter table pilot.shadow_near_misses
  add column if not exists athlete_note_admin_only boolean not null default false;

alter table pilot.shadow_near_misses
  add column if not exists reviewed_by_account_id text null;

alter table pilot.shadow_near_misses
  add column if not exists reviewed_at timestamptz null;

do $pilot_shadow_near_misses_pain_report_review$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_near_misses_athlete_note_check'
      and conrelid = to_regclass('pilot.shadow_near_misses')
  ) then
    alter table pilot.shadow_near_misses
      add constraint pilot_shadow_near_misses_athlete_note_check check (
        athlete_note is null
        or (
          char_length(athlete_note) between 1 and 500
          and athlete_note = btrim(athlete_note)
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_near_misses_reviewed_check'
      and conrelid = to_regclass('pilot.shadow_near_misses')
  ) then
    alter table pilot.shadow_near_misses
      add constraint pilot_shadow_near_misses_reviewed_check check (
        reviewed_by_account_id is null or reviewed_at is not null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_shadow_near_misses_reviewed_by_fk'
      and conrelid = to_regclass('pilot.shadow_near_misses')
  ) then
    alter table pilot.shadow_near_misses
      add constraint pilot_shadow_near_misses_reviewed_by_fk
      foreign key (reviewed_by_account_id)
      references pilot.accounts(account_id) on delete set null;
  end if;
end
$pilot_shadow_near_misses_pain_report_review$;

comment on column pilot.shadow_near_misses.athlete_note is
  'The athlete''s own optional note on a pain report, or NULL when none was written. Read only by the coach pain list (coach, organization_admin, admin, per athlete); never copied to the observation, the shadow event, the description or an escalation. 1-500 characters, no leading or trailing space (pilot_shadow_near_misses_athlete_note_check).';

comment on column pilot.shadow_near_misses.athlete_note_admin_only is
  'True when the note''s safety scan routed it to admins only (names gym staff, or a grooming, secrecy or touch cue). Coaches are then shown no note and no marker; organization admins and admins see it.';

comment on column pilot.shadow_near_misses.reviewed_by_account_id is
  'The staff account that marked this pain report reviewed, or NULL when nobody has (or the account was deleted after reviewing; reviewed_at then still holds the time).';

comment on column pilot.shadow_near_misses.reviewed_at is
  'When this pain report was marked reviewed, or NULL when it has not been. The first review is kept; a later press does not move it.';
