-- Local evidence -- findings PPBF generates on its own floor.
--
-- THE GAP THIS CLOSES. The evidence registry holds 1,193 claims from
-- published research, of which roughly a third are boxing-specific and
-- the rest are transferred from other sports and sectors. Every tier the
-- app displays is therefore a judgement about SOMEONE ELSE'S data.
-- Nothing in the schema lets PPBF's own floor generate a finding,
-- accumulate confidence in it, and have that confidence read alongside
-- the literature. Without this table the gym is permanently a consumer of
-- other people's evidence and can never become a producer of its own.
--
-- HOW CONFIDENCE ACCRUES, AND HOW IT DOES NOT. A local finding starts as
-- an OBSERVATION with no standing. It advances only on evidence that is
-- recorded here: how many athletes, over how long, with how many
-- independent observers, and whether a stated prediction held when it was
-- checked. Advancement is a HUMAN DECISION recorded with a note -- the
-- tiers below are a vocabulary for a coach's judgement, not an automatic
-- promotion ladder. No count in this table triggers a tier change on its
-- own.
--
-- WHY IT MUST NOT LOOK LIKE PUBLISHED EVIDENCE. A local finding from one
-- gym, however well observed, is a single-site uncontrolled observation.
-- It can be more relevant to PPBF than a published RCT in another sport
-- AND weaker as evidence at the same time, and the display must carry
-- both facts. Local tiers are deliberately named so they cannot be
-- confused with the registry's evidence classes, and `origin` is always
-- visible.
--
-- THE HONEST CEILING. local_established is the top of this ladder and it
-- means "reliable in this gym, tested against a prediction". It does NOT
-- mean generalisable, does not mean validated, and must never be rendered
-- with the same label as VERIFIED EVIDENCE from the literature. A finding
-- that deserves wider status leaves this table and enters a study.
--
-- DEPENDS ON pilot.organizations, pilot.accounts. No begin;/commit; here
-- on purpose, matching this repo's runner-opens-the-transaction
-- convention (the runner is
-- apps/web/scripts/pilot-apply-local-findings-migration.mjs).

create table if not exists pilot.local_findings (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  finding_id          text not null,
  lineage_id          text not null,
  version             integer not null default 1,

  title               text not null,
  statement           text not null,          -- the claim, in the coach's own words
  domain              text not null,          -- technical | physical | psychological | operational | safety
  applies_to          text not null default '',   -- population it is about: age band, level, lane
  originating_source  text not null check (originating_source in
                        ('coach_observation','drill_outcome','assessment_data','athlete_feedback',
                         'flag_calibration','session_pattern','other')),

  local_tier          text not null default 'observation' check (local_tier in
                        ('observation','repeated_observation','local_pattern','local_tested','local_established','retired')),

  -- The evidence behind the tier. Human-entered, because a coach knows
  -- things the tables do not.
  athletes_observed   integer not null default 0 check (athletes_observed >= 0),
  observation_span_days integer not null default 0 check (observation_span_days >= 0),
  independent_observers integer not null default 1 check (independent_observers >= 1),
  supporting_activity_ids text[] not null default '{}',
  supporting_assessment_ids text[] not null default '{}',

  -- A finding earns 'local_tested' only by stating a prediction BEFORE
  -- checking it.
  prediction_statement text null,
  prediction_made_at   timestamptz null,
  prediction_outcome   text null check (prediction_outcome is null or prediction_outcome in
                        ('held','partially_held','did_not_hold','not_yet_checked')),
  prediction_checked_at timestamptz null,
  prediction_note      text null,

  -- Relationship to the published registry, when there is one.
  related_claim_ids   text[] not null default '{}',
  agrees_with_literature text null check (agrees_with_literature is null or agrees_with_literature in
                        ('agrees','extends','contradicts','no_published_equivalent')),
  contradiction_note  text null,

  competing_explanations text not null default '',   -- what else could produce this
  known_limitations   text not null default '',

  raised_by_account_id text not null references pilot.accounts(account_id),
  raised_by_role      text not null,
  reviewed_by_account_id text null references pilot.accounts(account_id) on delete set null,
  reviewed_at         timestamptz null,
  review_note         text null,
  status              text not null default 'active' check (status in ('active','superseded','retired')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint pilot_local_findings_pkey primary key (organization_id, finding_id),
  constraint pilot_local_findings_lineage_version_uq unique (organization_id, lineage_id, version),

  -- A tested finding must have stated its prediction before checking it,
  -- and recorded the result.
  constraint pilot_local_findings_tested check (
    local_tier not in ('local_tested','local_established')
    or (prediction_statement is not null and prediction_made_at is not null
        and prediction_outcome is not null and prediction_outcome <> 'not_yet_checked'
        and prediction_checked_at is not null and prediction_checked_at > prediction_made_at)
  ),
  -- The two tiers that carry weight require a second human to have
  -- looked.
  constraint pilot_local_findings_reviewed check (
    local_tier not in ('local_tested','local_established')
    or (reviewed_by_account_id is not null and reviewed_at is not null)
  ),
  -- A finding that contradicts published evidence must say how. Silence
  -- there is the failure mode.
  constraint pilot_local_findings_contradiction check (
    agrees_with_literature is distinct from 'contradicts'
    or (contradiction_note is not null and length(btrim(contradiction_note)) >= 20)
  )
);

create index if not exists pilot_local_findings_active
  on pilot.local_findings(organization_id, domain, local_tier) where status = 'active';

-- Every tier change is appended. The trail is the point: it shows what a
-- finding was believed to be and when that changed, which is what lets a
-- wrong call be found later rather than silently edited.
create table if not exists pilot.local_finding_tier_history (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  history_id          text not null,
  finding_id          text not null,
  from_tier           text null,
  to_tier             text not null,
  rationale           text not null,
  evidence_snapshot   jsonb not null default '{}'::jsonb,   -- counts at the moment of the change
  changed_by_account_id text not null references pilot.accounts(account_id),
  changed_by_role     text not null,
  changed_at          timestamptz not null default now(),
  constraint pilot_lfth_pkey primary key (organization_id, history_id),
  constraint pilot_lfth_finding_fk foreign key (organization_id, finding_id)
    references pilot.local_findings(organization_id, finding_id) on delete cascade,
  constraint pilot_lfth_rationale check (length(btrim(rationale)) >= 15)
);

create index if not exists pilot_lfth_finding
  on pilot.local_finding_tier_history(organization_id, finding_id, changed_at desc);

-- Combined read: local findings alongside the published claims they relate
-- to, with origin always explicit. This is the view a coach-facing screen
-- should use -- never one that merges the two vocabularies into a single
-- tier. security_invoker=true so the view runs with the querying role's
-- own privileges, not the view owner's.
create or replace view pilot.v_evidence_combined
  with (security_invoker = true) as
select
  organization_id,
  'local'::text                     as origin,
  finding_id                        as id,
  title,
  statement,
  domain,
  local_tier                        as tier,
  'PPBF floor -- single-site, uncontrolled'::text as tier_context,
  athletes_observed                 as n_observed,
  agrees_with_literature,
  related_claim_ids,
  created_at
from pilot.local_findings
where status = 'active';

comment on view pilot.v_evidence_combined is
  'Local floor findings with origin and single-site context explicit. Local tiers are NOT comparable to published evidence classes and must never be rendered with the same labels.';
