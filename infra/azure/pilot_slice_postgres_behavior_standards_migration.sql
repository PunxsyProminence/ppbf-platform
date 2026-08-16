-- Behavior standards (register module 125, owner answer 2026-08-16:
-- "both, with escalation separate").
--
-- WHAT THIS IS: the gym's posted expectations -- show up, help a
-- teammate, reset after frustration -- as org-level definitions, plus a
-- TYPED LINK so recognizing an athlete for meeting one is the same
-- recognition record the platform already gives.
--
-- WHAT THIS DELIBERATELY IS NOT: a per-athlete conduct log. There is no
-- table here for "what this child did wrong", no severity scale on a
-- minor's behavior, and no free-text discipline note field. A concern
-- about conduct files into the EXISTING safety-escalation ladder
-- (source_type 'incident'), where an org admin sees it and it is
-- acknowledged and resolved on the record. Concerns get HANDLED, not
-- filed loosely -- that is the whole point of routing them there.
--
-- The positive path therefore lands in pilot.recognitions (which already
-- carries the coach's name as it stood that day), and this migration only
-- adds the standard_id link so "met the standard" is a typed fact rather
-- than a string match on a note.
--
-- Idempotent: create table/index/column if not exists, no drops.

-- recognition_kind maps a posted standard onto the EXISTING recognition
-- vocabulary (helped_someone, showed_up_hard_day, back_after_a_loss,
-- took_the_correction, ...). That vocabulary was written carefully and in
-- human words; a posted standard names the gym's own expectation and says
-- which of those recognitions evidences it, rather than inventing a
-- parallel taxonomy or widening a good one with a generic value.
create table if not exists pilot.behavior_standards (
  organization_id       text not null references pilot.organizations(organization_id) on delete cascade,
  standard_id           text not null,
  standard_name         text not null check (length(btrim(standard_name)) > 0),
  description           text not null default '',
  recognition_kind      text not null,
  sort_order            integer not null default 100,
  active                boolean not null default true,
  created_by_account_id text not null references pilot.accounts(account_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (organization_id, standard_id),
  constraint pilot_behavior_standards_kind_check
    check (recognition_kind in (
      'helped_someone', 'showed_up_hard_day', 'back_after_a_loss',
      'worked_when_it_was_hard', 'good_partner', 'took_the_correction',
      'in_early_and_ready', 'left_it_better', 'spoke_up_well',
      'looked_after_someone_new'
    ))
);

create index if not exists idx_behavior_standards_active
  on pilot.behavior_standards(organization_id, active, sort_order);

-- Typed link from a recognition to the standard it recognizes. Nullable:
-- most recognitions are not about a posted standard, and none is required
-- to be.
alter table pilot.recognitions
  add column if not exists standard_id text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('pilot.recognitions')
      and conname = 'pilot_recognitions_standard_fk'
  ) then
    alter table pilot.recognitions
      add constraint pilot_recognitions_standard_fk
      foreign key (organization_id, standard_id)
      references pilot.behavior_standards(organization_id, standard_id) on delete set null;
  end if;
end $$;

comment on column pilot.recognitions.standard_id is
  'Optional typed link to a posted behavior standard (module 125). Recognition is the ONLY per-athlete behavior record: conduct concerns route to pilot.safety_escalations, never to a note field here.';
