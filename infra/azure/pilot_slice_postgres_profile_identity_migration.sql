-- Profile identity (pilot.account_profiles) -- the part of a member's record
-- that belongs to the member.
--
-- WHY A TABLE AND NOT COLUMNS ON pilot.accounts
--
-- Two reasons, both load-bearing.
--
-- First, audience. pilot.accounts is the authentication record: pin_hash,
-- auth_provider, must_change_pin, active_flag. Every login path reads it and
-- several of them SELECT *. A portrait path and a self-chosen nickname on that
-- row would ride along in the session resolution query on every authenticated
-- request in the platform, and would appear in whatever any of those callers
-- logs. Identity is read on a handful of screens; credentials are read on every
-- request. They do not belong on one row.
--
-- Second, deletion. A guardian asking for their child's photograph to be
-- removed must be a delete this platform can perform without touching the
-- account that child logs in with. A row here is deletable; a column on the
-- credential record is not.
--
-- The key is (organization_id, account_id) rather than athlete_id on purpose:
-- coaches, guardians, staff and volunteers all get a portrait and a corner.
-- The brief is "every user, all roles", and keying on athlete_id would have
-- built a feature for participants and left the coach whose face is supposed to
-- appear on their athlete's card with nowhere to put it.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No health, clearance, injury, readiness, assessment or disciplinary column,
-- and no foreign key to a table carrying one. A portrait, a ring name and a
-- corner colour are decoration on a person's own space; the safety ladder is a
-- claim about their body. Joining the two would put a personal preference one
-- SELECT away from a medical state, which is the confusion Law 2 exists to
-- prevent. profileIdentity.privacy.test.ts asserts the reading code never names
-- those tables, and this comment is the reason it exists.
--
-- No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-profile-identity-migration.mjs) opens the
-- transaction itself, matching the announcements / video-sessions /
-- scheduler-tables convention. Putting boundaries in a file whose runner also
-- opens one is what took down every migration in that set (#107).

create table if not exists pilot.account_profiles (
  organization_id text not null references pilot.organizations(organization_id),
  account_id text not null references pilot.accounts(account_id) on delete cascade,

  -- The ring name. Nullable because most members will never set one, and a
  -- default of '' would make "has not chosen" indistinguishable from "chose an
  -- empty string". Length is capped in the database as well as in
  -- profileIdentity.ts: the application cap is the one that produces a good
  -- error message, this one is the one that holds when a future writer forgets
  -- to call the validator.
  display_nickname text null check (display_nickname is null or char_length(display_nickname) <= 24),

  -- Set when staff or a guardian clears a ring name. Two columns rather than a
  -- status enum because the questions asked of this are "is it still locked"
  -- (a timestamp answers that) and "who took it down" (an account answers
  -- that). A 'cleared' status would answer neither.
  nickname_cleared_at timestamptz null,
  nickname_cleared_by_account_id text null references pilot.accounts(account_id),

  -- Red corner, blue corner, or not chosen. 'none' is the default and a real
  -- state: the card renders the platform's own brass rather than pretending the
  -- member picked something.
  corner text not null default 'none' check (corner in ('red', 'blue', 'none')),

  -- Which programme this member is on. The platform had no such field --
  -- athletes.gym_status is active/training/inactive, a membership state -- and
  -- reading that as a programme would have printed "ACTIVE" where the
  -- programme belongs. 'unstated' is the honest default; nothing infers a
  -- programme from anything else.
  program text not null default 'unstated'
    check (program in ('fitness', 'recreational', 'youth_mentorship', 'competitive', 'unstated')),

  -- The portrait. Path only: the bytes live in the profile blob container and
  -- are streamed by an authenticated route, never linked to.
  photo_blob_path text null,
  photo_content_type text null check (photo_content_type is null or photo_content_type in ('image/jpeg', 'image/png')),
  photo_bytes integer null check (photo_bytes is null or photo_bytes > 0),
  photo_width integer null,
  photo_height integer null,
  -- Measured over the STRIPPED bytes, so it identifies what is actually stored
  -- rather than what was uploaded. Lets a duplicate upload be recognised without
  -- keeping the original around to compare against.
  photo_sha256 text null,
  photo_uploaded_at timestamptz null,

  -- Born pending, exactly like an intake document and a quarantined video.
  --
  -- The difference from the video pipeline, which shipped a quarantine state
  -- nothing could leave: this one has an exit that exists in the code. An
  -- organization admin or one of the athlete's own coaches releases it
  -- (/api/pilot/profile/photo/review). That is a human looking at a picture,
  -- which is the only review a portrait can honestly get -- the platform cannot
  -- tell whether a photograph of a child is an appropriate photograph of a
  -- child, and it must not pretend to.
  --
  -- The uploader always sees their own pending photo, so the feature gives
  -- feedback on day one without releasing anything to anyone else.
  photo_review_state text not null default 'pending_review'
    check (photo_review_state in ('pending_review', 'released', 'blocked', 'removed')),
  photo_reviewed_at timestamptz null,
  photo_reviewed_by_account_id text null references pilot.accounts(account_id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pilot_account_profiles_pk primary key (organization_id, account_id)
);

-- The coach roster read: every profile for a set of accounts in one
-- organization, which is the only shape this table is ever queried in bulk.
create index if not exists idx_account_profiles_org
  on pilot.account_profiles(organization_id, account_id);

-- The review queue: pending portraits in one organization, oldest first. Partial
-- on the state so it stays the size of the queue rather than the size of the
-- membership -- released photos are the overwhelming majority once the platform
-- has been running, and none of them is ever a review candidate.
create index if not exists idx_account_profiles_pending_review
  on pilot.account_profiles(organization_id, photo_uploaded_at)
  where photo_review_state = 'pending_review';

-- Re-running this migration against an environment that already has the table
-- must still converge on the current shape, so the columns added after the
-- first cut are stated separately. `add column if not exists` is real
-- PostgreSQL (unlike ADD CONSTRAINT IF NOT EXISTS -- guardrails section 7), so
-- these are plainly idempotent.
alter table pilot.account_profiles
  add column if not exists photo_sha256 text null;

alter table pilot.account_profiles
  add column if not exists photo_reviewed_by_account_id text null;
