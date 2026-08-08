-- Training holds (capability #82: Stop / Hold / Regress).
--
-- WHAT THE THREE WORDS MEAN HERE, decided with the owner 2026-08-06:
--
--   STOP    -- an active hold blocks class registration at request time
--              (registerForClassTransactionally), inside the same
--              transaction that serializes capacity. The athlete learns
--              earliest, with the hold's own explanation, not at the door.
--   HOLD    -- scope 'all_training': a durable, attributed, expiring state.
--              Training is paused until a person lifts it or it expires.
--   REGRESS -- scope 'contact_only' or 'conditioning_only': training
--              CONTINUES at reduced scope. This is deliberately NOT a
--              demotion of the athlete: the platform has no athlete ranks,
--              by recorded doctrine (the achievements migration: "a
--              greyed-out rung is how a system tells somebody they are the
--              incomplete version of somebody else"; the profile-identity
--              migration refuses the same ordering). What regresses is the
--              PERMITTED INTENSITY, never the athlete's standing. Skill-
--              content regression belongs to capabilities #23/#62.
--
-- WHY NOT gym_status: that column is a membership state (on the roster,
-- attending), privacy-classified as body data, and already overloaded as a
-- "track" in the coach workspace. A hold merged into it would make a safety
-- pause indistinguishable from a lapsed membership, and lifting one would
-- silently reactivate the other. Two migrations already refuse to reuse
-- gym_status for new meanings; this one refuses the same way.
--
-- WHY NOT a safety_gates row alone: the gate matrix is a stateless
-- per-action evaluator -- per-org policy rows plus append-only evaluation
-- facts. A hold has an owner, a reason, a lift condition, and an end; none
-- of those fit either gate table. The hold is therefore a CONDITION the
-- enforcement points read -- exactly how medical status works -- which
-- preserves the matrix's permanent no-override refusal verbatim.
--
-- AUTHORITY (owner decision): coaches place and lift holds for their own
-- athletes (a coach seeing danger mid-session cannot wait for an admin);
-- organization admins place and lift any. Every placement files a
-- safety_escalations row ('training_hold') in the same transaction, so the
-- admin surface always knows a child's training was paused, by whom, and
-- why. Resolving that escalation does NOT lift the hold -- an escalation
-- resolves when a human has looked; a hold lifts when a person lifts it.
--
-- athlete_explanation is NOT NULL on purpose: a hold a child cannot read a
-- reason for is a punishment, not a safety measure. It carries the
-- age-appropriate, non-punitive sentence the athlete sees; reason_text is
-- the staff-facing detail and never renders to the athlete.
--
-- No explicit begin/commit here: pilot-apply-training-holds-migration.mjs
-- wraps this file in a single transaction itself, matching the other
-- migration scripts in this repository.

create table if not exists pilot.training_holds (
  organization_id        text not null references pilot.organizations(organization_id) on delete cascade,
  hold_id                text not null,
  athlete_id             text not null,
  scope                  text not null check (scope in ('all_training', 'contact_only', 'conditioning_only')),
  reason_category        text not null check (reason_category in ('medical', 'fatigue', 'behavioral', 'administrative', 'other')),
  reason_text            text not null default '',
  athlete_explanation    text not null check (length(btrim(athlete_explanation)) > 0),
  lift_condition_text    text not null default '',
  placed_by_account_id   text not null,
  placed_by_role         text not null check (placed_by_role in ('coach', 'organization_admin', 'admin')),
  placed_at              timestamptz not null default now(),
  expires_at             timestamptz null,
  lifted_by_account_id   text null,
  lifted_at              timestamptz null,
  lift_note              text not null default '',
  status                 text not null default 'active' check (status in ('active', 'lifted', 'expired')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (organization_id, hold_id),
  constraint pilot_training_holds_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_training_holds_expiry_check
    check (expires_at is null or expires_at > placed_at)
);

-- At most one ACTIVE hold per athlete: stacking holds would make "lifted"
-- a lie the same way stacked coverage grants made "revoked" one. Placing a
-- second hold requires lifting the first, so the record of who paused a
-- child's training and why stays linear.
create unique index if not exists idx_training_holds_one_active
  on pilot.training_holds(organization_id, athlete_id)
  where status = 'active';

create index if not exists idx_training_holds_org_status
  on pilot.training_holds(organization_id, status, placed_at desc);
