# PPBF Data Retention and Deletion Policy

**Effective date:** 2026-08-06  
**Last updated:** 2026-08-06  
**Policy owner:** Organization Admin (enforcement), Platform Owner (policy changes)

## Overview

This policy defines how long PPBF retains data about minors and their families, why retention is necessary, and how data is deleted when it reaches the end of its useful life.

**Principle:** Data minimization. PPBF collects and retains minors' personal data only for legitimate operational and legal purposes. Once that purpose is fulfilled or the relationship ends, data is deleted.

**Compliance scope:**
- FERPA (US Family Educational Rights and Privacy Act)
- COPPA (US Children's Online Privacy Protection Act)
- GDPR (EU General Data Protection Regulation, if applicable)
- State-level education and youth-serving organization privacy laws

## Data Categories and Retention Windows

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
script `npm run pilot:cleanup-deleted-data` (`scripts/pilot-cleanup-deleted-data.mjs`)
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
2. Log the deletion to the audit trail: `event_type: 'DATA_PURGED'`
3. Hard-delete the row from the database (only when dispatched with `apply=APPLY`; the nightly schedule always dry-runs this step)
4. Log success with count of rows deleted

**Who can trigger:** The nightly dry run needs no human action; the actual
hard-delete requires a person with repo access to dispatch the workflow with
`apply=APPLY`  
**Audit trail:** ✅ Logged with timestamp, data type, count deleted

### Method 2: Manual Deletion by Admin (On Demand)

An organization admin can request immediate deletion of a guardian's account or an athlete's record via the admin console.

**Process:**
1. Admin navigates to `/admin/data-deletion`
2. Admin selects "Delete guardian account" or "Delete athlete record"
3. Admin enters the account ID or athlete ID
4. System displays what will be deleted (summary of linked records)
5. Admin confirms with reason (optional notes field)
6. System marks the account/athlete as deleted:
   - Sets `accounts.deleted_at = now()` for guardian account
   - Sets `athletes.deleted_at = now()` for athlete record
7. Cascade-delete all linked photos, videos, training notes
8. Log to audit trail: `event_type: 'DATA_DELETION_INITIATED'` with actor, target, reason
9. Display confirmation to admin: "Deletion complete. 14 records marked for purging."

**Who can trigger:** Organization Admin only  
**Audit trail:** ✅ Logged with actor, deletion reason, what was deleted  
**Timing:** Marked for deletion immediately, hard-deleted by background process after retention window

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

**Cascade:**
```
Parent account deleted
  → Linked athlete records with no remaining guardian marked deleted
    → All athlete photos marked deleted
    → All athlete videos marked deleted
    → All training notes marked deleted
```

**Audit trail:** ✅ Parent deletion logged; cascade logged separately

## Data Deletion Workflow

### Guardian Requests Their Own Deletion

1. Parent contacts the organization (email, phone, or in-app request)
2. Organization admin verifies the request (identity confirmation)
3. Admin uses the deletion console to initiate: "Delete parent account ID: parent-123"
4. System soft-deletes the account, and any linked athlete record left with no other guardian
5. Background process hard-deletes after 1-year retention window

### Athlete Withdraws

1. Coach or admin initiates athlete withdrawal via athlete record UI
2. System sets `athletes.deleted_at = now()`
3. All athlete-linked data (photos, videos, notes) is cascade-marked for deletion
4. Audit logged: "Athlete ath-456 withdrawn by coach-123"
5. Background process hard-deletes after 2-year retention window

### Age of Majority (18th Birthday)

System has no automatic trigger for age-of-majority. The organization must manually delete when they become aware:
1. Admin opens `/admin/data-deletion`
2. Admin manually searches for athlete by name/DOB
3. Admin confirms: "This athlete is now 18, delete their account"
4. Same workflow as "Athlete Withdraws" above

**Note:** Future version could automate this via DOB comparison.

## Technical Implementation

### Database Schema

Every table that holds minor data has deletion tracking:

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

Every deletion writes to `pilot.audit_events`:

```json
{
  "event_type": "DATA_DELETION_INITIATED",
  "actor_account_id": "admin-123",
  "actor_role": "organization_admin",
  "organization_id": "org-1",
  "entity_type": "athlete",
  "entity_id": "ath-456",
  "details": {
    "reason": "Athlete withdrew",
    "deleted_records": {
      "athletes": 1,
      "athlete_photos": 3,
      "athlete_videos": 2,
      "coach_observations": 8
    }
  }
}
```

### Deletion Safety Checks

1. **Organization scoping:** A deletion request only affects records in that organization
2. **Admin-only:** Only users with `role = 'organization_admin'` or `role = 'admin'` can initiate deletions
3. **Confirmation required:** Admin must explicitly click "Delete" twice (standard confirm flow)
4. **Audit logged:** Every deletion is logged before it happens
5. **Reversible for 1 year:** If a deletion was a mistake, the organization can request restoration within 1 year (admin privilege, not self-serve)

## Compliance Verification

The organization can verify compliance by:

1. **Running the audit:** Admin console reports "Data deletion status"
   - Show count of soft-deleted records pending hard-delete
   - Show count of hard-deleted records (past 1 year)
   - Show timeline of last 10 deletions

2. **Querying the audit log:**
   ```sql
   SELECT * FROM pilot.audit_events 
     WHERE event_type LIKE 'DATA_DELETION%' 
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
1. Written approval by organization owner and legal counsel
2. Notification to all parents/guardians (email or in-app)
3. 30-day transition period (new policy applies to new data; old policy applies to existing data for 30 days)
4. Audit log entry documenting the policy change

---

**Questions?** Contact your organization's privacy officer or the PPBF platform support team.
