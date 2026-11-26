-- The gym's own names for its rooms and a few card headings, per organization
-- (pilot.organization_room_names): lane W4-9, PR RN-1a (the table; its module
-- and route are RN-1b).
--
-- WHY. Jason, OW27-11 (OD-2026-11-20-001): "these room should be able to be
-- changed in the app by the organization to relat e to it". OW27-40 A
-- (OD-2026-11-21-007) set what can be renamed: the Room Map rooms (and the 7
-- rooms while their names still show), the OW27-15 names and "My Corner".
-- Overwatch's answer Q-A on #2212 adds the family and staff forms ("Who they
-- train with", "Coach Entry") as names of their own.
--
-- ABSENCE MEANS THE DEFAULT. A gym with no row for a name shows the name the
-- app ships with, stated once in code (apps/web/src/shared/roomNames.ts,
-- RN-1b). Deploying this migration writes no row, so every gym starts on the
-- defaults; "Use the default" deletes the row (RN-1b).
--
-- THE LIST OF NAMES LIVES IN CODE, NOT HERE (W4_SIZING.md item 9, RN-1: "from
-- a closed list of keys in code"). name_key's CHECK holds only the shape
-- (place:, room: or card:, then lower-case words joined by hyphens), so adding
-- a name to the list needs no migration. The store refuses a key that is not
-- on the code list.
--
-- THE NAME ITSELF (Overwatch's answer Q-C on #2212): 1 to 40 characters,
-- trimmed, no line breaks or control characters. The store trims and checks
-- first; this CHECK is the backstop for a row written any other way.
-- - Characters are counted as code points, as char_length counts them.
-- - "Trimmed" means no leading or trailing character from JavaScript's trim()
--   set, not just the ASCII space btrim strips (a leading NBSP or U+3000 is
--   refused). The class is the one source_rights_migration.sql and
--   locatorWhitespace.ts already use.
-- - Control characters and line breaks are written as code points (C0, DEL,
--   C1, U+2028, U+2029), not [[:cntrl:]], whose reach depends on the
--   database's LC_CTYPE and locale provider. So the rule is the same on every
--   server, and the store can copy it exactly.
-- Duplicates within a list (Q-B) are the store's to refuse: they depend on the
-- defaults in code, which this table does not hold.
--
-- WHY A TABLE AND NOT A COLUMN ON pilot.organizations. The same reason as
-- pilot.organization_tablet_idle_policy and
-- pilot.organization_stopped_coming_policy: that table is identity, and a
-- typed table per setting keeps its CHECKs and its "who set it, when" beside
-- it. One row per gym per renamed name, so the primary key is the pair.
--
-- WHO SET IT. set_by_account_id names the gym admin who saved the name; on
-- delete set null, so a departed admin does not take the gym's names with
-- them. The audit stream holds each change with the old and new name
-- (written by roomNames.ts, RN-1b, as entity_type 'organization_room_name';
-- pilot.audit_events.entity_type is free text with no CHECK, so no audit
-- vocabulary change is needed here).
--
-- NO PERSON DATA. A gym's words for its rooms and who saved them. No athlete,
-- family, attendance or session is stored here.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-organization-room-names-migration.mjs) opens
-- the transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.organization_room_names (
  organization_id    text not null
    references pilot.organizations(organization_id) on delete cascade,
  name_key           text not null
    constraint pilot_org_room_names_key_check check (name_key ~ '^(place|room|card):[a-z]+(-[a-z]+)*$'),
  display_name       text not null
    constraint pilot_org_room_names_display_name_check check (
      char_length(display_name) between 1 and 40
      and display_name !~ '^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
      and display_name !~ '[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
      and display_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
    ),
  set_by_account_id  text null references pilot.accounts(account_id) on delete set null,
  set_at             timestamptz not null default clock_timestamp(),
  constraint organization_room_names_pkey primary key (organization_id, name_key)
);

-- Read once per signed-in session, by organization: the primary key's leading
-- column is the access path, so there is no other index.

comment on table pilot.organization_room_names is
  'A gym''s own names for its rooms and card headings, one row per renamed name (no row = the default in code). Keys are place:, room: or card: names from apps/web/src/shared/roomNames.ts; 1 to 40 characters. Set by the gym admin (OW27-11, OW27-40 A). Lane W4-9, RN-1a.';
