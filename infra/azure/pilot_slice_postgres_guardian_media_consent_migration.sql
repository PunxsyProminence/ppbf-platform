-- Guardian media consent (pilot.waivers) -- ties a photo/video consent
-- record to the specific guardian who gave it, and records what it covers.
--
-- WHY THIS EXTENDS pilot.waivers RATHER THAN A NEW TABLE
--
-- T-008 proposed a new `guardian_media_consent` table. That proposal predates
-- a discovery worth recording here: apps/web/app/admin/consent/page.tsx
-- already records exactly this fact -- 'photo_media' is a first-class value
-- in that page's own WAIVER_TYPES list, and pilot.waivers' append-only shape
-- (a new row supersedes the last one; status admits
-- 'signed'/'declined'/'withdrawn') already IS "revocable and auditable". A
-- second, parallel table for the same real-world fact would give a
-- safeguarding auditor two places to check instead of one, which is a worse
-- outcome than one table carrying two more columns. This migration is that
-- correction, made deliberately rather than silently.
--
-- WHAT THIS ADDS
--
--   parent_id           -- ties a waiver row to the specific guardian who
--                           gave it. Nullable: every OTHER waiver_type
--                           (general, medical_release, travel) never had an
--                           identity requirement and is not retrofitted here
--                           -- signed_by_name/signed_by_role stay the record
--                           for those. Only 'photo_media' rows are expected
--                           to set this; the consent gate
--                           (guardianConsent.ts) only ever reads it for that
--                           waiver_type.
--   covers_video        -- true: the consent covers photo AND video. false:
--                           photo only. Recorded and gated on presence, but
--                           NOT YET matched against a specific publication's
--                           media type -- see guardianConsent.ts's own header
--                           for what is deferred and why.
--   public_use_allowed  -- true: may be used publicly (site, social, print).
--                           false: internal/gym-only. Recorded, same
--                           deferral as covers_video.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not retroactively touch any already-published video when a
-- guardian later withdraws consent. pilot.video_publications has no
-- 'unpublished'/'retracted' status value, and inventing one is a schema
-- decision this migration does not make. The consent gate this ships
-- alongside (the video-compliance admin route) blocks future approvals only.
--
-- No `begin;`/`commit;` here: the runner
-- (apps/web/scripts/pilot-apply-guardian-media-consent-migration.mjs) opens
-- the transaction itself.

alter table pilot.waivers
  add column if not exists parent_id text null;

alter table pilot.waivers
  add column if not exists covers_video boolean not null default true;

alter table pilot.waivers
  add column if not exists public_use_allowed boolean not null default false;

do $pilot_waivers_parent_fk$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'pilot.waivers'::regclass
      and conname = 'pilot_waivers_parent_fk'
  ) then
    alter table pilot.waivers
      add constraint pilot_waivers_parent_fk
      foreign key (organization_id, parent_id) references pilot.parents(organization_id, parent_id)
      on delete set null;
  end if;
end
$pilot_waivers_parent_fk$;

-- The consent gate's question is always "does this athlete have a current,
-- non-withdrawn photo_media waiver from every one of their guardians" -- an
-- index on exactly that shape keeps it a small indexed lookup rather than a
-- sequential scan of the whole waivers table as it grows.
create index if not exists idx_waivers_athlete_type_parent
  on pilot.waivers(organization_id, athlete_id, waiver_type, parent_id, created_at desc);

comment on column pilot.waivers.parent_id is
  'The specific guardian who gave this consent, when known. Only meaningfully set for waiver_type=''photo_media''; other waiver types keep signed_by_name/signed_by_role as their record of who signed.';
