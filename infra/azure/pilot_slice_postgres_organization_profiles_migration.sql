-- THE GYM'S PROFILE, STORED ONCE (lane L31, issue #1469; Overwatch GO 2026-10-16,
-- Q1 A: "The DB table, editable on a screen (Jason asked for one source)").
--
-- One row per organization: the forms of its name the screens use, its public
-- contact details, its addresses and its head coach. Today the same facts are
-- a code constant (apps/web/src/shared/organizationProfile.ts) plus literal
-- copies on the privacy page and in the site metadata; the follow-up pull
-- requests move every reader onto this table and give the organization admin
-- a screen to edit it. This file is schema plus one seed row only. No code on
-- main reads or writes the table yet.
--
-- THE GYM'S NAME OF RECORD STAYS pilot.organizations.organization_name. It is
-- the incorporated name, and it is not repeated here. This table holds only the
-- display forms that the name of record does not carry: the public brand
-- ("&"), the short name and the running-text name.
--
-- Columns are `not null default ''`: an empty value means "not given", and the
-- screens leave that line out. Every column has a length limit. Only the three
-- display names must be non-blank. The reserved platform organization never
-- has a profile.
--
-- No account column: who changed a profile goes in the audit trail
-- (pilot.audit_events), written by the module that edits it, so this table
-- never needs deleting for a person under the retention purge.
--
-- SEED. One row, for the operating organization (punxsy_prominence, by ruling:
-- OD-2026-09-28-007; Overwatch GO, Q5). Its values are the code constant's,
-- copied exactly, with their sources as that file records them. The
-- insert is `on conflict do nothing`, so a re-run (including the
-- apply-migrations `all` sweep) never overwrites what the gym has since
-- edited. If the organization does not exist in an environment, nothing is
-- seeded there.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-profiles-migration.mjs) opens the
-- transaction itself. Idempotent.

create table if not exists pilot.organization_profiles (
  organization_id text not null,
  brand text not null,
  short_name text not null,
  common_name text not null,
  ein text not null default '',
  website_url text not null default '',
  domain text not null default '',
  contact_email text not null default '',
  donations_email text not null default '',
  grants_email text not null default '',
  established text not null default '',
  town text not null default '',
  service_area text not null default '',
  service_area_short text not null default '',
  physical_street text not null default '',
  physical_city text not null default '',
  physical_region text not null default '',
  physical_postal_code text not null default '',
  mailing_address text not null default '',
  head_coach_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pilot_organization_profiles_pkey primary key (organization_id),
  constraint pilot_organization_profiles_org_fk foreign key (organization_id)
    references pilot.organizations (organization_id) on delete cascade,
  constraint pilot_organization_profiles_not_platform_check
    check (organization_id <> '__platform__'),
  constraint pilot_organization_profiles_names_check check (
    btrim(brand) <> '' and btrim(short_name) <> '' and btrim(common_name) <> ''
    and char_length(brand) <= 200 and char_length(short_name) <= 40 and char_length(common_name) <= 200
  ),
  constraint pilot_organization_profiles_lengths_check check (
    char_length(ein) <= 20
    and char_length(website_url) <= 200 and char_length(domain) <= 200
    and char_length(contact_email) <= 254 and char_length(donations_email) <= 254 and char_length(grants_email) <= 254
    and char_length(established) <= 20 and char_length(town) <= 100
    and char_length(service_area) <= 300 and char_length(service_area_short) <= 300
    and char_length(physical_street) <= 200 and char_length(physical_city) <= 100
    and char_length(physical_region) <= 50 and char_length(physical_postal_code) <= 20
    and char_length(mailing_address) <= 300 and char_length(head_coach_name) <= 200
  )
);

insert into pilot.organization_profiles (
  organization_id, brand, short_name, common_name, ein, website_url, domain,
  contact_email, donations_email, grants_email, established, town,
  service_area, service_area_short,
  physical_street, physical_city, physical_region, physical_postal_code,
  mailing_address, head_coach_name
)
select o.organization_id,
       'Punxsy Prominence Boxing & Fitness',
       'PPBF',
       'Punxsy Prominence',
       '99-2073622',
       'https://www.punxsyprominence.org',
       'punxsyprominence.org',
       'admin@punxsyprominence.org',
       'treasurer@punxsyprominence.org',
       'grants@punxsyprominence.org',
       '2024',
       'Punxsutawney',
       'Punxsutawney and surrounding rural western Pennsylvania communities',
       'Punxsutawney and surrounding rural Pennsylvania communities',
       '220 N Jefferson St',
       'Punxsutawney',
       'PA',
       '15767',
       'PO Box 54, Big Run, PA 15715',
       'Jason Neale'
from pilot.organizations o
where o.organization_id = 'punxsy_prominence'
  -- Redundant with the line above, kept because platformLibraryScope.test.ts
  -- requires every per-organization seed to exclude the reserved organization.
  and o.organization_id <> '__platform__'
on conflict do nothing;
