-- Medical administrative clearance: an optional, enforced expiry.
--
-- pilot.shadow_medical_administrative_status is the gate every medically
-- sensitive path consults: contactClearanceGate.ts flags contact logged
-- without it, and assertMedicalStatusAllowsRecommendation refuses to write a
-- recommendation or a decision against an athlete who is not 'cleared'. Both
-- read the LATEST row and compared its status by bare equality, with no time
-- bound at all -- so a single 'cleared' row recorded once counted as a current
-- clearance forever. A physician's clearance from eighteen months ago read
-- exactly the same to those gates as one signed this morning.
--
-- This adds the missing structure: a per-record expiry the human recording the
-- clearance can state, enforced at every read (shadowMedicalStatus.ts's
-- isClearanceCurrent / effectiveMedicalStatus, which both gates now call).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: pick a default duration.
--
-- Nullable, with null meaning "no stated expiry", is not a hedge -- it is the
-- only honest posture available to this change. How long a youth contact-sport
-- medical clearance stays valid is an open RESEARCH question in this
-- repository, not a coding decision: docs/HANDOFF_RESEARCH.md item 1 has
-- "renewal and expiry intervals per instrument, and what 'lapsed' should mean
-- operationally" listed as work still needing sourced answers for Act 153 /
-- SafeSport / USA Boxing, under the standing instruction "do not close any
-- item below by picking a plausible number." A NOT NULL column with an
-- invented default would have written a fabricated clinical interval into
-- every child's safety record and made every gate enforce it.
--
-- Existing rows therefore keep exactly the behaviour they have today (null =>
-- no automatic timeout, re-confirmation is a human act), and nothing that
-- currently succeeds starts failing. When the owner confirms a validity
-- window, the follow-up is a default plus a backfill decision -- both of which
-- need that answer first.
--
-- Idempotent: add column if not exists, guarded constraint, no drops, no
-- destructive alters, no writes to any existing row.

alter table pilot.shadow_medical_administrative_status
  add column if not exists expires_at timestamptz null;

-- An expiry that precedes the moment the clearance took effect is not an
-- expiry, it is a data-entry error that would read as a permanently-lapsed
-- clearance. Checked in the database as well as at the route, because this
-- table's whole value is that a gate can trust what it reads.
--
-- now() is deliberately absent: a CHECK must be immutable, and re-validating
-- rows against the current clock would make an ordinary, correct historical
-- record un-updatable later.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shadow_medical_status_expires_after_effective_check'
      and conrelid = 'pilot.shadow_medical_administrative_status'::regclass
  ) then
    alter table pilot.shadow_medical_administrative_status
      add constraint shadow_medical_status_expires_after_effective_check
      check (expires_at is null or expires_at > effective_at);
  end if;
end
$$;
