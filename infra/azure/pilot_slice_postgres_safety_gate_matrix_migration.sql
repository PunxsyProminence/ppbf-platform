-- Safety Gate Matrix (pilot.safety_gates, pilot.safety_gate_evaluations) --
-- generalizes the ad-hoc, single-purpose contact/medical clearance check
-- into reusable substrate, per the 2026-08-03 capability build plan's Phase 1
-- framing: "a Safety Gate Matrix table + evaluation module that
-- contactClearanceGate becomes one row of."
--
-- WHAT contactClearanceGate.ts ACTUALLY DOES, AND WHY THE MATRIX MUST NOT
-- FLATTEN IT
--
-- contactClearanceGate.ts is not a blocking gate. It deliberately FLAGS
-- rather than refuses: the route it guards records contact that already
-- happened, so refusing the write would not un-spar the athlete, it would
-- destroy the only record it occurred, and it would teach whoever is
-- logging to leave the contact fields blank next time. A different, real
-- gate (assertMedicalStatusAllowsRecommendation in shadowRecommendations.ts)
-- DOES block, guarding a pre-action decision instead of a post-action
-- record. Both are legitimate safety gates; they differ in enforcement, not
-- in correctness. A matrix that assumed every row blocks would invert
-- contactClearanceGate's carefully-reasoned behavior the first time
-- something read from it. `enforcement` is therefore a first-class column,
-- not a future extension: 'block' refuses the action outright, 'flag'
-- allows it and raises a near miss for human review.
--
-- THE TEACHING-MOMENT DOCTRINE (owner principle, 2026-08-03)
--
-- "A safety stop is a teaching moment, not just a wall." Every gate row
-- carries `requirement_text` -- what specifically earns a pass -- so a
-- refusal or flag can name what's missing and where to fix it, the way
-- MedicalStatusBlockedError already does for the one existing blocking
-- gate. The stop itself never softens; the lesson rides alongside it.
--
-- SEEDED PER ORGANIZATION, MATCHING compliance-rule-seeds
--
-- Same two guards as pilot_slice_postgres_compliance_rule_seeds_migration.sql,
-- for the same reasons: `where organization_id not in (...)` skips an
-- organization that already holds a gate under this NAME -- including one it
-- deactivated or edited -- and `on conflict do nothing` catches an
-- organization that renamed it (gate_id is deterministic, so the insert
-- collides with the row already there). An organization created after this
-- migration runs gets nothing from it; createOrganization (auth.ts) seeds
-- the same default inside the same transaction that creates the
-- organization, mirroring seedDefaultComplianceRules exactly.
--
-- safety_gate_evaluations IS APPEND-ONLY BY CONVENTION, NOT BY CONSTRAINT
--
-- One row per athlete per gate evaluation that actually happens --
-- contactClearanceGate.ts still short-circuits with zero DB calls for a
-- non-contact observation, so evaluation volume tracks real contact
-- observations, not every observation submitted. Both PASS and FLAG/BLOCK
-- outcomes are recorded (not only refusals), because the plan's own
-- doctrine calls for an audit trail of "was this athlete evaluated," and a
-- table that only ever recorded failures could not answer "when was this
-- athlete last checked."
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-safety-gate-matrix-migration.mjs) opens the
-- transaction itself, matching the goal-category-progress /
-- attendance-parent-method convention.

create table if not exists pilot.safety_gates (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  gate_id           text not null,
  gate_key          text not null,
  name              text not null,
  category          text not null check (category in ('medical', 'age', 'training_level', 'contact', 'equipment', 'behavioral', 'other')),
  enforcement       text not null check (enforcement in ('block', 'flag')),
  requirement_text  text not null,
  active_flag       boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (organization_id, gate_id),
  unique (organization_id, gate_key)
);

create table if not exists pilot.safety_gate_evaluations (
  organization_id          text not null references pilot.organizations(organization_id) on delete cascade,
  evaluation_id             text not null,
  gate_key                  text not null,
  athlete_id                text not null,
  outcome                   text not null check (outcome in ('passed', 'blocked', 'flagged')),
  reason                    text not null default '',
  evaluated_by_account_id   text not null,
  evaluated_by_role         text not null,
  context_id                text not null default '',
  metadata                  jsonb not null default '{}'::jsonb,
  evaluated_at              timestamptz not null,
  created_at                timestamptz not null default now(),
  primary key (organization_id, evaluation_id),
  foreign key (organization_id, gate_key)
    references pilot.safety_gates(organization_id, gate_key)
    on delete cascade,
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

create index if not exists idx_safety_gate_evaluations_org_athlete
  on pilot.safety_gate_evaluations(organization_id, athlete_id, evaluated_at desc);

create index if not exists idx_safety_gate_evaluations_org_gate
  on pilot.safety_gate_evaluations(organization_id, gate_key, evaluated_at desc);

-- The one gate that exists today: contactClearanceGate.ts's contact/medical
-- clearance check, registered as a 'flag' gate so the matrix's own
-- active_flag can be checked without changing its behavior.
insert into pilot.safety_gates (organization_id, gate_id, gate_key, name, category, enforcement, requirement_text, active_flag)
select
  organization_id,
  'gate_' || organization_id || '_contact_medical_clearance',
  'contact_medical_clearance',
  'Contact Requires Medical Clearance',
  'medical',
  'flag',
  'This athlete needs an explicit ''cleared'' medical administrative status on file before taking contact. Set status to ''cleared'' in the Medical Status panel once a clearance decision has been made; the observation is kept either way, and contact logged without a current clearance raises a near miss for coach/admin review.',
  true
from pilot.organizations
where organization_id not in (
  select organization_id from pilot.safety_gates where gate_key = 'contact_medical_clearance'
)
on conflict do nothing;
