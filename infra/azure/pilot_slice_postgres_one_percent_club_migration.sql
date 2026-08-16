-- 1% Club / Leadership Pathway Tracker (register module 127, owner design
-- 2026-08-16, verbatim: "1,2,3 with the majority of coach and admin on the
-- list vote to confirm").
--
-- WHAT THIS IS: three real nomination paths feeding one confirmation
-- mechanism. A coach nominates directly, an athlete nominates themselves or
-- a peer, or a real earned milestone is cited as the reason for a
-- nomination -- and in every case a human still has to create the
-- nomination. Membership is confirmed ONLY when a strict majority of the
-- organization's currently-active coaches and admins have voted yes.
--
-- WHAT THIS DELIBERATELY IS NOT: a ranking, a score, or a leaderboard. There
-- is no numeric "worthiness" column anywhere in this file. `source` records
-- HOW a nomination started so a milestone-surfaced one can never be shown as
-- if a person put the name forward, and that is the only thing it records.
--
-- OWNER DECISIONS (2026-08-16, asked one at a time):
--   * Eligible voters: every account with role coach/organization_admin/admin
--     that is currently active_flag = true in that organization. The count
--     is taken live at vote time, never cached, so staff turnover is honest.
--   * An open nomination auto-expires 30 days after it was filed if it never
--     reaches majority. The row is kept (status = 'expired'), never deleted.
--   * The same athlete may be nominated again 30 days after a nomination of
--     theirs was withdrawn or expired -- same window, reused rather than
--     inventing a second constant.
--   * Confirmed membership is permanent. There is no revocation vote and no
--     lapse; the check constraint on `status` has no path back out of
--     'confirmed', enforced at the application layer (there is no
--     UPDATE ... status='confirmed' -> anything else anywhere in this slice).
--
-- Idempotent: create table/index if not exists, no drops, no destructive
-- alters.

create table if not exists pilot.one_percent_nominations (
  organization_id            text not null references pilot.organizations(organization_id) on delete cascade,
  nomination_id              text not null,
  athlete_id                 text not null,
  -- HOW this nomination started. The UI renders each value with different
  -- language on purpose -- a milestone-surfaced nomination must never read
  -- as if a person put the name forward.
  source                     text not null check (source in (
                               'coach_nomination', 'milestone_surfaced', 'self_peer_nomination'
                             )),
  nominated_by_account_id    text not null references pilot.accounts(account_id),
  nominated_by_role          text not null,
  nominated_by_display_name  text not null default '',
  nominator_note             text not null default '',
  -- Set only when source = 'milestone_surfaced', and only after the server
  -- verified the athlete actually holds this award (see onePercentClub.ts).
  -- It is evidence of what triggered the suggestion, never a computed score.
  milestone_key              text null,
  status                     text not null default 'open' check (status in (
                               'open', 'confirmed', 'withdrawn', 'expired'
                             )),
  withdrawal_reason          text null,
  expires_at                 timestamptz not null,
  decided_at                 timestamptz null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint pilot_one_percent_nominations_pk primary key (organization_id, nomination_id),
  constraint pilot_one_percent_nominations_athlete_fk
    foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id),
  constraint pilot_one_percent_nominations_milestone_source_check
    check (source <> 'milestone_surfaced' or milestone_key is not null),
  -- Nothing is deleted to resolve a nomination -- a withdrawal stays on the
  -- record, and it has to say why.
  constraint pilot_one_percent_nominations_withdrawal_reason_check
    check (status <> 'withdrawn' or length(btrim(coalesce(withdrawal_reason, ''))) > 0)
);

create index if not exists idx_one_percent_nominations_athlete
  on pilot.one_percent_nominations(organization_id, athlete_id, status);

create index if not exists idx_one_percent_nominations_status
  on pilot.one_percent_nominations(organization_id, status, expires_at);

-- One vote per voter per nomination, and the row is never overwritten:
-- immutable once cast is what makes "who voted, when, and the tally"
-- actually auditable rather than a snapshot of whoever voted last.
create table if not exists pilot.one_percent_votes (
  organization_id     text not null references pilot.organizations(organization_id) on delete cascade,
  nomination_id       text not null,
  voter_account_id    text not null references pilot.accounts(account_id),
  voter_role          text not null,
  voter_display_name  text not null default '',
  vote                text not null check (vote in ('yes', 'no')),
  voted_at            timestamptz not null default now(),
  constraint pilot_one_percent_votes_pk primary key (organization_id, nomination_id, voter_account_id),
  constraint pilot_one_percent_votes_nomination_fk
    foreign key (organization_id, nomination_id)
    references pilot.one_percent_nominations(organization_id, nomination_id) on delete cascade
);

create index if not exists idx_one_percent_votes_nomination
  on pilot.one_percent_votes(organization_id, nomination_id);

comment on table pilot.one_percent_nominations is
  'Register module 127. Three real nomination paths (source column) feeding one majority-vote confirmation. No worthiness score anywhere in this table -- confirmation is a human vote, always.';

comment on table pilot.one_percent_votes is
  'One immutable row per (nomination, voter). Majority is recomputed live against pilot.accounts at vote time, never cached, so it always reflects who is actually an active coach/admin right now.';
