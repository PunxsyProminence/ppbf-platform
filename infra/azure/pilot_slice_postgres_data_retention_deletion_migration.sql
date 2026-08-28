-- Data retention and deletion infrastructure
--
-- Adds soft-delete (deleted_at) tracking to tables holding minor data,
-- and cascade-deletion logic so that deleting a guardian also marks the
-- athletes who depended on that guardian alone for deletion.
--
-- The cascade is narrowed to the sole-guardian case (2026-08-28). It
-- previously stamped EVERY linked athlete, so retiring one guardian of a
-- co-guardianed child withdrew that child and took the remaining guardian's
-- access to their own kid with it. Split households are ordinary, not an
-- edge case, and nothing in the retirement path made the loss visible: the
-- admin route reports a cascade count, not which families it reached.
--
-- The cascade also closes the withdrawn athlete's own login (2026-08-28).
-- It used to write athletes.deleted_at and nothing else, while the explicit
-- withdrawal path deliberately writes three things -- the row, the account's
-- active_flag, and every live session -- because writing only the row leaves
-- a withdrawn minor signed in to their own record for the full retention
-- window. See the note above the account update below.
--
-- Idempotent and safe to re-apply.
--
-- This file deliberately has NO outer `do $$ ... $$` wrapper. The first
-- version had one, and the plpgsql function body below is itself dollar-quoted:
-- the inner `$$` closed the outer block early and the whole migration died with
-- a syntax error at the function definition. Every statement here is already
-- idempotent on its own (`if not exists` / `or replace`), so the wrapper bought
-- nothing and cost the deployment.

-- --- pilot.accounts: track guardian/parent deletion ---
alter table pilot.accounts add column if not exists deleted_at timestamptz null;

-- --- pilot.athletes: track athlete withdrawal ---
alter table pilot.athletes add column if not exists deleted_at timestamptz null;

-- --- pilot.coach_observations: already cascade-deletes with athlete ---
-- (no change needed; constraint is already present)

-- --- Partial indexes: the active-record path, which is every read ---
create index if not exists idx_athletes_active_org
  on pilot.athletes(organization_id, athlete_id)
  where deleted_at is null;

create index if not exists idx_accounts_active_org
  on pilot.accounts(organization_id)
  where deleted_at is null;

-- --- Cascade deletion trigger: when a parent is deleted, mark their athletes ---
--
-- Why a trigger instead of a foreign key cascade: we want to SOFT-delete the
-- athletes (mark deleted_at, not remove the row), so the cascade is "when
-- accounts.deleted_at becomes NOT NULL, set athletes.deleted_at for the linked
-- athletes this guardian was the last guardian of". A FK cascade would DELETE
-- the rows outright, which discards them before the retention window this
-- migration exists to enforce.
--
-- WHY THE CASCADE STOPS AT A CO-GUARDIANED CHILD
--
-- The justification for withdrawing an athlete when their guardian leaves is
-- that nobody is left to act for them. That reasoning does not reach a child
-- who still has a second guardian, and the original cascade applied it anyway:
-- it selected every athlete reachable through this account's guardian_links
-- with no regard for who else held them. One parent of a split household
-- retiring their own account therefore withdrew the child from the program and
-- revoked the other parent's access -- an irreversible-by-1-year effect on two
-- people who took no action, from a self-service-shaped operation.
--
-- "Another guardian" is counted by ACCOUNT, not by pilot.parents row, because
-- one account legitimately backs several parent records (guardianAccess.ts's
-- guardianParentIds), and counting rows would read this guardian's own second
-- record as somebody else and cancel a cascade that has nobody left to justify
-- it. A guardian whose account is itself already soft-deleted does not count --
-- they are not still here. A pilot.parents row with account_id null DOES count:
-- intake records a guardian before, or without, that adult holding a login, and
-- retaining the athlete row is the recoverable direction. Withdrawing an
-- athlete outright remains available as its own explicit operation either way.
--
-- WHY THE ATHLETES ARE LOCKED BEFORE THE CHECK
--
-- Narrowing the cascade introduced a read the unconditional version never
-- made, and a conditional read is a race. Under READ COMMITTED two guardians
-- of the same athlete retiring concurrently each see the OTHER's deleted_at
-- as still null -- neither transaction has committed -- so both answer "there
-- is another live guardian", both skip, and the athlete is left enrolled with
-- nobody holding them. That is the exact state the cascade exists to prevent,
-- reached by making it conditional, and it is silent: no error, no audit row,
-- both retirements report success.
--
-- Locking the candidate athletes FOR UPDATE first is what orders the two
-- retirements. The second one blocks until the first commits, and because
-- each statement in a plpgsql function takes its own snapshot under READ
-- COMMITTED, the update that follows the lock sees the first guardian as
-- retired and cascades. Whoever commits last is the one with nobody behind
-- them, which is the correct answer either way round.
--
-- `order by a.athlete_id` is deadlock avoidance, not cosmetics: two guardians
-- sharing several children must take those row locks in the same order. The
-- sibling-liveness check itself stays an unlocked read -- locking those
-- account rows too would have each transaction holding its own account and
-- waiting on the other's, which is a cycle.
--
-- The join runs accounts -> parents -> guardian_links, and that indirection is
-- the point. guardian_links.parent_id references pilot.parents(parent_id); it
-- is NOT an account id. The first version matched gl.parent_id directly against
-- new.account_id, which selects no rows -- the cascade would have reported
-- success and silently orphaned every athlete it was written to protect.
create or replace function pilot.cascade_parent_deletion()
returns trigger as $fn$
declare
  withdrawn_athlete_ids text[];
  closed_account_ids text[];
begin
  if new.deleted_at is not null and old.deleted_at is null then
    -- Order the concurrent retirements on the children they share, before
    -- reading who else is still live. See the note above.
    perform 1
       from pilot.athletes a
      where a.organization_id = new.organization_id
        and a.deleted_at is null
        and a.athlete_id in (
          select gl.athlete_id
            from pilot.guardian_links gl
            join pilot.parents p
              on p.organization_id = gl.organization_id
             and p.parent_id = gl.parent_id
           where gl.organization_id = new.organization_id
             and p.account_id = new.account_id
        )
      order by a.athlete_id
        for update;

    with cascaded as (
      update pilot.athletes a
         set deleted_at = new.deleted_at,
             updated_at = now()
       where a.organization_id = new.organization_id
         -- Never overwrite an earlier deletion timestamp: an athlete withdrawn
         -- before their guardian keeps their own, earlier, retention clock.
         and a.deleted_at is null
         and a.athlete_id in (
           select gl.athlete_id
             from pilot.guardian_links gl
             join pilot.parents p
               on p.organization_id = gl.organization_id
              and p.parent_id = gl.parent_id
            where gl.organization_id = new.organization_id
              and p.account_id = new.account_id
         )
         -- ...and only where this guardian was the last one holding them. See
         -- the note above for why the count is by account rather than by
         -- pilot.parents row, and why an account-less guardian record counts.
         and not exists (
           select 1
             from pilot.guardian_links other_link
             join pilot.parents other_parent
               on other_parent.organization_id = other_link.organization_id
              and other_parent.parent_id = other_link.parent_id
             left join pilot.accounts other_account
               on other_account.account_id = other_parent.account_id
            where other_link.organization_id = a.organization_id
              and other_link.athlete_id = a.athlete_id
              and (
                other_parent.account_id is null
                or (
                  other_parent.account_id <> new.account_id
                  and other_account.deleted_at is null
                )
              )
         )
      returning a.athlete_id
    )
    select array_agg(athlete_id) into withdrawn_athlete_ids from cascaded;

    -- CLOSING THE WITHDRAWN MINOR'S OWN LOGIN
    --
    -- Withdrawing an athlete takes three writes, not one. deleteAthleteRecord
    -- (dataDeletion.ts) does all three and records why: the self-access branch
    -- of assertActorCanAccessAthlete compares actor.athleteId to the requested
    -- id and reads no row at all, so nothing downstream of a session ever
    -- consults athletes.deleted_at. Marking the athlete row and stopping there
    -- leaves the minor signed in to their own withdrawn record for the whole
    -- two-year retention window.
    --
    -- The cascade reached the same end state through this trigger and wrote
    -- exactly one of the three. So the door the explicit path closes stayed
    -- open on precisely the athletes nobody chose individually -- the ones
    -- withdrawn as a side effect of an adult's account action, where no
    -- operator is looking at the athlete at all.
    --
    -- Scoped to the athletes this statement just stamped, not to every athlete
    -- reachable from the guardian. A co-guardianed child the cascade
    -- deliberately left enrolled must keep their login: narrowing the row in
    -- one statement and taking the account in the next would undo the
    -- narrowing through the other door.
    --
    -- organization_id is part of the predicate because pilot.accounts is keyed
    -- by account_id alone and athlete_id is only unique WITHIN an
    -- organization. Two gyms may hold the same athlete_id; an unscoped update
    -- would deactivate the wrong minor at the other one.
    --
    -- No recursion: the trigger's WHEN clause fires only for new.role =
    -- 'parent', and every row this touches is role = 'athlete'.
    if withdrawn_athlete_ids is not null then
      with deactivated as (
        update pilot.accounts acct
           set deleted_at = new.deleted_at,
               active_flag = false,
               updated_at = now()
         where acct.organization_id = new.organization_id
           and acct.role = 'athlete'
           and acct.athlete_id = any(withdrawn_athlete_ids)
           and acct.deleted_at is null
        returning acct.account_id
      )
      select array_agg(account_id) into closed_account_ids from deactivated;

      -- A PIN that no longer works is not enough on its own: an athlete
      -- already signed in holds a session token that resolvePrincipal accepts
      -- without re-reading active_flag. Same transaction as the deletion, so
      -- there is no window in which the athlete is withdrawn but a live
      -- session still resolves.
      if closed_account_ids is not null then
        update pilot.session_tokens
           set revoked_at = now()
         where account_id = any(closed_account_ids)
           and revoked_at is null;
      end if;
    end if;
  end if;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists pilot_cascade_parent_deletion_trigger on pilot.accounts;

create trigger pilot_cascade_parent_deletion_trigger
  after update on pilot.accounts
  for each row
  when (new.role = 'parent')
  execute function pilot.cascade_parent_deletion();

-- --- Audit event type: DATA_DELETION_INITIATED ---
-- The audit system already supports custom event_type values via the check
-- constraint, but we document that DATA_DELETION_INITIATED is a valid type.
-- If the constraint needs expansion, that's a separate admin migration.
-- For now, log to audit_events.details as jsonb.
