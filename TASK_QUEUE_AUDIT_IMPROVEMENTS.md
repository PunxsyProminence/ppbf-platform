# Task Queue: Security Audit & Capability #2 Improvements
**Created:** August 3, 2026  
**Status:** Ready for Implementation  
**Source:** Security Audit + Deep Improvement Audit (Capability #2)

---

## 🔴 P0 Security Fixes — CRITICAL (All Implemented ✅)

These were identified in the security audit and have been implemented. Verify on production deployment.

- [x] **SEC-001: Session Cookie Secure Flag Fix**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `http.ts`, `login/route.ts`, `logout/route.ts`, `activate/route.ts`
  - Status: Implemented
  - Tests: Verify secure flag detects HTTPS properly
  - Deploy: Test in staging with `x-forwarded-proto: https`

- [x] **SEC-002: Account Enumeration Timing Attack**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `auth.ts` - `loginWithAccountIdAndPin`
  - Status: Implemented with constant-time PIN verification
  - Tests: Measure response time for non-existent vs. existing accounts

- [x] **SEC-003: Rate Limiting Configuration Enforcement**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `rateLimit.ts` - `validateDurableRateLimitConfiguration()`
  - Status: Implemented with production startup check
  - Deploy: Ensure `PPBF_DURABLE_RATE_LIMIT=true` in production

- [x] **SEC-004: Bootstrap Key Timing Side-Channel**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `security.ts` - `bootstrapKeyMatches()`
  - Status: Implemented with constant-length dummy keys

- [x] **SEC-005: PostgreSQL SSL Configuration**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `db.ts` - `validateSslConfiguration()`
  - Status: Implemented with production startup check

- [x] **SEC-006: Organization Isolation Audit Framework**
  - Branch: `claude/ppbf-platform-audit-w3va0j` (commit 9f8bb11)
  - Files: `organizationIsolation.test.ts` (NEW)
  - Status: Framework created with comprehensive checklist

---

## 🟠 P0 Capability #2 Issues — HIGH PRIORITY (Do Soon)

These are correctness/safety issues for the Participant Master Record capability.

### CAP2-P0-001: Constrain gym_status to Enum
**Priority:** HIGH (security/consistency)  
**Effort:** 2-4 hours  
**Risk:** Medium - prevents invalid states
**Status:** ✅ COMPLETED (commit c5bddc6)

- [x] Create `apps/web/src/shared/athleteConstants.ts`
  - Exports: `GYM_STATUS_OPTIONS = ['active', 'training', 'inactive']` with GymStatus type
- [x] Update `src/server/pilot/validation.ts`
  - Added import and `requireGymStatus()` helper function
  - Validates against enum; rejects unknown values with 400
  - Error message: `"Request body field gym_status must be one of: active, training, inactive"`
- [x] Update client forms (People, Athlete Records)
  - Removed duplicate GYM_STATUS_OPTIONS from both pages
  - Updated to use GYM_STATUS_DISPLAY_OPTIONS for labels
  - Shared constant used for validation consistency
- [x] Add test case for unknown gym_status → 400
  - Test added to validation.test.ts
- [x] Verify existing tests pass
  - All 2707 tests pass
- [x] Update PilotAthlete type to use GymStatus

**Acceptance:** ✅ Server rejects `gym_status: "unknown"` with 400; UI picker reflects enum

---

### CAP2-P0-002: Clarify Coach Create Rights
**Priority:** HIGH (correctness)  
**Effort:** 1-2 hours  
**Risk:** Low - only affects auth boundary
**Status:** ✅ COMPLETED (commit f9c573f) - Option A: Restrict to org-admin only

**Implementation:**
- [x] Changed `apps/web/app/api/pilot/athletes/route.ts` line 14
  - From: `requireRole(principal, ['organization_admin', 'coach'])`
  - To: `requireRole(principal, ['organization_admin'])`
  - Added clarifying comment: roster creation is admin responsibility
- [x] Updated tests: coach now correctly rejected with 403 Forbidden
  - Test `rejects a coach attempting to create an athlete` verifies restriction
  - Org-admin path still works: `creates a roster row for an athlete_id that is not yet taken`
- [x] Added UI note in People tab: "Only organization admins can add athletes to the roster"
- [x] Updated DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md with decision

**Decision Rationale:** Roster creation is fundamentally an admin responsibility. Coaches manage assignments within the existing roster but don't control who gets added to the system. This prevents scope creep and maintains clear authorization boundaries.

**Acceptance:** ✅ Decision documented; tests verify only org-admin can create

---

### CAP2-P0-003: Validate Coach Exists Before Insert
**Priority:** HIGH (prevents orphaned records)  
**Effort:** 2-3 hours  
**Risk:** Low - catches edge case
**Status:** ✅ COMPLETED (commit 25a4ea0)

- [x] Add helper in `src/server/pilot/entities.ts`: `getCoachById(organizationId, accountId)`
  - Returns boolean: checks if coach is active in organization
  - Query: validates role='coach' and active_flag=true
- [x] Update `POST /api/pilot/athletes` before `insertAthleteIfAbsent()`
  - Calls `getCoachById()` to verify coach exists
  - Throws: `'Not found: coach not found in this organization'`
- [x] Add tests: coach exists → 200 success; coach missing → 404
  - Test: `rejects creation with a non-existent coach` → 404
  - Test: `allows creation when coach exists` → 200
- [x] Error handling: existing 'Not found' prefix already maps to 404 in http.ts
  - No changes needed - error message already caught by line 123

**Acceptance:** ✅ POST /api/pilot/athletes with non-existent coach_id returns 404 "coach not found"

---

### CAP2-P0-004: Confirm Athlete Self-Update Scope
**Priority:** HIGH (clarifies permissions)  
**Effort:** 3-4 hours  
**Risk:** Medium - affects athlete UX
**Status:** ✅ COMPLETED (commit b16af3a) - Athletes can ONLY update emergency_contact

**Decision & Rationale:**
- [x] Athletes ALLOWED: `emergency_contact` (personal information they control)
- [x] Athletes RESTRICTED: `full_name`, `dob`, `weight_class` (identity and classification fields)
- [x] Athletes RESTRICTED: `coach_id`, `active_flag`, `gym_status` (system/status fields - already restricted)

**Implementation:**
- [x] Updated `assertAthleteUpdateAllowed()` in access.ts with field-level checks
  - Added explicit restrictions for: full_name, dob, weight_class
  - Documented allowed field: emergency_contact (see trailing comment)
- [x] Added 4 integration tests: athlete field restriction tests
  - Test full_name change → 403 Forbidden
  - Test dob change → 403 Forbidden
  - Test weight_class change → 403 Forbidden
  - Test emergency_contact change → 200 OK (allowed)
- [x] Route already supports athlete role for updates (line 43)

**Acceptance:** ✅ `assertAthleteUpdateAllowed()` documents scope; all athlete-scoped fields tested; 4 tests added

---

## 🟡 P1 Improvements — MEDIUM PRIORITY (High Value)

These reduce operational friction and improve UX.

### CAP2-P1-001: Extract Shared gym_status Constant
**Priority:** MEDIUM (consistency)  
**Effort:** 1 hour  
**Depends on:** CAP2-P0-001  
**Status:** ✅ COMPLETED (commit ed69310)

- [x] `apps/web/src/shared/athleteConstants.ts` now holds both the allow-list
  (`GYM_STATUS_OPTIONS`) and the operator-facing labels (`GYM_STATUS_CHOICES`),
  plus an `isGymStatus()` guard used by the server validator
- [x] `app/admin/people/page.tsx` and `app/admin/athletes/page.tsx` both import
  `GYM_STATUS_CHOICES`; their local copies are deleted
- [x] Verified no duplicate lists remain (`grep` for the vocabulary returns only
  the shared module, the two importers, seeds and tests)

**Also fixed — a second write path the tightened type exposed:**
`POST /api/pilot/intake/review-action` wrote `promotion.athlete.gym_status`
straight through `upsertAthlete` with no allow-list check, so an approved intake
case was a way to store a value the roster form cannot offer and the coach
workspace displays verbatim. Now validated at that boundary, with
`IntakePromotionPayload.athlete.gym_status` typed as `GymStatus` and a test
asserting an out-of-vocabulary promotion is refused with 400.

**Acceptance:** ✅ Single source of truth; both UI surfaces import it; both write
paths (roster create and intake promotion) enforce it

---

### CAP2-P1-002: Empty Coach State UX
**Priority:** MEDIUM (usability)  
**Effort:** 2-3 hours  
**Status:** ✅ COMPLETED (commit ed69310)

- [x] Added fail-closed banner on the Add Athlete tab when `coachOptions` is empty
  - Copy: "Every athlete record has to name a coach, and your gym does not have
    one yet… nothing you type here can be saved until then."
  - "Add a coach" button switches to the invite tab (no page reload)
- [x] Submit was already blocked: `canSubmitAthlete` requires `athleteCoachId`,
  which cannot be set from an empty picker — verified rather than re-implemented
- [x] Banner is conditional on `coachOptions.length === 0`, so it disappears as
  soon as a coach exists

**Acceptance:** ✅ Add Athlete shows an actionable CTA before the operator fills
in six fields and meets an empty required picker at the bottom

---

### CAP2-P1-003: Cross-Link PIN Console ↔ People Tab
**Priority:** MEDIUM (reduces confusion)  
**Effort:** 1-2 hours  
**Status:** ✅ COMPLETED (commit ed69310)

- [x] **People tab** (pending-athletes panel): "Resetting here always uses the
  shared starting PIN and forces a change at next sign-in. To set a custom
  6-digit PIN instead, use the **PIN console**." — links to `/admin/pin`
- [x] **PIN console** (header): "This sets a custom PIN you choose. To put an
  athlete back on the shared starting PIN and force them to choose their own at
  next sign-in, use **People** instead." — links to `/admin/people`
- [x] Both note the behavioural difference, not just the location: only the
  People path forces a change at next sign-in, which is the distinction an
  operator picking the wrong surface gets wrong

**Acceptance:** ✅ One-sentence cross-link on both surfaces, each naming what the
other one does differently

---

### CAP2-P1-004: Account ID Collision Error Message
**Priority:** MEDIUM (usability)  
**Effort:** 2-3 hours  
**Status:** ✅ COMPLETED (commit ed69310)

- [x] `POST /api/pilot/athletes` now reads the colliding row on conflict and
  returns `Athlete record already exists: ath-014 belongs to Marcus Webb`
  - The read happens only on collision, and only within the caller's own
    organization, so it discloses nothing they could not already list
  - Falls back to the bare id when the row cannot be read
- [x] No `http.ts` change needed — the existing `Athlete record already exists`
  prefix already maps to 409 and passes the message through verbatim
- [x] Test: `names the athlete already holding a colliding athlete_id`
- [x] Client-side pre-check **already existed** (`collidingAthlete`, naming the
  holder inline before submit); the client now also surfaces the server's name so
  the two agree when the roster directory could not be read

**Acceptance:** ✅ 409 names the existing athlete, so a typo landing on a teammate
is distinguishable from a record the admin created themselves

---

### CAP2-P1-005: Coach Picker Pre-Load
**Priority:** MEDIUM (UX improvement)  
**Effort:** 2-3 hours  
**Status:** ✅ NO CHANGE NEEDED — already implemented (verified)

The audit recorded this as "must type coach_id; no picker if form not yet saved",
but the code does not work that way:

- `coachOptions` (people/page.tsx:306) is a `useMemo` over `members`, which is
  loaded on mount by the same fetch that populates the People list — not on submit
- It filters to `role === 'coach' && active_flag && membership_active`, so the
  dropdown is populated with every active coach before the operator types anything
- The field is already a `<select>`, not a text box

No code change made. The genuine gap here was the **empty** case, which is
CAP2-P1-002 (now done). "Unassigned" remains out of scope — `coach_id` is
`not null` with an FK, so it needs a schema migration and a product decision.

**Acceptance:** ✅ Verified populated before create; no work required

---

## 🔵 P2 Polish — LOW PRIORITY (Nice-to-Have)

These improve observability and UX polish.

### CAP2-P2-001: Status Chip on People List
**Priority:** LOW (polish)  
**Effort:** 3-4 hours  
**Status:** ✅ COMPLETED (commit e3dc50d)

- [x] Status is now a bordered pill (`inline-flex … rounded-full border`) instead
  of bare uppercase text, so the column is scannable down a roster
- [x] Tone-driven styling retained: ok / pending / blocked

**Two deliberate departures from the audit's suggestion:**
1. **Labels were not shortened to `Guardian · no children`.** The existing
   wording — "Linked to no athlete — would see nothing" — is carrying a warning,
   and the audit's own §2 lists surfacing stranded guardians as a strength not to
   improve away. A terser chip would have cost the meaning.
2. **`blocked` is muted, not alarm red.** It covers both "Deactivated" (an
   intended admin action) and the stranded-guardian case. Painting every
   deactivated member red would cry wolf; the genuine fault already has its own
   red banner above the list.

**Acceptance:** ✅ Chips render; warning wording preserved

---

### Note on the original audit's premise for P2-1
The audit described the People list status as "multi-line". It was already a
single line — the improvement available was chip *styling*, not restructuring.
Recorded here so the next reader does not go looking for a multi-line layout.

---

### CAP2-P2-002: Last Audit Trail on Athlete Record
**Priority:** LOW (observability)  
**Effort:** 2-3 hours  
**Status:** ✅ COMPLETED (commit e3dc50d)

- [x] Correction panel reads the newest event via the existing
  `POST /api/pilot/audit/get` (`entity_type: 'athlete'`, `entity_id`, `limit: 1`)
  — no new endpoint needed; that route is already org-scoped and admin/coach-gated
- [x] Renders "Last corrected by {actor} on {date} — changed {fields}", plus
  "marked inactive / active again" when `active_flag` moved
- [x] Field names mapped to operator wording (`dob` → "date of birth")
- [x] **Values are never rendered** — audit details for athlete records hold field
  names only, and a test asserts the panel contains neither the stored dob nor the
  emergency contact
- [x] An unreadable trail says so explicitly rather than rendering as "never
  corrected" — a silently empty history on an edited record would be a lie
- [x] Refreshes after a save, so the panel is not one correction behind

**Harness note:** the athletes page test harness had to learn
`/api/pilot/audit/get`. Without it the new fetch hit the harness's
`Unexpected fetch` throw and was swallowed by the loader's `catch`, so the suite
went green while covering nothing.

**Acceptance:** ✅ Panel shows who/when/what, with values withheld and the
unreadable path handled

---

### CAP2-P2-003: DOB Timezone Handling Test
**Priority:** LOW (regression prevention)  
**Effort:** 1 hour  
**Status:** ✅ COMPLETED (commit e3dc50d)

- [x] Added to `apps/web/app/api/pilot/athletes/update/route.test.ts`, exercising
  `comparable()` through the route (the real audit path) rather than in isolation
- [x] A no-op save reports **no** dob change in five zones: `UTC`, `Asia/Tokyo`
  (east), `America/Los_Angeles` (west), `Asia/Kolkata` (half-hour offset) and
  `Pacific/Kiritimati` (+14)
- [x] A genuine correction is still reported as changed east of UTC — so the test
  cannot pass by the helper simply never reporting anything
- [x] `process.env.TZ` restored after each case

**These tests have teeth:** a UTC-based helper (`toISOString().slice(0, 10)`)
fails the Tokyo case, because a Date at Tokyo local midnight is the *previous* day
in UTC. That is exactly the drift that would put a false "dob corrected" entry in
the trail on every save.

**Acceptance:** ✅ Verified across five zones, with a positive control

---

### CAP2-P2-004: Weight Class Options
**Priority:** LOW (future)  
**Effort:** 2 days (requires schema + migration)  
**Status:** ⏸️ NOT STARTED — deliberately left for a product decision

- [ ] Optional: Extract weight classes to org-specific list
- [ ] Example values: "Bantam", "Feather", "Light", "Middleweight", "Cruiserweight", "Heavyweight"
- [ ] Create schema: `pilot.organization_weight_classes` table
- [ ] Add UI: Organization admin can customize weight classes
- [ ] Not required for Capability #2 completion

**Why this one was not implemented with the rest of P2.** Unlike every other item
in this queue it is not a hardening or wording change — it needs a new table, a
migration, a backfill of existing free-text values, and an answer to a question
engineering cannot answer alone: **whose vocabulary wins?** Weight classes are set
by sanctioning bodies and differ by age bracket and ruleset, so the list is a
governance decision, not a constant. Guessing at it would bake one gym's
assumptions into the schema for everyone.

Both source documents also class it as optional and out of scope for Capability
#2 (`DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md` §3 P2-5: "Not required now"). Flagged
rather than silently skipped.

---

## 📊 Summary by Priority

| Priority | Count | Effort | Status |
|----------|-------|--------|--------|
| P0 Security | 6 | — | ✅ Implemented |
| P0 Capability | 4 | 8-13 hrs | ✅ 4/4 Complete |
| P1 Improvements | 5 | 8-12 hrs | ✅ 5/5 Complete |
| P2 Polish | 4 | 6-8 hrs | ✅ 3/4 — P2-004 deferred |
| **Total** | **19** | **22-33 hrs** | **18 done, 1 deferred** |

**The one deferred item** is CAP2-P2-004 (org-specific weight classes). It needs a
schema migration and a governance decision about whose weight-class vocabulary is
authoritative — both source audits already class it as optional and out of scope
for Capability #2. See that section for the reasoning.

**Found while implementing (not in the original audit):** the intake promotion
route was a second, unvalidated write path for `gym_status` — closed under
CAP2-P1-001. Worth noting that the original audit's API surface map only covered
`/api/pilot/athletes*`, so other `upsertAthlete` callers were not reviewed for the
constraints P0 added.

---

## 📋 How to Track Progress

1. **Copy this file** to your project management tool (Jira, GitHub Projects, Linear, etc.)
2. **Update checkbox status** as work progresses
3. **Link to PR** when implementing each task
4. **Reference audit docs** for acceptance criteria:
   - `SECURITY_AUDIT_REPORT_2026-08-03.md` - Security findings
   - `SECURITY_FIXES_APPLIED.md` - Implementation guide
   - `DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md` - Capability #2 details

---

## 🚀 Implementation Order — all phases now complete

- ✅ **Phase 1 (Security Critical):** SEC-001 … SEC-006
- ✅ **Phase 2 (Capability Correctness):** CAP2-P0-001 … CAP2-P0-004
- ✅ **Phase 3 (Operational):** CAP2-P1-001 … CAP2-P1-005
- ✅ **Phase 4 (Polish):** CAP2-P2-001 … CAP2-P2-003 — CAP2-P2-004 deferred

---

## ⚠️ Still needs a human before deploy

- [x] ~~**The startup guards are never called.**~~ ✅ **FIXED.** Wired into
      `apps/web/instrumentation.ts` — the Next.js instrumentation hook, which already
      existed for the SHADOW worker and runs once per server start. The checks sit
      *above* the worker's early return, so they apply in every environment, not only
      where the worker is enabled. On failure the process logs the reason and exits 1
      rather than throwing, so a misconfigured server cannot log a fatal and keep
      serving. Six tests in `instrumentation.test.ts` hold the wiring, and they were
      verified to fail when the call is removed.

      **No new configuration needed:** `PPBF_DURABLE_RATE_LIMIT=true` is already set
      by both deploy workflows, so this asserts existing config. Confirmed before
      wiring, specifically so this would not arm a deploy failure.

**Still outstanding:** SEC-006's organization-isolation checklist is a framework of
structural assertions and `expect(true).toBe(true)` placeholders, not executing
coverage. The checklist still has to be walked by hand — no automated test proves
those boundaries.

One narrower boundary claim *was* since verified by hand: the two platform-owner
routes that the work queue listed as leaking minors' names are correctly gated and
have tests. See `docs/WORK_QUEUE.md` for that evidence.

---

## 🔴 SEC-007: Platform owner could take over any athlete account (found 2026-08-03)

**Severity: HIGH. Present on `main` today; fixed on this branch.**

`POST /api/pilot/platform/athlete-shell` is platform_owner-only and documents itself
as creating an inert shell — "no PIN and active_flag false ... grants no sign-in
capability". It called `createAthleteAccount`, which writes `active_flag = true` with
a usable `pin_hash`. A live account, not a shell.

**The chain, before the per-athlete PIN work landed:**
1. Platform owner calls this route for **any** organization (`organization_id` comes
   from the request body) against any athlete without a login yet.
2. The account is created live on `hash('123456')` — the shared starting PIN, which
   was published in `pinPolicy.ts` and printed in the admin UI.
3. `loginWithAccountIdAndPin` checks only `active_flag` and the PIN. `must_change_pin`
   does not block login.
4. `must_change_pin` deliberately permits the change-PIN route
   (`requirePrincipalAllowingPinChange`), so the caller sets a PIN of their own,
   clearing the flag.
5. They now hold a minor's account, in a gym they do not administer.

This is the exact capability the route's own docblock says platform_owner is
"permanently excluded from" — it carefully refuses to mint an activation code, then
reaches the same outcome another way.

**Why it is not currently exploitable on this branch:** the per-athlete PIN change
made `createAthleteAccount` issue a random PIN and return it, and this route discards
the return value — so the owner never learns it. That was accidental mitigation, not
a fix, and it left the account live with a PIN nobody knows.

**Fix:** call `createAthleteAccountPendingActivation` — what the docblock describes,
and what the sibling route `platform/users/create` already used. Main's commit
9d25947 ("a child-account boundary") fixed that sibling and missed this one.

Also hardened `createAthleteAccountPendingActivation` itself: it did not verify the
athlete roster row existed in the named organization, nor that the athlete was not
already linked to a different account. **Both** platform routes take
`organization_id` from the request body, so neither had that protection —
`createAthleteAccount` had always checked it.

**Tests:** 7, including one asserting `createAthleteAccount` is never reached from
this route. Verified they fail when the fix is reverted (2 of 7).

---

## 🔎 Found while implementing, not in the original audit

**The intake promotion route was a second unvalidated write path.**
`POST /api/pilot/intake/review-action` wrote `promotion.athlete.gym_status`
straight to `upsertAthlete` with no allow-list check, so an approved intake case
could store a value the roster form cannot offer and the coach workspace then
displays verbatim. Closed under CAP2-P1-001, found by the typechecker rather than
by the audit.

**The lesson for future passes:** the original audit's API surface map covered
`/api/pilot/athletes*` only. Any constraint added to a roster route should be
checked against **every** `upsertAthlete` caller, not just the documented one.

---

**Branch:** `claude/ppbf-platform-audit-w3va0j`  
**Last Updated:** 2026-08-03  
**Verification:** 2722 tests passing, `tsc --noEmit` clean  
**Not verified:** anything requiring a live database (`*.pg.test.ts` are excluded
from the default suite), or the startup guards above
