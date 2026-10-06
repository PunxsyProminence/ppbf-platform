-- Retained media restrictions: a guardian's "no" outlives the guardian's record.
--
-- Owner ruling, Jason 2026-10-05 ("Keep the 'no' (Recommended)"): a
-- guardian's withdrawal or photo-only media choice outlives the guardian's
-- account deletion; the child's media stays restricted until a remaining
-- guardian grants it.
--
-- WHY A TABLE. The retention purge (scripts/pilot-cleanup-deleted-data.mjs and
-- dataDeletion.ts purgeExpiredDeletedData) deletes the guardian's pilot.parents
-- row, which cascades their pilot.guardian_links, and nulls
-- pilot.waivers.parent_id first. The consent gate (guardianConsent.ts) asks the
-- guardians still linked, and reads only waivers whose parent_id is set, so
-- the purged guardian's choice stopped counting: with a second guardian the
-- gate read only that guardian, and with none, playback read an empty set as
-- "nobody excluded video". The surviving waiver rows cannot carry it on their
-- own: with parent_id null they look the same as intake-written rows, which
-- also have no parent_id, so neither "which guardian's latest" nor "granted
-- since" could be answered from them.
--
-- ONE ROW PER (child, purged guardian) the guardian was still linked to at
-- the purge: a pointer to that guardian's current photo_media waiver, which
-- itself survives. The
-- gate reads the waiver's status and covers_video through it, by the same
-- rules it applies to a linked guardian, so this table copies no consent fact.
-- retained_at is when the guardian was purged: a remaining guardian's grant
-- lifts the restriction only if it was recorded after that (guardianConsent.ts).
--
-- Both foreign keys cascade: when the child is purged, the child's waivers and
-- this pointer go with them. Idempotent: create if not exists.

create table if not exists pilot.retained_media_consent_restrictions (
  organization_id text not null,
  athlete_id text not null,
  -- sha256 (hex) of the purged guardian's parent_id, never the id itself: an
  -- invited guardian's parent_id is 'par-' plus their login, usually their
  -- email, which is what the purge exists to remove. Kept so a guardian id
  -- purged a second time (a re-invite reuses it) replaces its own row rather
  -- than adding one. No foreign key: the pilot.parents row is gone.
  former_parent_key text not null,
  waiver_id uuid not null,
  retained_at timestamptz not null default now(),
  constraint pilot_retained_media_consent_restrictions_pk
    primary key (organization_id, athlete_id, former_parent_key),
  constraint pilot_retained_media_consent_restrictions_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id) on delete cascade,
  constraint pilot_retained_media_consent_restrictions_waiver_fk
    foreign key (organization_id, waiver_id)
    references pilot.waivers(organization_id, waiver_id) on delete cascade
);

-- The waiver foreign key's referencing side, so deleting a waiver (an athlete
-- purge cascades every one of theirs) does not scan this table.
create index if not exists pilot_retained_media_consent_restrictions_waiver_idx
  on pilot.retained_media_consent_restrictions (organization_id, waiver_id);
