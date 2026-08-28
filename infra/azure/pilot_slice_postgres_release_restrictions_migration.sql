-- A staff-only signal that release or contact restrictions apply to an athlete.
--
-- WHAT THIS IS. One bit per athlete, meaning: "restrictions apply to who may
-- collect or contact this child -- speak to the welfare lead." It is a POINTER
-- TO A HUMAN, not a record of the restriction.
--
-- WHAT THIS IS DELIBERATELY NOT. It is not a custody model, a protective-order
-- register, an authorized-pickup list, or a legal-document store. PPBF has none
-- of those and this migration does not begin one. Owner decision, 2026-08-28:
-- a minimal staff-only signal, with no legal narrative stored in the platform.
--
-- WHY THERE IS NO TEXT COLUMN, AND WHY THAT IS THE WHOLE DESIGN.
--
-- The failure mode for a table like this is not that it holds too little. It is
-- that somebody pastes a custody arrangement, a court order reference, or "the
-- father is not allowed near her" into a free-text field, and the platform
-- becomes the store of record for a legal determination it cannot verify, keep
-- current, or be accountable for. That is already happening in the least
-- structured place available: an emergency-contact note in this repository's
-- own gate fixtures reads "Do not call this contact without speaking to the
-- welfare lead first."
--
-- A schema cannot stop somebody writing prose somewhere. It CAN refuse to offer
-- a column to write it in. So this table has exactly one boolean and the
-- provenance of that boolean. There is nowhere here to put a narrative, by
-- construction, and adding one later should require arguing with this comment.
--
-- WHY A SEPARATE TABLE RATHER THAN A COLUMN ON pilot.athletes.
--
-- /api/pilot/athletes/list selects `a.*` for a parent, so any column added to
-- pilot.athletes reaches every linked guardian automatically. That is exactly
-- how pilot.waivers came to hand one household the other's staff notes. A
-- separate table cannot be reached by that query at all: the projection is
-- staff-only because no parent-facing query joins it, not because somebody
-- remembered to exclude a column.
--
-- WHY NOT pilot.safety_flags, WHICH ALREADY EXISTS. It is a training-safety
-- table -- load spikes, clearance expiry, rest periods -- whose flag_class is
-- ('system_guidance','external_rule'), and it carries four free-text narrative
-- columns (trigger_detail, evidence_basis, confidence_note, coach_note). Worse
-- for this purpose, pilot_safety_flags_note_required MANDATES a coach_note of
-- at least ten characters to resolve a flag. Filing release restrictions there
-- would require writing the narrative this design exists to refuse.
--
-- DEPENDS ON pilot.organizations, pilot.accounts, pilot.athletes. No
-- begin;/commit; here on purpose, matching this repo's runner-opens-the-
-- transaction convention (the runner is
-- apps/web/scripts/pilot-apply-release-restrictions-migration.mjs).

create table if not exists pilot.athlete_release_restrictions (
  organization_id   text not null references pilot.organizations(organization_id) on delete cascade,
  athlete_id        text not null,

  -- The signal itself. A row exists only while the answer is meaningful; the
  -- column is here rather than implied by row existence so that lifting a
  -- restriction is an UPDATE with provenance rather than a DELETE that erases
  -- who set it and when.
  restrictions_apply boolean not null default true,

  -- Provenance. Who put this here, and who last changed it. These are the only
  -- other facts this table holds.
  set_by_account_id     text not null references pilot.accounts(account_id) on delete restrict,
  set_at                timestamptz not null default now(),
  updated_by_account_id text not null references pilot.accounts(account_id) on delete restrict,
  updated_at            timestamptz not null default now(),

  constraint pilot_athlete_release_restrictions_pkey
    primary key (organization_id, athlete_id),
  constraint pilot_athlete_release_restrictions_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade
);

-- The read is always "does this athlete have restrictions", scoped to one
-- organization. Partial on the true case because that is the question asked on
-- a gym floor; a cleared row is of interest only to an audit.
create index if not exists idx_athlete_release_restrictions_active
  on pilot.athlete_release_restrictions(organization_id, athlete_id)
  where restrictions_apply;

-- on delete restrict on both provenance columns, not set null: an account that
-- set a restriction may be deactivated, but the record of who set it must not
-- be quietly emptied. Retiring such an account is a deliberate act that this
-- constraint forces somebody to notice.
