-- pilot.waivers.status: hold the column to the vocabulary its readers use.
--
-- THE GAP. pilot.waivers.status is `text not null` and nothing else. Two of
-- its writers store a literal (grantMediaConsent 'signed', withdrawMediaConsent
-- 'withdrawn'); the other two stored whatever a caller sent:
-- POST /api/pilot/intake/domain-upsert wrote asString(body.payload.status,
-- 'signed'), and POST /api/pilot/intake/review-action wrote the promotion
-- payload's waiver.status unread. Every reader already fails CLOSED on a value
-- it does not know (waiverCompliance.normalizeWaiverStatus maps it to
-- 'missing'; guardianConsent tests `=== 'signed'`; the video gate answers
-- 409), so an odd value was never a leak -- it was a family whose signed
-- paperwork could read as missing, and a column that could say anything.
--
-- THE DECISION. Owner, 2026-09-29, Q3 answer A ("all recommended"): add the
-- strict database rule now. The earlier owner decision (2026-08-29, D-7) was to
-- measure production before proposing any CHECK here; the census
-- (npm run --workspace apps/web pilot:check-waiver-statuses) run on 2026-09-29
-- reported 11 rows, every one byte-exact 'signed', so this refuses none there.
-- No other environment is measured by this file.
--
-- THE VOCABULARY is exactly WAIVER_STATUSES in
-- apps/web/src/server/pilot/waiverCompliance.ts -- signed, declined, withdrawn,
-- missing -- and the copy of it in scripts/pilot-check-waiver-statuses.mjs.
-- waiverCompliance.test.ts asserts this file names the same four, and the
-- runner refuses a database whose constraint admits any other set. 'missing'
-- is the value readers synthesise for "no row"; a stored 'missing' reads as no
-- signature to every reader, so admitting it cannot open any gate.
--
-- BYTE-EXACT, NOT NORMALISED. ' Signed ' and 'SIGNED' are refused. The readers
-- keep trimming and lowercasing -- that protects any database this migration
-- has not reached yet -- but new rows arrive exact, because the two free-text
-- writers now refuse anything outside the list with a 400 before they write
-- (requireWaiverStatus in waiverCompliance.ts), so this constraint is the floor
-- under them, not the error a caller sees.
--
-- VALIDATED, NOT `NOT VALID`, for the reason
-- pilot_slice_postgres_membership_account_fk_migration.sql sets out: a
-- `not valid` constraint records that existing rows were never checked. If a
-- database does hold a non-exact row, the ALTER fails with 23514 naming
-- pilot_waivers_status_check and changes nothing. Postgres does not name the
-- row; the census lists every one, and the runner prints the count before it
-- applies. What to do with such a row is a data decision this file does not
-- take.
--
-- Idempotent: catalog-guarded add, no drops, no rewrites, no backfill. No
-- begin;/commit; here on purpose, matching this repo's
-- runner-opens-the-transaction convention (the runner is
-- apps/web/scripts/pilot-apply-waiver-status-check-migration.mjs).

do $pilot_waivers_status_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pilot_waivers_status_check'
      and conrelid = to_regclass('pilot.waivers')
  ) then
    alter table pilot.waivers
      add constraint pilot_waivers_status_check
      check (status in ('signed', 'declined', 'withdrawn', 'missing'));
  end if;
end
$pilot_waivers_status_check$;

comment on constraint pilot_waivers_status_check on pilot.waivers is
  'Exactly WAIVER_STATUSES in apps/web/src/server/pilot/waiverCompliance.ts, byte for byte. domain-upsert and review-action refuse anything else with a 400 before writing. This is the floor under them.';
