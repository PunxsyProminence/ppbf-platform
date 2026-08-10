-- Clearance register with role-graded requirements -- P-05.
--
-- WHAT EXISTED BEFORE THIS: nothing. A column scan across the pilot schema
-- found one clearance-like column -- pilot.medical_intake.clearance_status
-- -- which is MEDICAL, not safeguarding. pilot.volunteers is
-- (volunteer_id, account_id, full_name, role, active_flag, role_focus);
-- pilot.staff was (staff_id, account_id, full_name, title, active_flag)
-- before it was removed as dead schema. Neither held a background-check
-- status, an issuing authority, or an expiry date. The system could not
-- answer "is this adult cleared to be on the floor today?"
--
-- REQUIREMENTS ARE NOT UNIFORM, AND THAT IS THE POINT. A coach supervising
-- sparring or working a corner carries a different requirement set than
-- someone doing gym maintenance who never has unsupervised youth contact.
-- Modelling one blanket "cleared" boolean would either over-restrict
-- volunteers or under-protect athletes. Requirement is therefore a
-- function of the ACTIVITY, not of the person's title.
--
-- THIS SYSTEM DOES NOT DETERMINE LEGAL SUFFICIENCY. Which clearances a
-- given role requires under Pennsylvania Act 153/Act 15, and what a
-- specific SafeSport designation permits, is a legal and governing-body
-- determination made by qualified humans. These tables RECORD what a
-- human decided and surface expiry. They must never infer a requirement,
-- clear a person, or extend a date. An expired clearance is a fact to
-- display, not a decision to make. pilot.v_clearance_status is a read-only
-- VIEW for exactly this reason -- there is no write path that gates
-- anything, and none should be added without a separate, explicit product
-- decision.
--
-- DEPENDS ON pilot.organizations, pilot.accounts. No begin;/commit; here on
-- purpose, matching this repo's runner-opens-the-transaction convention
-- (the runner is
-- apps/web/scripts/pilot-apply-clearance-register-migration.mjs).

create table if not exists pilot.clearance_types (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  clearance_type_id   text not null,
  name                text not null,           -- e.g. 'PA Child Abuse History Certification'
  issuing_authority   text not null,           -- e.g. 'PA Dept of Human Services', 'US Center for SafeSport'
  authority_kind      text not null check (authority_kind in
                        ('state_statutory','federal','governing_body','internal_approval')),
  level_label         text null,               -- e.g. 'green', 'core', 'refresher'
  validity_months     integer null check (validity_months is null or validity_months > 0),
  renewal_grace_days  integer not null default 0,
  external_reference  text null,               -- statute or policy citation, human-entered
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_clearance_types_pkey primary key (organization_id, clearance_type_id)
);

create table if not exists pilot.person_clearances (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  clearance_id        text not null,
  person_account_id   text not null references pilot.accounts(account_id) on delete cascade,
  clearance_type_id   text not null,
  status              text not null check (status in
                        ('not_started','submitted','current','expired','revoked','not_required')),
  issued_on           date null,
  expires_on          date null,
  document_ref        text null,               -- storage path; the document itself is not held here
  verified_by_account_id text null references pilot.accounts(account_id) on delete set null,
  verified_at         timestamptz null,
  verification_note   text null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pilot_person_clearances_pkey primary key (organization_id, clearance_id),
  constraint pilot_person_clearances_type_fk foreign key (organization_id, clearance_type_id)
    references pilot.clearance_types(organization_id, clearance_type_id),
  unique (organization_id, person_account_id, clearance_type_id),
  -- 'current' is a claim about a document a human checked. It requires
  -- both the check and a date.
  constraint pilot_person_clearances_current check (status <> 'current'
    or (verified_by_account_id is not null and verified_at is not null and issued_on is not null))
);

create index if not exists pilot_person_clearances_expiring
  on pilot.person_clearances(organization_id, expires_on) where status = 'current';

-- Which clearance types an activity requires. Rows are authored by a human
-- with governance authority; the system never derives them.
create table if not exists pilot.activity_clearance_requirements (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  requirement_id      text not null,
  activity_scope      text not null check (activity_scope in
                        ('supervise_sparring','corner_competition','coach_youth_session',
                         'unsupervised_youth_contact','supervised_gym_service',
                         'transport_athletes','board_or_admin','observer_only')),
  clearance_type_id   text not null,
  requirement_kind    text not null check (requirement_kind in ('required','required_or_supervised','recommended')),
  approved_by_account_id text not null references pilot.accounts(account_id),
  approved_at         timestamptz not null,
  policy_note         text not null default '',
  created_at          timestamptz not null default now(),
  constraint pilot_acr_pkey primary key (organization_id, requirement_id),
  constraint pilot_acr_type_fk foreign key (organization_id, clearance_type_id)
    references pilot.clearance_types(organization_id, clearance_type_id),
  unique (organization_id, activity_scope, clearance_type_id)
);

-- Read-only view: who is missing what, for which activity. Advisory
-- display only. It reports a factual comparison of recorded rows. It does
-- not authorize anyone.
create or replace view pilot.v_clearance_status as
select
  r.organization_id,
  r.activity_scope,
  a.account_id                as person_account_id,
  ct.name                     as clearance_name,
  ct.issuing_authority,
  r.requirement_kind,
  coalesce(pc.status, 'not_started') as clearance_status,
  pc.expires_on,
  case
    when pc.status = 'current' and (pc.expires_on is null or pc.expires_on >= current_date) then 'on_file'
    when pc.status = 'current' and pc.expires_on < current_date                              then 'expired'
    when pc.status in ('revoked')                                                            then 'revoked'
    else 'missing'
  end as display_state
from pilot.activity_clearance_requirements r
join pilot.clearance_types ct
  on ct.organization_id = r.organization_id and ct.clearance_type_id = r.clearance_type_id
cross join pilot.accounts a
left join pilot.person_clearances pc
  on pc.organization_id = r.organization_id
 and pc.person_account_id = a.account_id
 and pc.clearance_type_id = r.clearance_type_id
where a.organization_id = r.organization_id;

comment on view pilot.v_clearance_status is
  'Advisory comparison of recorded clearances against human-authored activity requirements. Displays state; authorizes nothing. Legal sufficiency is determined by qualified humans.';
