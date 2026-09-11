-- Drill secondary skill relationships -- ONE primary owner, ZERO-TO-MANY secondaries.
--
-- OWNER DECISION (Jason): a drill has ONE primary technical owner and MAY carry
-- MULTIPLE secondary skill relationships. A drill whose primary owner is a
-- combination or footwork family can still materially train stance, guard and
-- reset quality; today the library can say only one of those two things, so the
-- other simply goes unsaid. This table is where the second one lives.
--
-- PRIMARY OWNERSHIP DOES NOT MOVE. pilot.drill_library.skill_id remains the
-- single primary owner and is NOT touched here -- not its type, not its
-- nullability, not one row's value. A secondary relationship is an ADDITION to
-- what a drill says about itself, never a reassignment. Nothing in this
-- migration reads or writes drill_library.skill_id.
--
-- WHY A CHILD TABLE AND NOT A COLUMN. drill_library already carries
-- grounding_claim_ids as text[], so an array of skill codes would have had a
-- local precedent. It is the wrong one. text[] in this schema holds bare,
-- untyped code lists that are only ever read back out with the row that owns
-- them; everything a drill has MANY of and can be asked ABOUT -- scale levels,
-- stop rules, cues -- is a child table keyed back to the drill. Secondary
-- skills are asked about: "which drills also train SK-STANCE-01" is the entire
-- reason for recording them. A child table answers that with an index. An array
-- answers it with a scan, and cannot be constrained against duplicates at all.
--
-- NO SURROGATE KEY, DELIBERATELY. drill_scale_levels, drill_stop_rules and
-- drill_cues each carry one (scale_id, stop_rule_id, cue_id) because none of
-- them has a natural key -- two cues on one drill can legitimately be identical
-- text, so identity has to be handed to them. This relation IS its natural key:
-- a drill either relates to a skill or it does not, and a second identical row
-- would assert nothing new. So (organization_id, drill_id, skill_id) is the
-- primary key, and the uniqueness the owner asked for is that key rather than a
-- separate constraint standing beside a surrogate. pilot.disciplines and
-- pilot.drill_library itself are the local precedent for a natural composite
-- primary key.
--
-- NO relationship_type COLUMN. Every row here is a secondary skill relationship
-- by definition -- that is what the table is. A discriminator with exactly one
-- permitted value is infrastructure for a requirement nobody has, and it would
-- have to be widened by a migration anyway on the day a second kind appears.
--
-- NO FOREIGN KEY ON skill_id, BECAUSE THERE IS NOTHING TO REFERENCE. The skill
-- codes this column holds (SK-STANCE-01, SK-COMBO-03, ...) exist only as text in
-- drill_library.skill_id; no skills registry table exists anywhere in the pilot
-- schema. pilot.skills DID exist once and is NOT that registry -- it was a
-- per-athlete skill-level record (athlete_id, skill_name, level, recorded_at)
-- and was dropped as dead schema by the dead-schema-removal migration. If a
-- skill registry is introduced later, the established local route to govern both
-- this column and drill_library.skill_id is the one
-- pilot_drill_library_discipline_fk took: add the registry, add the key NOT
-- VALID, and validate it deliberately against measured rows.
--
-- THE PRIMARY != SECONDARY INVARIANT IS NOT ENFORCED HERE, AND THAT IS RECORDED
-- RATHER THAN HIDDEN. "A secondary skill must not equal the drill's own primary
-- skill_id" is a CROSS-TABLE condition: a CHECK cannot read another table and a
-- foreign key cannot express inequality, so the only DDL that could enforce it
-- is a trigger -- which the authorizing gate explicitly declined to introduce
-- for a first cut. It is also not yet reachable: this slice adds NO write path.
-- drillLibraryV3.ts is a read-only module and no loader is introduced, so there
-- is currently nowhere such a row could be written from. The invariant belongs
-- to whichever write path is authorized next (a seed loader, or a coach review
-- route), and this paragraph is the record that it was considered and deferred
-- rather than missed.
--
-- STARTS EMPTY. No backfill, and specifically no copy of drill_library.skill_id
-- into this table: the primary owner is not a secondary relationship, and
-- seeding it as one would be exactly the silent reassignment this design
-- forbids. Content assignment is a separate owner-controlled slice.
--
-- DEPENDS ON pilot.drill_library (created by the drill-library-v3 migration,
-- which runs earlier in the `all` list) and on pilot.organizations. No
-- begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-drill-secondary-skills-migration.mjs).

create table if not exists pilot.drill_secondary_skills (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  drill_id        text not null,
  skill_id        text not null,

  constraint pilot_drill_secondary_skills_pkey
    primary key (organization_id, drill_id, skill_id),
  constraint pilot_drill_secondary_skills_drill_fk
    foreign key (organization_id, drill_id)
    references pilot.drill_library(organization_id, drill_id) on delete cascade
);

-- The reverse lookup this table exists to make possible: every drill carrying a
-- given secondary skill. pilot_drill_library_skill is the primary-owner
-- equivalent on drill_library; this is its counterpart for the other half of
-- the answer, so that "find drills related to this skill" is one index hit on
-- each side rather than a scan on one of them.
--
-- Deliberately NOT partial on active: a child row cannot know whether its drill
-- is active, and every read path joins back to drill_library, which filters it.
create index if not exists pilot_drill_secondary_skills_skill
  on pilot.drill_secondary_skills(organization_id, skill_id);

comment on table pilot.drill_secondary_skills is
  'Secondary skill relationships for a drill. pilot.drill_library.skill_id remains the single primary owner and is never written here; rows in this table are ADDITIONAL skills a drill materially trains. Zero-to-many per drill; the primary key is the relationship itself, so a duplicate relation is impossible.';
