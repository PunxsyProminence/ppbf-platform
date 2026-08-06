-- Red Flag Escalation ladder (pilot.safety_escalations) -- capability #194.
--
-- WHAT THIS CLOSES
--
-- Three producers of real safety signal exist and none of them escalate
-- anywhere: pilot.shadow_near_misses (contactClearanceGate.ts's flags,
-- painReportAlert.ts's pain reports) and pilot.safety_gate_evaluations
-- (safetyGateMatrix.ts) are insert-only tables a coach or admin must
-- already know to go looking in. There is no notification channel in this
-- platform at all (the platform sends no email, ever -- see
-- docs/WORK_QUEUE.md's "known and accepted for the pilot" section), so the
-- only thing "escalation" can mean here is a pull-based surface that puts
-- the highest-severity signal in front of a human without them having to
-- know where to look -- which is exactly what escalationLadder.ts and its
-- /admin/escalations page are for.
--
-- Compliance violations (pilot.compliance_violations /
-- pilot.violation_escalations) are DELIBERATELY NOT folded into this table.
-- That system already has a working escalate flow
-- (compliance.ts:escalateViolation) and its own UI
-- (admin/compliance-center). Whether the two should eventually merge is a
-- real product question this migration does not answer -- see the capability
-- build plan's note on #194 for the reasoning.
--
-- SEVERITY IS THE NEAR-MISS VOCABULARY, NOT COMPLIANCE'S
--
-- pilot.shadow_near_misses already uses ('low','moderate','high','critical').
-- Compliance's ('critical','high','medium','low') is a different, unreconciled
-- set (see ShadowNearMissSeverity vs. the free-text compliance_violations.severity
-- column) -- this table inherits the near-miss vocabulary because near
-- misses are its primary, currently-wired producer.
--
-- source_type IS OPEN-ENDED ON PURPOSE. 'repeated_pattern' has no
-- underlying row: escalationLadder.ts's detectRepeatedPatternEscalations
-- files a synthetic escalation when the SAME athlete trips the SAME
-- near-miss trigger more than a threshold within a lookback window -- the
-- doctrine's own example ("this athlete keeps asking about weight cutting")
-- is a pattern across several individually-unremarkable events, not one
-- event. source_id is therefore nullable: a repeated-pattern escalation has
-- no single originating row.
--
-- 'athlete_voice' (capability #198) is filed by athleteVoice.ts when an
-- athlete's feedback submission routes to safeguarding: source_id carries
-- the pilot.feedback_submissions id, and the escalation's reason/metadata
-- deliberately carry NO submission text -- escalation rows reach surfaces
-- the disclosure body must never reach (a coach may be who the child is
-- disclosing about; the coach-scoped list excludes athlete_voice rows
-- entirely for the same reason). Note the FK asymmetry, decided on purpose:
-- this table cascades on athlete delete while feedback_submissions
-- survives account deletion -- the escalation is the ALARM (pull-surface
-- state), the submission is the RECORD; offboarding an athlete may clear
-- their alarms but never their words.
--
-- escalated_to_role IS CONSTRAINED, UNLIKE violation_escalations.escalated_to_role
--
-- The compliance table's equivalent column is unconstrained free text and in
-- practice only ever receives 'organization_admin' or 'admin' from the one
-- caller that sets it. This table types it against PilotRole's escalation
-- targets explicitly, and 'board' is deliberately NOT one of them --
-- ORGANIZATION_ROLE_MODEL.md places board outside the coach/admin ladder
-- entirely (an aggregate-only side channel, not a rung), and
-- boardRoleBoundaries.test.ts already asserts 403 for board on the
-- compliance-violations surface this table's own read route mirrors. Any
-- board-facing view of this data must go through a k-anonymity-gated
-- summary (escalationLadder.ts's getBoardEscalationSummary, reusing
-- boardCountMetric/BOARD_MINIMUM_COHORT_SIZE from boardSummary.ts) rather
-- than reading this table's rows directly.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-safety-escalations-migration.mjs) opens the
-- transaction itself.

create table if not exists pilot.safety_escalations (
  organization_id             text not null references pilot.organizations(organization_id) on delete cascade,
  escalation_id                text not null,
  source_type                  text not null constraint safety_escalations_source_type_check check (source_type in ('near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern', 'athlete_voice')),
  source_id                    text null,
  athlete_id                   text not null,
  severity                     text not null check (severity in ('low', 'moderate', 'high', 'critical')),
  reason                       text not null,
  escalated_to_role            text not null check (escalated_to_role in ('coach', 'organization_admin', 'admin')),
  triggered_by                 text not null check (triggered_by in ('system', 'human')),
  triggered_by_account_id      text null,
  triggered_by_role            text null,
  status                       text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by_account_id   text null,
  acknowledged_at              timestamptz null,
  resolved_by_account_id       text null,
  resolved_at                  timestamptz null,
  resolution_note              text not null default '',
  metadata                     jsonb not null default '{}'::jsonb,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  primary key (organization_id, escalation_id),
  foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade
);

-- Idempotent repair for a database where an earlier revision of this
-- migration created the table with the four-value source_type vocabulary
-- (pre-athlete_voice, #198): the create-if-not-exists above no-ops there,
-- which would leave every athlete_voice escalation violating the stale
-- CHECK -- and the filing code deliberately swallows that failure (oracle
-- safety), so the loss would be silent. Re-running this migration must
-- therefore widen the CHECK in place. The runner's readiness probe also
-- refuses to PASS until 'athlete_voice' is in the constraint, so a stale
-- database fails loudly instead of dropping disclosures.
do $$
declare
  stale_constraint text;
begin
  select conname into stale_constraint
  from pg_constraint
  where conrelid = 'pilot.safety_escalations'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%source_type%'
    and pg_get_constraintdef(oid) like '%''near_miss''%'
    and pg_get_constraintdef(oid) not like '%''athlete_voice''%';

  if stale_constraint is not null then
    execute format('alter table pilot.safety_escalations drop constraint %I', stale_constraint);
    alter table pilot.safety_escalations
      add constraint safety_escalations_source_type_check
      check (source_type in ('near_miss', 'pain_report', 'safety_gate_evaluation', 'repeated_pattern', 'athlete_voice'));
  end if;
end $$;

create index if not exists idx_safety_escalations_org_status
  on pilot.safety_escalations(organization_id, status, created_at desc);

create index if not exists idx_safety_escalations_org_athlete
  on pilot.safety_escalations(organization_id, athlete_id, created_at desc);
