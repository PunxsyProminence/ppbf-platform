-- Video clip tags -> sparring exposure: a sparring clip tag may name the one
-- sparring entry (segment) it shows.
--
-- Owner decisions (Jason AskUserQuestion 2026-10-05, overwatch-relayed):
--   * One entry: a tag links to at most ONE pilot.sparring_exposure row.
--   * Optional: a sparring clip can be tagged with no entry and linked later.
--   * Behind the scenes now: the link is carried by the API; screens follow
--     with the coach clip screens.
-- Overwatch (2026-10-05), integrity:
--   * The entry must be the SAME athlete's, in the same organization -- so a
--     partner's tag can only ever point at the partner's own segment.
--   * Only a sparring tag may carry a link.
--   * Deleting the entry clears the link and keeps the tag.
--
-- The consent rules (OD-2026-10-04-003, -009) live in the application and are
-- unchanged: a link opens no footage and names nothing a clip list hides.
--
-- ADDITIVE AND IDEMPOTENT. One nullable column, one check, one foreign key,
-- two indexes. No existing row changes; every existing tag reads "not
-- linked" (null). Requires the sparring-exposure and video-clip-tags
-- migrations. The runner opens the transaction, so this file carries none
-- (apps/web/scripts/pilot-apply-video-clip-tags-sparring-link-migration.mjs).
--
-- POSTGRESQL 15 IS REQUIRED. The foreign key is composite, and a plain
-- ON DELETE SET NULL nulls EVERY column in the key -- organization_id and
-- athlete_id included, both NOT NULL -- so deleting an entry would fail, and
-- only at delete time (the defect #871 fixed on pilot.waivers). The
-- column-list form SET NULL (exposure_id) arrived in PostgreSQL 15. Production
-- and staging both log server_version_num 160015 (apply-migrations runs
-- 37232770353 and 37249642815); this refuses by name on anything older and
-- changes nothing.

do $pilot_video_clip_tags_sparring_link_pg15$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'VIDEO_CLIP_TAGS_SPARRING_LINK_REQUIRES_PG15: server_version_num is %, and ON DELETE SET NULL (column) needs 150000 or later. Nothing was changed.',
      current_setting('server_version_num');
  end if;
end
$pilot_video_clip_tags_sparring_link_pg15$;

-- Composite target for the same-athlete foreign key. exposure_id is already
-- unique within an organization (the primary key), so this cannot fail on
-- existing data.
create unique index if not exists idx_sparring_exposure_org_exposure_athlete
  on pilot.sparring_exposure(organization_id, exposure_id, athlete_id);

alter table pilot.video_clip_tags
  add column if not exists exposure_id text null;

do $pilot_video_clip_tags_sparring_link$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_video_clip_tags_exposure_sparring_check'
      and conrelid = to_regclass('pilot.video_clip_tags')
  ) then
    alter table pilot.video_clip_tags
      add constraint pilot_video_clip_tags_exposure_sparring_check
      check (exposure_id is null or event_kind = 'sparring');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_video_clip_tags_exposure_fk'
      and conrelid = to_regclass('pilot.video_clip_tags')
  ) then
    alter table pilot.video_clip_tags
      add constraint pilot_video_clip_tags_exposure_fk
      foreign key (organization_id, exposure_id, athlete_id)
      references pilot.sparring_exposure(organization_id, exposure_id, athlete_id)
      on delete set null (exposure_id);
  end if;
end
$pilot_video_clip_tags_sparring_link$;

-- The sparring record reads live links by entry; the foreign key's delete
-- action looks them up the same way.
create index if not exists idx_video_clip_tags_exposure
  on pilot.video_clip_tags(organization_id, exposure_id)
  where exposure_id is not null;

comment on column pilot.video_clip_tags.exposure_id is
  'The one sparring_exposure entry this sparring clip tag shows, for the same athlete. Optional; cleared when the entry is deleted. Owner 2026-10-05.';
