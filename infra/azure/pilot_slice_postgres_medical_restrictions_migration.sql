-- USA Boxing medical restrictions (pilot.medical_restrictions; Backbone schema
-- proposal P22, approved 2026-10-25).
--
-- WHAT A ROW IS. One USA Boxing medical restriction on one member: where it
-- came from (a ringside Restriction Affidavit, a training knockout or
-- concussion, or other), the loss-of-consciousness answer, its start date and
-- minimum end date, and -- once they happen -- the date a physician's
-- clearance or medical release was signed and the date the LBC (or its
-- registration chair) was informed. USA Boxing Rule Book 2026, Rule 5.4(7) and
-- the Restriction Affidavit form in its appendix. THE APP STORES THE DATE, NOT
-- THE DOCUMENT (P22; Jason's card OW25-05 A).
--
-- WHAT IT DRIVES (OD-2026-11-10-002, narrowed by Jason's cards OW25-04 B and
-- OW25-11 B). During a restriction, or after it with no release on file, the
-- app refuses entries at contact level 'controlled_sparring' or
-- 'open_sparring' for that member and names the restriction as the reason.
-- 'none', 'light_technical' and 'conditioned' still save, with the note. The
-- gate lifts when the release date is on file and the minimum end date has
-- passed. Nobody overrides it: the coach may stop, reduce or defer
-- (AGENT_KERNEL.md authority doctrine), and no coach, parent or leadership
-- member may override "a medical hold or return-to-play restriction".
--
-- WHO WRITES (OW25-05 A). A gym admin or the member's coach records the
-- restriction, the release date and the LBC date. Each is set once (a guarded
-- UPDATE where the column is still null), never edited in place.
--
-- ENTERED IN ERROR (Overwatch, applying OD-2026-11-10-002 at lane P22 step 1,
-- Q7). A gym admin (organization_admin or admin) may mark a record voided, with
-- a required reason. This is a data correction for a record entered against the
-- wrong member or with wrong dates, not an override: the row is kept and shown
-- as voided in staff history, never deleted, and a coach cannot void.
--
-- WHO READS. Staff read the whole row through the coach route. The member and
-- their parent see only that a restriction is on file, its minimum end date,
-- and that a physician's release is needed -- never the source (the affidavit
-- details), the loss-of-consciousness field, the note, the incident link or the
-- LBC date (OW25-06 A).
--
-- linked_incident_id is P20's incident id. P20's table does not exist yet, so
-- there is no foreign key; the column is text and nullable.
--
-- No `begin;`/`commit;` here on purpose: the runner
-- (apps/web/scripts/pilot-apply-medical-restrictions-migration.mjs) opens the
-- transaction itself. Idempotent: create ... if not exists.

create table if not exists pilot.medical_restrictions (
  organization_id                 text not null references pilot.organizations(organization_id) on delete cascade,
  restriction_id                  uuid not null,
  athlete_id                      text not null,

  source                          text not null
    constraint pilot_medical_restrictions_source_check check (
      source in ('ringside_affidavit', 'training_knockout_or_concussion', 'other')
    ),
  loss_of_consciousness           text not null
    constraint pilot_medical_restrictions_loc_check check (
      loss_of_consciousness in ('none', 'under_1_min', 'over_1_min', 'unknown')
    ),
  start_date                      date not null,
  minimum_end_date                date not null,

  -- The physician's clearance or medical release: the date it was signed, and
  -- who recorded that date and when. All four together or none.
  release_signed_on               date null,
  release_recorded_by_account_id  text null,
  release_recorded_by_role        text null,
  release_recorded_at             timestamptz null,

  -- The LBC informed (or the release sent to the LBC registration chair).
  lbc_informed_on                 date null,
  lbc_recorded_by_account_id      text null,
  lbc_recorded_at                 timestamptz null,

  linked_incident_id              text null
    constraint pilot_medical_restrictions_incident_check check (
      linked_incident_id is null or length(linked_incident_id) between 1 and 200
    ),
  note                            text not null default ''
    constraint pilot_medical_restrictions_note_check check (length(note) <= 2000),

  recorded_by_account_id          text not null,
  recorded_by_role                text not null,
  recorded_at                     timestamptz not null default clock_timestamp(),

  voided_at                       timestamptz null,
  voided_by_account_id            text null,
  voided_by_role                  text null,
  void_reason                     text null,

  updated_at                      timestamptz not null default clock_timestamp(),

  primary key (organization_id, restriction_id),
  constraint pilot_medical_restrictions_athlete_fk
    foreign key (organization_id, athlete_id)
    references pilot.athletes(organization_id, athlete_id)
    on delete cascade,
  constraint pilot_medical_restrictions_dates_check check (
    minimum_end_date >= start_date
    and (release_signed_on is null or release_signed_on >= start_date)
  ),
  constraint pilot_medical_restrictions_recorded_role_check check (
    recorded_by_role in ('coach', 'organization_admin', 'admin')
  ),
  constraint pilot_medical_restrictions_release_check check (
    (release_signed_on is null
      and release_recorded_by_account_id is null
      and release_recorded_by_role is null
      and release_recorded_at is null)
    or (release_signed_on is not null
      and release_recorded_by_account_id is not null
      and release_recorded_by_role in ('coach', 'organization_admin', 'admin')
      and release_recorded_at is not null)
  ),
  constraint pilot_medical_restrictions_lbc_check check (
    (lbc_informed_on is null and lbc_recorded_by_account_id is null and lbc_recorded_at is null)
    or (lbc_informed_on is not null and lbc_recorded_by_account_id is not null and lbc_recorded_at is not null)
  ),
  -- A coach can never void: voided_by_role admits only the two admin roles.
  constraint pilot_medical_restrictions_void_check check (
    (voided_at is null and voided_by_account_id is null and voided_by_role is null and void_reason is null)
    or (voided_at is not null
      and voided_by_account_id is not null
      and voided_by_role in ('organization_admin', 'admin')
      and void_reason is not null
      and length(btrim(void_reason)) between 1 and 500)
  )
);

-- Every read is one member's restrictions in one organization: the staff list
-- and the gate's probe.
create index if not exists idx_medical_restrictions_athlete
  on pilot.medical_restrictions(organization_id, athlete_id);

-- THE ROW'S OWN RULES, HELD BY THE DATABASE (adversarial review of P22a).
-- The route already writes each of these once, but a CHECK cannot see the old
-- row, so without this any future code path (or a hand-run UPDATE) could move a
-- minimum end date earlier, overwrite a release date, date a release in the
-- future, or delete the record -- each of which lifts the gate early.
--   * The facts of the restriction never change after insert: organization,
--     member, source, loss of consciousness, start and minimum end dates,
--     incident link, note, who recorded it and when. A wrong record is voided
--     by a gym admin and recorded again.
--   * The release, LBC and void groups go from empty to set, once, and never
--     change after that.
--   * A release cannot be dated after the gym's today (America/New_York, the
--     gym day gymTime.ts uses) at the moment it is written.
--   * A row is never deleted directly. It goes only with its member or its
--     organization (the foreign-key cascades, which the retention purge in
--     pilot-cleanup-deleted-data.mjs relies on). In a cascade the parent
--     row's delete is already visible when this trigger runs, so a delete is
--     refused while BOTH the member's row and the organization's row still
--     exist -- whether it is a plain DELETE or one issued from some other
--     trigger. (TRUNCATE skips row triggers; only the table owner can run it.)
create or replace function pilot.medical_restrictions_guard() returns trigger
language plpgsql as $$
declare
  gym_today date := (clock_timestamp() at time zone 'America/New_York')::date;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from pilot.athletes a
                where a.organization_id = old.organization_id and a.athlete_id = old.athlete_id)
       and exists (select 1 from pilot.organizations o where o.organization_id = old.organization_id) then
      raise exception 'MEDICAL_RESTRICTION_NOT_DELETABLE: a medical restriction is never deleted; a gym admin marks one entered in error';
    end if;
    return old;
  end if;

  if new.release_signed_on is not null
     and (tg_op = 'INSERT' or old.release_signed_on is null)
     and new.release_signed_on > gym_today then
    raise exception 'MEDICAL_RESTRICTION_RELEASE_IN_FUTURE: a release cannot be dated after today';
  end if;

  if tg_op = 'UPDATE' then
    if (new.organization_id, new.restriction_id, new.athlete_id, new.source, new.loss_of_consciousness,
        new.start_date, new.minimum_end_date, new.linked_incident_id, new.note,
        new.recorded_by_account_id, new.recorded_by_role, new.recorded_at)
       is distinct from
       (old.organization_id, old.restriction_id, old.athlete_id, old.source, old.loss_of_consciousness,
        old.start_date, old.minimum_end_date, old.linked_incident_id, old.note,
        old.recorded_by_account_id, old.recorded_by_role, old.recorded_at) then
      raise exception 'MEDICAL_RESTRICTION_FIXED_FIELDS: the facts of a medical restriction are not edited; void it and record it again';
    end if;
    if old.release_signed_on is not null
       and (new.release_signed_on, new.release_recorded_by_account_id, new.release_recorded_by_role, new.release_recorded_at)
           is distinct from
           (old.release_signed_on, old.release_recorded_by_account_id, old.release_recorded_by_role, old.release_recorded_at) then
      raise exception 'MEDICAL_RESTRICTION_SET_ONCE: the release date is already on file';
    end if;
    if old.lbc_informed_on is not null
       and (new.lbc_informed_on, new.lbc_recorded_by_account_id, new.lbc_recorded_at)
           is distinct from (old.lbc_informed_on, old.lbc_recorded_by_account_id, old.lbc_recorded_at) then
      raise exception 'MEDICAL_RESTRICTION_SET_ONCE: the LBC date is already on file';
    end if;
    if old.voided_at is not null
       and (new.voided_at, new.voided_by_account_id, new.voided_by_role, new.void_reason)
           is distinct from (old.voided_at, old.voided_by_account_id, old.voided_by_role, old.void_reason) then
      raise exception 'MEDICAL_RESTRICTION_SET_ONCE: the record is already marked entered in error';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_medical_restrictions_guard on pilot.medical_restrictions;
create trigger trg_medical_restrictions_guard
  before insert or update or delete on pilot.medical_restrictions
  for each row execute function pilot.medical_restrictions_guard();
