-- Per-organization video release policy (pilot.organization_video_policy).
--
-- WHY THIS EXISTS. The video gate was written with one safety posture compiled
-- in: an upload is quarantined, and a coach may release it by hand only when
-- the scanner explicitly deferred. That posture assumes the worst plausible
-- tenant. It is the right DEFAULT and the wrong CONSTANT -- a platform meant
-- to serve more than one gym cannot hard-code one gym's risk assessment, and
-- the owner's decision (2026-08-17) is that this belongs to the organization
-- administrator rather than to the source code.
--
-- The concrete case: a club whose coaching staff all hold current SafeSport
-- and current background screening, reviewing its own training footage the
-- evening it was filmed. Requiring an administrator to unlock each clip makes
-- after-action review unusable while it is still fresh, which is the only time
-- it is worth doing. A different club, with volunteers who are not screened,
-- should keep the strict posture. Both are legitimate; neither belongs in a
-- constant.
--
-- THE DEFAULT IS STRICT, AND ABSENCE MEANS STRICT.
-- An organization with no row here gets 'scan_required' -- the behaviour that
-- exists today. A tenant gains the looser posture only by an administrator
-- recording that decision against their own organization, with their account
-- id attached. Nothing about deploying this migration changes how any existing
-- organization behaves.
--
-- WHAT THE LOOSE POSTURE DOES *NOT* DO. 'coach_attested' widens exactly one
-- thing: it lets the uploading coach release their own quarantined video while
-- the scan is still pending or has never run. It does not touch:
--
--   * 'infected' -- a malware verdict is machine fact, never releasable by
--     anyone on any surface, under any policy. Deliberately not configurable.
--   * 'blocked' -- the content screen refusing footage of a minor still
--     escalates to an administrator. The person who filmed it does not
--     overturn it, which is #149's reasoning and is unchanged.
--
-- So the widest this setting can reach is "a video nobody has judged", never
-- "a video something judged and refused". That boundary is why this is a
-- policy dial and not a bypass.
--
-- WHY A TABLE AND NOT COLUMNS ON pilot.organizations. That table is identity --
-- name, status, who created it. Mixing operational policy into it would mean
-- every future capability toggle is a schema change to the tenancy root, and
-- would leave no natural place to record WHO set a policy and WHEN, which is
-- the part that makes a loosened control auditable rather than mysterious.
--
-- WHY NOT A GENERIC key/value POLICY TABLE. Because a generic table cannot
-- carry a CHECK constraint per policy, and this vocabulary is exactly the kind
-- the repository constrains in the database rather than in application code
-- (pilot.club_members.membership_type, the wrestling-league statuses). A typed
-- table per capability is more verbose and cannot drift.
--
-- Additive and idempotent. Creates one table, no alters to anything existing.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-video-policy-migration.mjs) opens
-- the transaction itself.
--
-- DEPENDS ON pilot.organizations, pilot.accounts.

create table if not exists pilot.organization_video_policy (
  organization_id text primary key
    references pilot.organizations(organization_id) on delete cascade,

  -- 'scan_required'  -- today's behaviour. A coach may release only from a
  --                     scan_state where the scanner deferred.
  -- 'coach_attested' -- the uploading coach may also release a video whose
  --                     scan has not reached a verdict, attesting to footage
  --                     they filmed.
  release_policy text not null default 'scan_required'
    check (release_policy in ('scan_required', 'coach_attested')),

  -- Who loosened it, and when. A control that can be relaxed has to say by
  -- whom -- otherwise the strict default and a deliberate exception look
  -- identical a year later. on delete set null rather than cascade: the person
  -- leaving must not delete the record that the decision was made.
  set_by_account_id text null references pilot.accounts(account_id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A row that is not the default must name its author. The strict posture is
  -- the platform's own and needs no attribution; a departure from it does.
  constraint pilot_org_video_policy_attributed
    check (release_policy = 'scan_required' or set_by_account_id is not null)
);

-- Read on every release attempt, so it is a primary-key lookup by design.
-- No secondary index: the primary key already is the access path.
