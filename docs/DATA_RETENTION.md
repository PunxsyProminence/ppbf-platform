# PPBF Data Retention and Deletion Policy

**Effective date:** 2026-08-06  
**Last updated:** 2026-09-29  
**Policy owner:** Organization Admin (enforcement), Platform Owner (policy changes)

**What is built (checked 2026-09-29; OD-2026-09-28-008; Jason 2026-09-29, "10 C" and "1A").**
Deletion is an organization-admin API, `DELETE /api/pilot/admin/data-deletion`
(`apps/web/app/api/pilot/admin/data-deletion/route.ts`), the `/admin/data-deletion` screen
over it (`apps/web/app/admin/data-deletion/page.tsx`, door "Data Deletion" in the office),
and the cleanup job in Method 1. The screen does scope A only, which is what the API already
did: the person's record is marked deleted, their login closes and anyone signed in as them is
signed out; their videos, photos and notes stay on file. **Next, as a separate change (B):**
marking everything tied to the athlete deleted at the same moment. Still **NOT BUILT**: a
preview of what will be deleted, a 1-year restore, and a compliance report. Whether stored
video and photo files are erased when a record is permanently removed is **UNVERIFIED**.

## Overview

This policy defines how long PPBF retains data about minors and their families, why retention is necessary, and how data is deleted when it reaches the end of its useful life.

**Principle:** Data minimization. PPBF collects and retains minors' personal data only for legitimate operational and legal purposes. Once that purpose is fulfilled or the relationship ends, data is deleted.

**Compliance scope:**
- FERPA (US Family Educational Rights and Privacy Act)
- COPPA (US Children's Online Privacy Protection Act)
- GDPR (EU General Data Protection Regulation, if applicable)
- State-level education and youth-serving organization privacy laws

## Data Categories and Retention Windows

**What enforces these today:** two windows only. The cleanup job, when a person dispatches it
with `apply=APPLY` (the nightly run is a dry run, Method 1), hard-deletes athlete rows 2 years
after `deleted_at` (the table below says 1 year for the athlete record) and guardian accounts
1 year after (`apps/web/scripts/pilot-cleanup-deleted-data.mjs:47-48`). No job
enforces the other windows below, and nothing sets `deleted_at` at age 18.

### Athletes

| Data Type | Retention Window | Reason | Deletion Trigger |
|---|---|---|---|
| Athlete record (name, DOB, contact info) | Until relationship ends + 1 year | Legal/accounting; insurance claims may arise 1 year later | Athlete withdraws or turns 18 + 1 year |
| Athlete photos/videos | Until relationship ends + 2 years | Safeguarding: visual evidence of consent, condition at withdrawal | Athlete withdraws or turns 18 + 2 years |
| Medical records (intake form) | Until relationship ends + 3 years | Legal: state athletic commission requirements | Athlete withdraws or turns 18 + 3 years |
| Training notes (sessions, observations) | Until relationship ends + 2 years | Safeguarding: coach observations may be needed for incidents | Athlete withdraws or turns 18 + 2 years |
| Waivers and consent forms | Until relationship ends + 3 years | Legal: liability defense window | Athlete withdraws or turns 18 + 3 years |

### Guardians/Parents

| Data Type | Retention Window | Reason | Deletion Trigger |
|---|---|---|---|
| Parent/guardian account | Until all linked children turn 18 + 1 year | Legal: authority over minors expires at age of majority | Last linked child turns 18 + 1 year |
| Parent contact info | Until relationship ends + 1 year | Operational: contact for emergencies, school events | Parent requests removal or last child withdraws + 1 year |
| Parent messages/communications | Until relationship ends + 1 year | Operational: record of requests, decisions | Relationship ends + 1 year |
| Consent records (photo/video) | Until child turns 18 + 3 years | Legal: proof of consent was obtained and when | Child turns 18 + 3 years |

### Organization Staff

| Data Type | Retention Window | Reason | Deletion Trigger |
|---|---|---|---|
| Coach/staff account | Duration of employment + 3 years | Legal: employment records, incident investigation | Staff leaves organization + 3 years |
| Coach observations about athletes | Duration of employment + 2 years | Safeguarding: historical context for investigations | Staff leaves + 2 years |

### System Records

| Data Type | Retention Window | Reason | Deletion Trigger |
|---|---|---|---|
| Audit logs | 7 years | Legal: SOX compliance, incident investigation window | Created 7 years ago |
| Session tokens | 30 days after expiration/revocation | Forensic window: debug session issues | Expired 30 days ago |
| Deleted account logs | 1 year | Forensic window: prove what was deleted and when | Deletion logged 1 year ago |

## How Data Gets Deleted

### Method 1: Automatic Deletion (Background Process)

A GitHub Actions workflow (`.github/workflows/retention-cleanup.yml`) runs the
script `npm run pilot:cleanup-deleted-data` (`apps/web/scripts/pilot-cleanup-deleted-data.mjs`)
every night at 07:40 UTC. The scheduled run is always a **dry run**: it
reports what it would delete and hard-deletes nothing. Actually deleting
requires a human to manually dispatch the same workflow with the `apply`
input set to the literal string `APPLY` (any other value, including the
default `DRY_RUN`, stays a dry run); the dispatch also lets the operator cap
the run with `max_rows`. This is deliberate — retention windows here are
measured in years, so waiting a day for a human to confirm the dry-run
numbers look right costs nothing, while an automatic purge that is wrong is
unrecoverable.

**Preconditions:**
- Data must have a `created_at` or `deleted_at` timestamp
- Data must be explicitly marked for deletion (e.g., account `deleted_at` is not null)
- Soft-delete (marking `deleted_at`) happens before hard-delete (removal from database)

**Process:**
1. Query for rows where `deleted_at + retention_window <= now()`
2. Log the deletion to the audit trail: `event_type: 'data_purged'`
3. Hard-delete the row from the database (only when dispatched with `apply=APPLY`; the nightly schedule always dry-runs this step)
4. Log success with count of rows deleted

**Who can trigger:** The nightly dry run needs no human action; the actual
hard-delete requires a person with repo access to dispatch the workflow with
`apply=APPLY`  
**Audit trail:** ✅ Logged with timestamp, data type, count deleted

### Method 2: Manual Deletion by an Organization Admin (On Demand)

An organization admin deletes a guardian's account or an athlete's record on the
`/admin/data-deletion` screen, which calls the API `DELETE /api/pilot/admin/data-deletion`.
The screen: choose an athlete or a guardian of your own organization (athletes already deleted
are not offered), enter a reason, press **Review deletion**, then confirm a second time on a
button that names the person. It then shows the API's answer: when the record was marked
deleted, whether a login was closed ("closed and signed out everywhere" or "had no login"),
the coach notes kept or the children withdrawn, and the audit record number, or the API's own
error. The page and its door are for `organization_admin` / `admin` only; the platform owner
is refused by the page and by the API (OD-2026-09-28-005).

**Request body:** `{ "entityType": "athlete" | "guardian", "entityId": "<athlete id or guardian account id>", "reason": "<optional>" }`

**What it does** (`apps/web/src/server/pilot/dataDeletion.ts`), in one transaction:
- Guardian: sets `accounts.deleted_at = now()` and `active_flag = false`, deactivates the
  guardian's organization membership and revokes their live sessions. The database trigger
  then withdraws each linked athlete this guardian was the last guardian of (Method 3), and
  the API cancels any activation code still outstanding for those athletes' logins.
- Athlete: sets `athletes.deleted_at = now()`; if the athlete has an account, sets its
  `deleted_at`, clears `active_flag`, revokes its live sessions and cancels any activation code
  still outstanding for it (a code issued before the deletion would otherwise set a new PIN
  and mark the account active again; sign-in refuses it either way, below). Coach
  observations are retained, not deleted; their count is recorded.
- Writes one `data_deletion_initiated` audit event with actor, target and reason, and returns
  counts of what it marked. It does not return how many sessions it ended. An athlete deletion
  records that number in its audit event (`sessions_revoked`); a guardian deletion records none.
- Refuses a person already deleted (owner decision 2026-09-29, "1A"): HTTP 409, "This athlete
  was already deleted on <date>. Nothing was changed." (or "This guardian ..."), with no second
  `deleted_at` and no second audit row. Before this, a repeat reset `deleted_at` to now and so
  restarted the person's retention clock. The existence check locks the row (`for update`) so
  that two deletions racing each other should end with one deletion and one 409; no test runs
  two at once.

**NOT BUILT:** a preview of what will be deleted, and cascade-marking of photos, videos or
training notes (the API marks none of them; that is B, the next change). The screen's two
confirmations are the confirmation step; the API itself does not ask for one.

**Sign-in refuses a deleted login** (owner decision 2026-09-29, OD-2026-09-29-003 Q9, "all
recommended": one central rule). Every sign-in refuses an account whose `deleted_at` is set,
whatever its `active_flag` says: PIN sign-in, Microsoft sign-in, asking for and redeeming a
sign-in link, and every signed-in request (`resolvePrincipal`), so a session minted by any path
resolves to nobody. The rule is one file, `apps/web/src/server/pilot/deletedAccountSignIn.ts`.
A refused PIN sign-in logs `deleted_account` and costs the same one PIN check as a wrong PIN; a
refused sign-in link shows the existing "That account is not active. Contact the gym." The deploy
gates' session minter (`apps/web/scripts/lib/gate-session.mjs`) and fixture step
(`apps/web/scripts/pilot-provision-gate-fixtures.mjs`) refuse a deleted fixture by name. The
deletion preflight check (`apps/web/scripts/pilot-check-deletion-preflight.mjs`) reports a deleted
login left active, and its sessions, as refused at sign-in rather than as exposure.

**Still open (checked 2026-09-29):** the admin paths that used to turn a deleted login back on
still write to it without reading `deleted_at`: issuing a new activation code, resetting an
athlete's PIN or creating an account for a deleted athlete
(`apps/web/src/server/pilot/activation.ts`); intake re-promoting a withdrawn athlete
(`createOrUpdateAthleteAccount`, `apps/web/src/server/pilot/auth.ts`); re-inviting a deleted
guardian's email as staff (`createOrUpdateMicrosoftStaffAccount` in
`apps/web/src/server/pilot/staffProvisioning.ts`, which reads `deleted_at` only for intake's
guardian login); and the platform owner's user-status and membership routes
(`setAccountActiveStatus`, `upsertOrganizationMembership` in `apps/web/src/server/pilot/auth.ts`).
They can no longer reopen the login, but they can leave an account marked active, with a PIN or
a code, that can never sign in, and nothing tells the admin why. Nothing in the app clears
`deleted_at`, so a deletion cannot be undone from any screen (the 1-year restore is not built),
and a person marked deleted cannot be deleted again from the screen (409).

**Who can trigger:** `organization_admin` or `admin`, in their own organization only  
**Audit trail:** ✅ `data_deletion_initiated`, with actor, target and reason  
**Timing:** Marked deleted immediately; hard-deleted after its window by a Method 1 run dispatched with `apply=APPLY`

### Method 3: Automatic Cascade on Parent Deletion

When a guardian is deleted, their linked athlete records are automatically soft-deleted
**where that guardian was the last one holding them**. A child who still has another
guardian in the organization is not withdrawn by a different adult's account deletion --
withdrawing that child stays a separate, explicit action (see *Athlete Withdraws* below).

"Another guardian" is counted by account, so a single adult holding two guardian records
for the same child is still that child's only guardian, and a co-guardian whose own account
has already been deleted does not count as remaining. A guardian recorded without a login
does count -- such a record cannot be deleted, so the child is retained rather than
withdrawn, which is the recoverable direction.

A cascade-withdrawn athlete also loses their own login, in the same transaction: the
athlete's account is deactivated and marked deleted, and every live session token for it is
revoked. This matches what explicit athlete withdrawal does, and for the same reason --
`assertActorCanAccessAthlete` checks an athlete's self-access by comparing ids on the
principal and never reads the athlete row, so marking the row alone would leave a withdrawn
minor signed in to their own record for the whole retention window. An athlete the cascade
deliberately leaves enrolled -- one with a remaining guardian -- keeps their login untouched.

**Cascade:**
```
Parent account deleted
  → Linked athlete records with no remaining guardian marked deleted
    → That athlete's own account deactivated and marked deleted
    → That athlete's live sessions revoked
    → Photos, videos and training notes: NOT BUILT (nothing marks them)
```

**Audit trail:** ✅ The guardian's `data_deletion_initiated` event records how many athletes
the cascade withdrew (`cascade_deleted_athletes`); the cascade writes no event of its own.

## Data Deletion Workflow

### Guardian Requests Their Own Deletion

1. Parent contacts the organization (email or phone; there is no in-app request for account deletion)
2. Organization admin verifies the request (identity confirmation)
3. Admin opens `/admin/data-deletion`, chooses the guardian, enters the reason and confirms twice
4. System soft-deletes the account, and any linked athlete record left with no other guardian
5. A cleanup run dispatched with `apply=APPLY` hard-deletes the account once it is past the 1-year window (withdrawn athlete rows past 2 years); the nightly run is a dry run

### Athlete Withdraws

1. An organization admin opens `/admin/data-deletion`, chooses the athlete, enters the reason and confirms twice (a coach cannot -- the page and the server admit only `organization_admin` and `admin`)
2. System sets `athletes.deleted_at = now()` and closes the athlete's own login, if there is one
3. Photos, videos and notes are NOT cascade-marked (NOT BUILT; B, the next change); coach observations are retained
4. Audit logged: `data_deletion_initiated`, with the admin as actor
5. A cleanup run dispatched with `apply=APPLY` hard-deletes the athlete row once it is past the 2-year window; the nightly run is a dry run

### Age of Majority (18th Birthday)

System has no automatic trigger for age-of-majority. The organization must manually delete when they become aware:
1. Find the athlete in the `/admin/data-deletion` picker, listed by name and id (a date-of-birth search is NOT BUILT)
2. Same workflow as "Athlete Withdraws" above

**Note:** Future version could automate this via DOB comparison.

## Technical Implementation

### Database Schema

Deletion tracking (`deleted_at`) exists on `pilot.athletes` and `pilot.accounts`, added by
`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql`, and on
`pilot.shadow_chat_sessions` (SHADOW history, a separate path). The other tables holding
minors' data have none. The pattern, as an example:

```sql
-- Example: athletes table
ALTER TABLE pilot.athletes ADD COLUMN deleted_at TIMESTAMPTZ NULL;

-- Soft-delete index: speed up "show me active athletes"
CREATE INDEX idx_athletes_active ON pilot.athletes(organization_id, athlete_id) 
  WHERE deleted_at IS NULL;

-- Hard-delete query: find rows past their retention window
SELECT * FROM pilot.athletes 
  WHERE deleted_at IS NOT NULL 
    AND deleted_at < (now() - interval '2 years');
```

### Audit Trail

Every API deletion writes one `data_deletion_initiated` row to `pilot.audit_events` (an athlete
deletion shown; a guardian deletion uses `entity_type: "parent_account"` and records
`cascade_deleted_athletes`). The cleanup job writes one `data_purged` row per applied run.

```json
{
  "event_type": "data_deletion_initiated",
  "actor_account_id": "admin-123",
  "actor_role": "organization_admin",
  "organization_id": "org-1",
  "entity_type": "athlete",
  "entity_id": "ath-456",
  "details": {
    "reason": "Athlete withdrew",
    "observations_retained": 8,
    "account_deactivated": true,
    "sessions_revoked": 1,
    "deleted_at": "2026-09-28T12:00:00.000Z"
  }
}
```

### Deletion Safety Checks

1. **Organization scoping:** A deletion request only affects records in that organization
2. **Admin-only:** Only users with `role = 'organization_admin'` or `role = 'admin'` can initiate deletions
3. **Confirmation required:** on the screen only -- a review step, then a second confirmation on a button that names the person, before it calls the API. The API itself takes no confirmation.
4. **No repeat deletion:** a person already deleted is refused with 409 and nothing changes, so a second click cannot restart the retention clock
5. **Audit logged:** the audit event is written in the same transaction as the soft delete, so neither commits without the other
6. **Reversible for 1 year:** NOT BUILT -- no restore path exists

## Compliance Verification

The organization can verify compliance by:

1. **Running the audit:** NOT BUILT -- there is no "Data deletion status" report. A server
   function, `getDeletionStatus` (`apps/web/src/server/pilot/dataDeletion.ts`), computes
   soft-deleted counts and recent deletions, but no route or screen calls it.

2. **Querying the audit log:**
   ```sql
   SELECT * FROM pilot.audit_events 
     WHERE event_type IN ('data_deletion_initiated', 'data_purged') 
     AND created_at > now() - interval '1 year'
     ORDER BY created_at DESC;
   ```

3. **Cleanup verification:**
   ```sql
   -- Should return 0 rows if cleanup is working
   SELECT COUNT(*) FROM pilot.athletes 
     WHERE deleted_at IS NOT NULL 
     AND deleted_at < (now() - interval '2 years');
   ```

## Policy Changes

Changes to retention windows require:
1. Written approval by the Platform Owner (the policy owner for changes, above) and legal counsel
2. Notification to all parents/guardians (email or in-app)
3. 30-day transition period (new policy applies to new data; old policy applies to existing data for 30 days)
4. Audit log entry documenting the policy change

---

**Questions?** Contact your organization's privacy officer or the PPBF platform support team.
