-- Quotes library, owner ruling D19 (OD-2026-10-08-009: "the gym sayings match
-- his approved list"): Steel Town comes off the wall and AMPLECTERE MISERIAM
-- goes on. Two rows, for the club's own organization (punxsy_prominence) only.
--
-- ROW 1 -- STEEL TOWN IS SWITCHED OFF, NOT DELETED. pilot.org_quotes is never
-- deleted from (see pilot_slice_postgres_org_quotes_migration.sql): a line that
-- was on the wall is part of what the gym said.
--
-- It is switched off only while it is still exactly as the seed left it:
-- active, and never edited since (updated_at = created_at; the seed writes both
-- in one statement and every edit through orgQuotes.ts moves updated_at). So:
--   * the first run switches it off and moves updated_at;
--   * every later run, including the apply-migrations `all` sweep, matches
--     nothing -- if the gym deliberately switches it back on through
--     /admin/quotes, re-running this never overrides that;
--   * if the gym had already edited or switched off that row before this ran,
--     the gym's own edit stands and nothing changes.
-- The row is found by the seed's own fixed id (md5 of the seed text, the
-- org-quotes migration's pattern) AND its text, so only the seeded row is ever
-- touched: a Steel Town line the gym types in again later, as its own row, is
-- the gym's choice and is never switched off by a re-run.
--
-- ROW 2 -- AMPLECTERE MISERIAM is added as an active gym saying. Speaker and
-- placement are inherited from the line it replaces (egg 11, Steel Town:
-- 'the wall', shown anywhere); the wording is egg 11 of the approved list as
-- recorded second-hand in this repository (OWNER_DECISIONS.md, ACTIVE_WORK.md),
-- to be confirmed against the hand-off before this is applied. The id is fixed
-- (the seed's md5 pattern) and the insert is `on conflict do nothing`, so a
-- re-run never resurrects it after the gym edits or switches it off, and if the
-- gym already typed the same words the unique-text index makes it a no-op.
--
-- If the organization does not exist in an environment, nothing happens there.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-org-quotes-d19-migration.mjs) opens the
-- transaction itself, like the org-quotes runner. Idempotent.

update pilot.org_quotes
   set active = false,
       updated_at = now()
 where organization_id = 'punxsy_prominence'
   and quote_id = md5('org-quotes-seed:STEEL TOWN. STEADY HANDS.')::uuid
   and quote_text = 'STEEL TOWN. STEADY HANDS.'
   and active
   and updated_at = created_at;

insert into pilot.org_quotes (organization_id, quote_id, quote_text, speaker, quote_type, source, shown, active)
select o.organization_id,
       md5('org-quotes-seed:' || s.quote_text)::uuid,
       s.quote_text, s.speaker, 'gym_saying', '', s.shown, true
from pilot.organizations o
cross join (values
  ('AMPLECTERE MISERIAM', 'the wall', array['anywhere']::text[])
) as s(quote_text, speaker, shown)
where o.organization_id = 'punxsy_prominence'
  -- Redundant with the line above, kept because platformLibraryScope.test.ts
  -- requires every per-organization seed to exclude the reserved organization.
  and o.organization_id <> '__platform__'
on conflict do nothing;
