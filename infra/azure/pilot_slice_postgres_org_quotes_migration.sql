-- Quotes library (pilot.org_quotes): the gym's own sayings, motivational
-- sayings and boxing quotes, kept per organization, so the chalkboard and the
-- gym TV can pull from a list the gym edits instead of from a source file.
--
-- ONE ROW = ONE QUOTE, scoped to one organization. Quotes are never deleted
-- through the app: a quote that was on the wall is part of what the gym said,
-- so it is switched off (active = false), not removed.
--
-- `shown` carries the moments a quote may appear in, exactly as the existing
-- gymSayings.ts does (anywhere / after-hard-session / at-a-milestone), so the
-- twelve existing sayings keep their placement when they move here.
--
-- A quote is only ever drawn when active. A boxing quote without a source is
-- allowed (the column is the citation when there is one); the gym decides what
-- it is willing to hang on its wall.
--
-- SEED: the twelve sayings already in apps/web/components/gymSayings.ts
-- (owner-approved 2026-08-19), loaded as active gym sayings for the club's own
-- organization (punxsy_prominence) only. Nothing else is seeded. The ids are
-- fixed, and every insert is `on conflict do nothing`, so re-running this never
-- resurrects a line the gym has since edited or switched off. If the
-- organization does not exist in an environment, nothing is seeded there.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-org-quotes-migration.mjs) opens the
-- transaction itself, like the program-phases and announcements runners.
-- Idempotent: create ... if not exists, inserts on conflict do nothing.

create table if not exists pilot.org_quotes (
  organization_id text not null references pilot.organizations(organization_id) on delete cascade,
  quote_id        uuid not null,
  quote_text      text not null
    constraint pilot_org_quotes_text_check check (length(btrim(quote_text)) > 0 and length(quote_text) <= 280),
  speaker         text not null default ''
    constraint pilot_org_quotes_speaker_check check (length(speaker) <= 120),
  quote_type      text not null
    constraint pilot_org_quotes_type_check check (quote_type in ('gym_saying', 'motivational', 'boxing_quote')),
  source          text not null default ''
    constraint pilot_org_quotes_source_check check (length(source) <= 500),
  shown           text[] not null default array['anywhere']::text[]
    constraint pilot_org_quotes_shown_check check (
      cardinality(shown) >= 1
      and shown <@ array['anywhere', 'after-hard-session', 'at-a-milestone']::text[]
    ),
  active          boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, quote_id)
);

-- The same words twice in one gym's library is a mistake, not a second quote.
create unique index if not exists idx_org_quotes_unique_text
  on pilot.org_quotes(organization_id, lower(btrim(quote_text)));

create index if not exists idx_org_quotes_org_active
  on pilot.org_quotes(organization_id, active, created_at desc);

insert into pilot.org_quotes (organization_id, quote_id, quote_text, speaker, quote_type, source, shown, active)
select o.organization_id,
       md5('org-quotes-seed:' || s.quote_text)::uuid,
       s.quote_text, s.speaker, 'gym_saying', '', s.shown, true
from pilot.organizations o
cross join (values
  ('OBSERVE. DECIDE. EXECUTE. REPEAT.', 'the wall', array['anywhere']::text[]),
  ('POOR MAN''S SPORT', 'the wall', array['anywhere']::text[]),
  ('SAFETY FIRST. KIDS FIRST.', 'the wall', array['anywhere']::text[]),
  ('SHOW UP. DO THE WORK. GO HOME BETTER.', 'the wall', array['after-hard-session']::text[]),
  ('THE WORK DOESN''T LIE', 'the wall', array['after-hard-session']::text[]),
  ('KEEP THE STANDARD. KEEP THE KIDS.', 'the wall', array['anywhere']::text[]),
  ('HANDS UP. HEAD CLEAR.', 'the wall', array['after-hard-session']::text[]),
  ('NO HYPE. JUST WORK.', 'the wall', array['anywhere']::text[]),
  ('SHADOW NOTICES THE PATTERN', 'the wall', array['at-a-milestone']::text[]),
  ('CHECK IN. THEN WORK.', 'the wall', array['anywhere']::text[]),
  ('STEEL TOWN. STEADY HANDS.', 'the wall', array['anywhere']::text[]),
  ('WE BUILD PEOPLE, NOT JUST FIGHTERS.', 'the wall', array['at-a-milestone']::text[])
) as s(quote_text, speaker, shown)
where o.organization_id = 'punxsy_prominence'
on conflict do nothing;
