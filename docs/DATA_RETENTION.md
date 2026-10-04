# PPBF Data Retention and Deletion Policy

**Effective date:** 2026-08-06  
**Last updated:** 2026-09-29  
**Policy owner:** Organization Admin (enforcement), Platform Owner (policy changes)

**What is built (checked 2026-09-29; OD-2026-09-28-008; Jason 2026-09-29, "10 C" and "1A").**
Deletion is an organization-admin API, `DELETE /api/pilot/admin/data-deletion`
(`apps/web/app/api/pilot/admin/data-deletion/route.ts`), the `/admin/data-deletion` screen
over it (`apps/web/app/admin/data-deletion/page.tsx`, door "Data Deletion" in the office),
and the cleanup job in Method 1. Scope A: the person's record is marked deleted, their login
closes and anyone signed in as them is signed out. Scope B: everything tied to the athlete is
marked deleted at the same moment -- see *What deletion marks* below for exactly what, what it
leaves, and why. Still **NOT BUILT**: a preview of what will be deleted, a 1-year restore, and
a compliance report. Stored video and photo files are **not erased** by deletion or by the
cleanup job; whether the storage account removes them on its own is **UNVERIFIED**.

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
| Injury records (`pilot.athlete_injuries`) | Period not yet ruled | -- | Not yet ruled |
| Training holds (`pilot.training_holds`) | Period not yet ruled | -- | Not yet ruled |
| Sparring exposure and contact stage (`pilot.sparring_exposure`) | Period not yet ruled | -- | Not yet ruled |
| Coach-set contact caps (`pilot.athlete_contact_caps`) | Period not yet ruled | -- | Not yet ruled |
| Mental skills log: self-talk cues, imagery (`pilot.athlete_mental_skill_entries`) | Period not yet ruled | -- | Not yet ruled |
| Video clip tags (`pilot.video_clip_tags`) | Period not yet ruled | -- | Not yet ruled |
| Check-in body mass (`pilot.shadow_formula_observations`, kind `body_weight`, since #1199; no table of its own) | Period not yet ruled | -- | Not yet ruled |

The seven rows above name tables added or extended for athlete data that no window has been
ruled for yet (2026-10-04). They are listed so the gap is visible, not filled; the periods are
the owner's decision.

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
for a guardian the children withdrawn, how many videos, photos, coach notes, session notes and
SHADOW conversations were marked deleted with the athlete, and the audit record number, or the
API's own error. The page and its door are for `organization_admin` / `admin` only; the platform owner
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
  and mark the account active again; sign-in refuses it either way, below).
- Both: marks everything tied to each athlete it deletes (the athlete chosen, or the children
  the guardian trigger withdrew) deleted at the same moment -- *What deletion marks*, below.
- Writes one `data_deletion_initiated` audit event with actor, target and reason, and returns
  counts of what it marked. It does not return how many sessions it ended. An athlete deletion
  records that number in its audit event (`sessions_revoked`); a guardian deletion records none.
- Refuses a person already deleted (owner decision 2026-09-29, "1A"): HTTP 409, "This athlete
  was already deleted on <date>. Nothing was changed." (or "This guardian ..."), with no second
  `deleted_at` and no second audit row. Before this, a repeat reset `deleted_at` to now and so
  restarted the person's retention clock. The existence check locks the row (`for update`) so
  that two deletions racing each other should end with one deletion and one 409; no test runs
  two at once.

**NOT BUILT:** a preview of what will be deleted. The screen's two confirmations are the
confirmation step; the API itself does not ask for one.

### What deletion marks (scope B; Jason 2026-09-29, "10 C")

**The mark is the athlete row's own `deleted_at`.** It is written in the deletion transaction
(by `deleteAthleteRecord`, or by the guardian trigger for a withdrawn child), and every screen
that reads a row tied to an athlete checks it (`apps/web/src/server/pilot/deletedAthletes.ts`),
so all of those rows leave every screen at the moment the deletion commits. No other tied table
gets a copy of the mark: only one has a deletion column of its own, and giving the rest one
would be a migration on about seventy tables to repeat what the athlete row already says (no
migration was added). The one that has its own column, `pilot.shadow_chat_sessions.deleted_at`,
is stamped with the deletion's timestamp for the athlete's own SHADOW conversations and for
staff conversations about them. Nothing is erased: every row stays in the database until the
cleanup job (Method 1) removes the athlete row, and the foreign keys that cascade from it take
most of these rows with it.

**Marked deleted -- no screen shows them after the deletion:**
- Videos: the video lists (coach and admin), any read of one video (publishing, clipping,
  analysis, compliance review), the malware/content scan queue (a deleted athlete's footage is
  not downloaded or sent to the vision screen), publications and the research-library shelf,
  Film Study proposals, and calibration clips cut from their footage.
- Photos: the portrait review queue. (Every other portrait read already refused a deleted
  athlete.)
- Coach notes and session notes: every coach-note reader already refused a deleted athlete; the
  session notes behind the public wall board, the board summary and the admin performance,
  readiness, progression and intelligence views now leave them out too.
- Everything else tied to them: the public wall board and Wall of Names, class registrations,
  attendance and coaching requests (the admin's scheduler view, the class roster, the weekly
  trend, and the seat count -- a deleted athlete holds no seat), community-service and floor
  hours, floor plans, the passbook (the book itself, for every reader, and the gap queue),
  program headcounts, competition entries, league rosters, 1% Club nominations and members,
  mentorships with them, coach-coverage grants on them, guardian links in the
  duplicate-guardian check and in a guardian's link to a coach's portrait, the admin PIN
  directory, the roster CSV export, and SHADOW research requirements about them.
- The people console: their login leaves the member list (athlete memberships only: a coach
  who was once that athlete stays listed as the coach), a guardian's link to them leaves the
  guardian-link list, and the link is no longer offered for removal or counted by the
  "only athlete this guardian is linked to" refusal. The SHADOW library curator queue leaves
  out documents filed against them. Pinned by
  `apps/web/src/server/pilot/deletedAthleteStaffReaders.pg.test.ts`.
- Records added 2026-10-04, by their own readers: injury records (`athleteInjuries.ts`) and
  sparring exposure entries (`sparringExposure.ts`) filter through `athleteNotDeletedSql`;
  check-in body mass (`athleteBodyMass.ts` `bodyMassVisibleTo`) requires a live athlete row.
  Contact caps (`athleteContactCaps.ts`) and the mental skills log (`athleteMentalSkills.ts`)
  have no deletion filter of their own; every read goes through `assertActorCanAccessAthlete`
  or `accessibleAthleteIds` in `access.ts`, which refuse a deleted athlete for every role that
  reads them (the athlete's own arm calls `assertAthleteBelongsToOrganization`, which requires
  `deleted_at is null`). Video clip tags: the tagged-clip review list (`videoClipTags.ts`
  `listTaggedClips`) hides a clip once any tag on it names a deleted athlete; the other tag
  readers (`listLiveTagSubjects`, `listLiveClipTagsForVideo`) do not filter, by design (the
  first returns `athlete_deleted` so callers can decide). No test pins these readers to
  deletion yet.

**Safety screens: hidden once resolved** (owner decision 2026-09-30, OD-2026-09-30-004, "#1027
Q1", option B). On the organization admin's safety screens a deleted athlete's item stays until
somebody deals with it, then leaves. Deleting a child does not deal with a red flag about them.
(Coaches already did not see a deleted athlete's items.) What "dealt with" means is each screen's
own state:

| Screen | Still shown for a deleted athlete | Hidden once |
|---|---|---|
| Safety escalations | open, acknowledged | resolved |
| Training holds | active | lifted or expired |
| Compliance violations (compliance center) | new, acknowledged, escalated | resolved or dismissed |
| Feedback queue (carries safeguarding disclosures) | new, triaged, planned | done or declined |
| Safety flags | open | any other status (the screen has only ever listed open flags) |
| Safety review page (holds, escalations, violations) | active holds, unresolved escalations, open violations | the same states as above |
| Safety review page, failing safety gates | nothing | at once, on deletion |
| Board escalation summary (a count, no names) | open escalations | anything not open (it has only ever counted open ones) |

Failing gates are the one exception to "until resolved" (owner decision 2026-09-30): a gate
clears only when a newer check passes, and no screen can record a check for a deleted athlete,
so it would otherwise sit on the page, with nothing anyone could do about it, until the cleanup
job. A failing gate is a standing "may this athlete do X", not an incident about them.

The first four readers changed (`escalationLadder.ts` `listEscalations`, `trainingHolds.ts`
`listTrainingHolds`, `compliance.ts` `getOrganizationViolations`, `feedback.ts`
`listOrganizationFeedback`), and `safetyReview.ts` for the failing gates. Safety flags, the rest
of the safety review page and the board summary already behaved this way and are pinned by the
same test, `apps/web/src/server/pilot/deletedAthleteSafetyScreens.pg.test.ts`. The feedback queue
decides "the writer is deleted" from what each submission recorded when it was written, the gym
and the role (athlete, guardian, staff), not from how the login reads today:
- written as an athlete: the athlete record decides. A live athlete whose login alone was
  deleted keeps everything they wrote.
- written as a guardian or staff member: the login decides, so a deleted guardian's or staff
  member's submissions also leave once they are done or declined, and stay gone after the
  cleanup job removes the login.
- if the login no longer matches the submission (it was given another role, or moved to another
  gym), nothing proves the writer is gone, and the submission stays.
- after the cleanup job removes a deleted athlete, the roster can give the same athlete id to a
  new child. When the cleanup job removes an athlete record it also unlinks that athlete's login
  from the id. Which login that is, is settled before the record is removed, so a login moved
  into the gym in the meantime is never taken for it. The login is kept and names nobody; if it
  was somehow still live it is marked deleted at that moment and signed out (its sessions are
  ended and any unused activation code is cancelled), so intake cannot give it to another child
  (a login that has since become a coach's or guardian's is unlinked and left as it is). The new child therefore has no
  connection to the old login: the deleted athlete's closed submissions stay hidden, their open
  ones show with no athlete name, and the new child can be given a login of their own. No date
  is compared.
  The one case this does not cover is an athlete record removed by the cleanup job BEFORE the
  unlinking existed, whose id has since been given to a new child: that old login would still
  carry the id. None existed when the unlinking shipped: the cleanup job had never run.
  **OBSERVED** by the read-only `membership-orphans` check, which counts the audit rows the
  cleanup job writes (`data_purged`, `retention_cleanup`): "retention purge history: 0 run(s),
  0 account(s) ever purged" on staging (run 36936795333, 2026-10-01T22:44Z) and on production
  (run 36936798184, 2026-10-02T01:20Z). The deletion preflight's "Retention purge events" line counts every
  `data_purged` row, including the membership-orphan cleanup's, and so is not this number (it
  read 1 in production, run 36922416115). The owner's statement, 2026-10-01: "the app has
  never been live".

The platform owner's cross-gym feedback list, which
names nobody and withholds safeguarding text, is unchanged. The video-compliance publication
queue is not in this table: it drops a deleted athlete's publications at once (videos, above).

**Left as they are, and why:**
- Counts that name nobody (model-validation rates, SHADOW usage metrics, board competition and
  league result totals, the public floor-hours totals): history that happened, with no athlete
  shown.
- Rows owned by another, live athlete that mention the deleted one (a sparring or grappling
  partner, a multi-athlete capture): they belong to the other athlete. Teaching footage names no
  athlete on the video row at all, so nothing links it to a deletion.
- Write paths (an admin acting on a deleted athlete's row by id, such as releasing or archiving
  a video, lifting a hold, or answering a registration): unchanged; the lists no longer offer
  those rows.
- Code with no caller in the app (for example the calibration gold-record reads, the attendance
  totals in `attendancePrecedence.ts`, `listDueAssessments`).
- Rabbit-hole lesson citations (`rabbitHoles.ts` `CITATION_JOIN`): nothing to hide. A lesson
  can cite only a gym-wide document (`d.subject_id is null`, `libraryServability.ts`), never
  one filed against an athlete.
- The intake review queue (`intake.ts`): `pilot.intake_cases.primary_athlete_id` is never
  written, so a case names no athlete to filter on. Its own build-list item.

**Stored files.** Deletion erases no stored file, and neither does the cleanup job: the app's
only stored-file deletes are a portrait its owner removes or a reviewer rejects, gym-wall
photos and credential files (`apps/web/src/server/pilot/blob.ts:204, 281, 356`). The cleanup job
also leaves the video rows (`pilot.video_sessions.athlete_id` has no foreign key to athletes)
and the athlete's own account and portrait row (it removes parent accounts only); the
athlete's account is kept but no longer names the athlete record that was removed, and is
marked deleted if it was not already (*Safety screens*, above). A playback
link handed out before the deletion keeps working until it expires (60 minutes). No storage
lifecycle rule is defined in `infra/`; whether the live storage account has one is
**UNVERIFIED**.

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

**Admin actions on a deleted login are refused** (owner decision 2026-09-30, OD-2026-09-30-004
e2, A). Each of these used to succeed on a login marked deleted and leave it shown as active, with
a PIN or a code, while sign-in refused it and nothing said why. Each is now refused with a 409 and
the login is left as deletion left it. An action on the deleted login itself answers one message
(`deletedLoginConflict`, `apps/web/src/server/pilot/deletedAccountSignIn.ts`: the login was
deleted, nothing here changes it, and a returning person needs a new login -- a new `account_id`,
or for a staff or guardian login a different email address, because the deleted row keeps its
email and the email is unique). The rule is a condition of the write statement itself, not only
a check before it. A new activation code, a PIN reset, a redemption and a deletion all take the account
row's lock before they lock or write its codes (a redemption first reads the code once, unlocked,
to learn whose it is), so one that races another waits for it: a code issued
while a deletion is in progress is either refused or superseded by that deletion, never left
live:

- a new activation code, and a PIN reset (`issueActivationCode`, `provisionAthleteActivation`,
  `apps/web/src/server/pilot/activation.ts`);
- creating a login for an athlete record a deleted login still holds (the same function, mode
  `create`): refused with its own message, which does not name the old login. Whether the athlete
  record itself was withdrawn is not checked: a withdrawn record whose login was deleted with it is
  refused for that reason, and one that never had a login can still be given one, as before;
- redeeming an activation code that belongs to a deleted login (`redeemActivationCode`): it writes
  nothing and answers the same generic failure as any other unusable code;
- re-inviting a deleted login's email as staff or guardian, from the gym's People page or the
  platform owner's (`createOrUpdateMicrosoftStaffAccount`,
  `apps/web/src/server/pilot/staffProvisioning.ts`);
- the platform owner's user-status route, in both directions, and membership route
  (`setAccountActiveStatus`, `upsertOrganizationMembership`, `apps/web/src/server/pilot/auth.ts`);
- assigning or transferring the gym's admin seat to or from a deleted login, and granting or
  revoking master SHADOW access on one (`promoteAccountToOrganizationAdmin`,
  `transferOrganizationAdmin`, `setAccountMasterShadowAccess`).
- the platform owner's athlete-shell route (`createAthleteAccount`, `auth.ts`): naming a deleted
  login as the new `account_id`, in any organization, or an athlete record a deleted login still
  holds (the second with the same message as mode `create` above). It only ever inserted, so it
  never wrote to a deleted login; it answered "already exists" or "already linked" without saying
  why;
- the stranded-guardian repair (`repairStrandedGuardianAuthProvider`), which made a deleted login
  matchable by Microsoft sign-in again;
- the platform-owner bootstrap (`createOrUpdateMicrosoftPlatformOwnerAccount`), whose upsert set a
  deleted login active again and reported success. Its lookup is not scoped: the route is
  platform-level.

Intake re-promoting a withdrawn athlete, or naming a deleted login, is refused the same way
(#1047). A gym's admin is told a login is deleted only when it is in their own gym: every lookup
that names the reason is scoped to the caller's organization, and a login that belongs to another
gym, or moves to one while an invite is being written, gets only "account already exists in
another organization". The platform owner's routes are cross-organization by role and are not
scoped. Linking a guardian to a withdrawn athlete's record is not refused; that is unchanged.

**Still open (checked 2026-10-03):** the organization admin's user-create route
(`platform/users/create`, `createAthleteAccountPendingActivation` in `auth.ts`) now names a
deleted login in the admin's own organization (409 `DELETED_LOGIN`). It does not check the
athlete record it names: one already held by a login, deleted or not, is left to the
one-login-per-athlete-record unique constraint (`ATHLETE_LOGIN_UNIQUE_CONSTRAINTS` in `auth.ts`),
which by code reading answers 500 rather than a reason. The four
local-PIN functions with no deleted check and no caller in the app (`resetAccountPin`,
`activateAccountPin`, `createCoachAccount`, `createParentAccount`), and `createOrRotateAdminAccount`
with them, were deleted. Revoking a deleted login's sessions is still allowed. A returning staff member or guardian cannot
be given a login at the email their deleted login holds until that row is purged or the email is
freed by a database fix. Nothing in the app clears
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
    → Everything tied to that athlete marked deleted with them (What deletion marks)
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
3. Everything tied to the athlete is marked deleted at the same moment (What deletion marks); coach notes stay in the database, off every screen
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
`pilot.shadow_chat_sessions` (SHADOW history). The other tables holding minors' data have none;
a row tied to an athlete is deleted when its athlete is, and its readers check the athlete row
(`apps/web/src/server/pilot/deletedAthletes.ts`). The pattern, as an example:

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
    "tied_records_marked": {
      "videos": 3,
      "photos": 1,
      "coach_notes": 8,
      "session_notes": 40,
      "shadow_conversations": 2
    },
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
