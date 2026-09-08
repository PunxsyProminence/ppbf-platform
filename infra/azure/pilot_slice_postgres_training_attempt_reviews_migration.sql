-- Coach attempt review (pilot.training_attempt_reviews, pilot.v_training_attempts_effective)
-- BASE-06: a coach CONFIRMS, CORRECTS or DISPUTES an athlete's training
-- attempt. The athlete-source attempt is EVIDENCE and is never rewritten by a
-- review -- this file adds no update or delete path back into
-- pilot.training_attempts, and the trigger below refuses to let a review
-- itself be edited after the fact.
--
-- ADDITIVE AND PROVENANCE-PRESERVING. A review is a NEW row that references
-- the source attempt. The same failure-first ledger the athlete and coach
-- already write (pilot.training_attempts, owner decision 2026-08-16) stays the
-- one and only attempt ledger; this is not a second attempt record and carries
-- no copy of the source target/achieved/made/note/context/metric -- those
-- belong to the attempt. It carries only the coach's judgement about it.
--
-- WHY A CORRECTION IS NOT AN EDIT. If a coach's correction overwrote the
-- athlete's numbers, the disagreement -- which is itself the signal a coach
-- review exists to record -- would be destroyed in the act of recording it.
-- So the source values stay exactly as the athlete entered them, the coach's
-- corrected values live here, and pilot.v_training_attempts_effective is where
-- the two are reconciled into ONE current interpretation for everything
-- downstream. This is the same shape pilot.activity_log_adjustments +
-- pilot.v_activity_effective_minutes already use for floor-hours corrections:
-- append the correction, never touch the source, and make every consumer read
-- the effective view so a correction propagates everywhere at once.
--
-- MANY REVIEWS PER ATTEMPT, NEWEST WINS, HISTORY KEPT. A coach may dispute an
-- attempt and later confirm or correct it; each review is its own dated row and
-- the current disposition is simply the newest one. The earlier dispute stays
-- in the table -- disagreement remains visible, which the review loop exists to
-- guarantee. Nothing here amends a review in place (the freeze trigger below),
-- following pilot.athlete_development_block_reviews and the calibration tables.
--
-- THE VERDICT IS THE SERVER'S, HERE TOO. corrected_made is computed by the
-- writing module from the corrected target/achieved and the attempt's own
-- stored direction, exactly as trainingAttempts.recordAttempt computes made --
-- the client never supplies a verdict. The made-requires-target rule the
-- source table enforces is enforced here for the corrected pair as well: a
-- corrected attempt with no target is a corrected measurement and carries no
-- verdict.
--
-- DISPUTE IS ABSTENTION, NOT A MISS. When the current disposition is disputed,
-- the effective verdict is NULL -- verdict-bearing analytics (false-progress
-- transfer counts) must count a disputed attempt as neither a make nor a miss,
-- while event-only consumers still see that the attempt occurred. The source
-- numbers stay readable; only the EFFECTIVE numbers abstain.
--
-- Idempotent like every migration in this directory: create table/index/view
-- if not exists (view via create-or-replace), drop-and-create the trigger, no
-- destructive alters, safe to re-run wholesale.

create table if not exists pilot.training_attempt_reviews (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  review_id                text not null,
  attempt_id               text not null,
  review_state             text not null
                           check (review_state in ('confirmed', 'corrected', 'disputed')),
  -- Corrected values are legal ONLY for a corrected review, and a corrected
  -- review must carry an achieved value. Target stays optional: a corrected
  -- measurement (no target) is as legal as a source measurement.
  corrected_target_value   numeric null check (corrected_target_value is null or corrected_target_value > 0),
  corrected_achieved_value numeric null check (corrected_achieved_value is null or corrected_achieved_value >= 0),
  corrected_made           boolean null,
  reason                   text not null default '',
  reviewed_by_account_id   text not null references pilot.accounts(account_id),
  reviewed_at              timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  primary key (organization_id, review_id),
  -- Tenancy rides the composite attempt key; a review cannot claim an attempt
  -- from another organization, and if the attempt (or its athlete) is purged
  -- the review goes with it -- retention/erasure keeps working unchanged.
  constraint pilot_attempt_reviews_attempt_fk
    foreign key (organization_id, attempt_id)
    references pilot.training_attempts(organization_id, attempt_id) on delete cascade,
  -- Corrected fields belong to, and only to, a corrected review.
  constraint pilot_attempt_reviews_corrected_only_when_corrected
    check (
      review_state = 'corrected'
      or (corrected_target_value is null and corrected_achieved_value is null and corrected_made is null)
    ),
  -- A corrected review states what actually happened: an achieved value is
  -- required, and the verdict-requires-target rule holds (target null iff
  -- verdict null), matching pilot_training_attempts_made_check.
  constraint pilot_attempt_reviews_corrected_shape
    check (
      review_state <> 'corrected'
      or (corrected_achieved_value is not null
          and ((corrected_target_value is null) = (corrected_made is null)))
    ),
  -- A correction or a dispute without a stated reason is indistinguishable
  -- from tampering (the floor-hours adjustment rule). A confirmation needs
  -- none. The explicit whitespace set is deliberate: btrim's one-argument form
  -- trims spaces only, so E'\t\n' would satisfy it while a JavaScript caller's
  -- .trim() calls the same string empty -- the database would be the looser
  -- layer. Same fix, same reason, as pilot.athlete_development_block_reviews.
  constraint pilot_attempt_reviews_reason_required
    check (
      review_state = 'confirmed'
      or length(btrim(reason, E' \t\n\r')) >= 10
    )
);

-- The reading the effective view needs: the newest review for one attempt.
create index if not exists idx_attempt_reviews_current
  on pilot.training_attempt_reviews(organization_id, attempt_id, reviewed_at desc, review_id desc);

-- APPEND-ONLY BY TRIGGER. A review records what a coach attested at a moment;
-- re-deciding it in place would overwrite that attestation. Deletes are left
-- to the retention cascade above; only in-place UPDATE is refused. Same
-- mechanism as the calibration freeze triggers.
create or replace function pilot.training_attempt_reviews_freeze()
returns trigger
language plpgsql
as $pilot_attempt_reviews_freeze$
begin
  raise exception 'TRAINING_ATTEMPT_REVIEW_IMMUTABLE'
    using errcode = 'restrict_violation';
  return null;
end;
$pilot_attempt_reviews_freeze$;

drop trigger if exists pilot_attempt_reviews_freeze
  on pilot.training_attempt_reviews;
create trigger pilot_attempt_reviews_freeze
  before update on pilot.training_attempt_reviews
  for each row
  execute function pilot.training_attempt_reviews_freeze();

-- THE ONE CURRENT INTERPRETATION. One row per source attempt: the athlete's
-- source fields, the current review (newest by reviewed_at, stable tiebreak on
-- review_id), and the effective values every verdict consumer reads instead of
-- the raw attempt. security_invoker so the view runs with the querying role's
-- own privileges, matching pilot.v_activity_effective_minutes.
--
--   unreviewed / confirmed -> effective = source
--   corrected              -> effective = corrected values + server verdict
--   disputed               -> effective target/achieved/made = NULL (abstain)
--
-- Source columns are ALWAYS present and unchanged; only the effective_* columns
-- move. recorded_by_role lets a surface say "recorded by athlete" vs "by coach"
-- without exposing the account id.
create or replace view pilot.v_training_attempts_effective
  with (security_invoker = true) as
select
  t.organization_id,
  t.attempt_id,
  t.athlete_id,
  a.full_name                         as athlete_name,
  t.context_type,
  t.context_id,
  t.metric_kind,
  t.direction,
  t.target_value,
  t.achieved_value,
  t.made,
  t.note,
  t.attempted_at,
  t.recorded_by_account_id,
  rec.role                            as recorded_by_role,
  t.created_at,
  r.review_id                         as current_review_id,
  r.review_state,
  r.corrected_target_value,
  r.corrected_achieved_value,
  r.corrected_made,
  r.reason                            as review_reason,
  r.reviewed_by_account_id,
  r.reviewed_at,
  case
    when r.review_state = 'disputed'  then null
    when r.review_state = 'corrected' then r.corrected_target_value
    else t.target_value
  end                                 as effective_target_value,
  case
    when r.review_state = 'disputed'  then null
    when r.review_state = 'corrected' then r.corrected_achieved_value
    else t.achieved_value
  end                                 as effective_achieved_value,
  case
    when r.review_state = 'disputed'  then null
    when r.review_state = 'corrected' then r.corrected_made
    else t.made
  end                                 as effective_made
from pilot.training_attempts t
join pilot.athletes a
  on a.organization_id = t.organization_id and a.athlete_id = t.athlete_id
left join pilot.accounts rec
  on rec.account_id = t.recorded_by_account_id
left join lateral (
  select tr.review_id, tr.review_state,
         tr.corrected_target_value, tr.corrected_achieved_value, tr.corrected_made,
         tr.reason, tr.reviewed_by_account_id, tr.reviewed_at
  from pilot.training_attempt_reviews tr
  where tr.organization_id = t.organization_id and tr.attempt_id = t.attempt_id
  order by tr.reviewed_at desc, tr.review_id desc
  limit 1
) r on true;

comment on table pilot.training_attempt_reviews is
  'BASE-06 coach attempt review (owner-ratified 2026-09-08): additive, provenance-preserving. A confirm/correct/dispute row referencing a source attempt in pilot.training_attempts, which is never rewritten. Newest review is the current disposition; history is kept; a corrected verdict is server-computed; a disputed attempt abstains from effective verdict via pilot.v_training_attempts_effective.';
