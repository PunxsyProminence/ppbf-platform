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

- [ ] Add helper in `src/server/pilot/entities.ts`: `getCoachById(organizationId, accountId)`
  - Query: `select account_id from pilot.accounts where account_id = $1 and organization_id = $2 and role = 'coach' and active_flag = true`
  - Return: boolean or coach record
- [ ] Update `POST /api/pilot/athletes` (route.ts line 30)
  - Before `insertAthleteIfAbsent()`, check coach exists
  - If not: throw `new Error('Not found: coach not found in this organization')`
- [ ] Add test: coach exists → create succeeds; coach missing → 404
- [ ] Update error message in http.ts to map "coach not found" → 404
- [ ] Add integration test calling create with non-existent coach

**Acceptance:** POST /api/pilot/athletes with non-existent coach_id returns 404 "coach not found"

---

### CAP2-P0-004: Confirm Athlete Self-Update Scope
**Priority:** HIGH (clarifies permissions)  
**Effort:** 3-4 hours  
**Risk:** Medium - affects athlete UX

**Questions to answer:**
- Can athletes modify their own `full_name`? (Probably not)
- Can athletes modify `emergency_contact`? (Probably yes)
- Can athletes modify `dob`? (Probably not)
- Can athletes modify `weight_class`? (Probably not)

- [ ] Document decision in code comment in `access.ts` line 104-124
- [ ] Update `assertAthleteUpdateAllowed()` to restrict fields if needed
  - Example: If only emergency_contact is allowed, add field-level check
- [ ] Add integration test: athlete attempts to change each field
- [ ] Update `POST /api/pilot/athletes/update` route to reflect scope
- [ ] Add UI indicator: "You can update: emergency contact only" (or whatever is allowed)

**Acceptance:** `assertAthleteUpdateAllowed()` documents scope; athlete-scoped fields tested

---

## 🟡 P1 Improvements — MEDIUM PRIORITY (High Value)

These reduce operational friction and improve UX.

### CAP2-P1-001: Extract Shared gym_status Constant
**Priority:** MEDIUM (consistency)  
**Effort:** 1 hour  
**Depends on:** CAP2-P0-001

- [ ] Verify `apps/web/src/shared/athleteConstants.ts` created in P0-001
- [ ] Update `apps/web/components/PeopleWorkspace.tsx` or forms
  - Import `GYM_STATUS_OPTIONS`
  - Replace hardcoded lists with import
- [ ] Update any other UI surfaces using gym_status
- [ ] Verify no duplicate lists remain in codebase

**Acceptance:** Single source of truth for gym_status; UI imports from shared constant

---

### CAP2-P1-002: Empty Coach State UX
**Priority:** MEDIUM (usability)  
**Effort:** 2-3 hours  

- [ ] Add empty-state banner on "Add Athlete" tab when no coaches exist
  - Message: "No coaches yet. Add a coach first using the Staff Invite tab."
  - Include link/CTA to staff invite
  - Disable submit button if no coaches in picker
- [ ] Test: Form shows banner when org has no coaches; hides when coach is added
- [ ] Update error message if form somehow submits: "No coaches available for this athlete"

**Acceptance:** Add Athlete form displays helpful CTA when no coaches exist

---

### CAP2-P1-003: Cross-Link PIN Console ↔ People Tab
**Priority:** MEDIUM (reduces confusion)  
**Effort:** 1-2 hours

- [ ] On **People tab** (PIN reset section):
  - Add: "To set a custom PIN, use the PIN Console tab. To force a PIN change on next sign-in, reset here to the starting PIN."
- [ ] On **PIN Console tab**:
  - Add: "To reset an athlete's PIN and force a change on sign-in, use the People tab."
- [ ] Add one-sentence explanation on both pages
- [ ] Test: Operators can see cross-link on both surfaces

**Acceptance:** One-sentence cross-link visible on both PIN surfaces

---

### CAP2-P1-004: Account ID Collision Error Message
**Priority:** MEDIUM (usability)  
**Effort:** 2-3 hours

- [ ] Update `POST /api/pilot/athletes` error handling
  - When `insertAthleteIfAbsent` returns false (409 conflict):
  - Before returning, query existing athlete: `getAthleteById(organizationId, athlete_id)`
  - Return: `Athlete record already exists: {full_name} (athlete_id={athlete_id})`
- [ ] Update error mapping in `http.ts` to preserve athlete details
- [ ] Add test: collision returns 409 with athlete name
- [ ] Optional: Add client-side pre-check for athlete_id uniqueness

**Acceptance:** 409 Conflict includes existing athlete's name; helps operators correct typos

---

### CAP2-P1-005: Coach Picker Pre-Load
**Priority:** MEDIUM (UX improvement)  
**Effort:** 2-3 hours

- [ ] Update Add Athlete form: Load coach list on component mount (not on submit)
- [ ] Show all active coaches in dropdown before athlete is created
- [ ] Test: Picker is populated before form submission
- [ ] Optional: Add "Unassigned" option if product allows it (requires schema change)

**Acceptance:** Coach dropdown is populated and usable before athlete is created

---

## 🔵 P2 Polish — LOW PRIORITY (Nice-to-Have)

These improve observability and UX polish.

### CAP2-P2-001: Status Chip on People List
**Priority:** LOW (polish)  
**Effort:** 3-4 hours

- [ ] Update People list view
  - Replace multi-line status with single chip
  - Show: `Active · PIN set` / `Pending PIN` / `Deactivated` / `Guardian · no children`
- [ ] Test on various screen sizes
- [ ] Verify accessibility (contrast, screen reader)

**Acceptance:** People list shows concise status chips

---

### CAP2-P2-002: Last Audit Trail on Athlete Record
**Priority:** LOW (observability)  
**Effort:** 2-3 hours

- [ ] Update Athlete Records detail view
  - Surface latest audit event for that athlete_id
  - Show: "Last updated by {actor_name} on {date}: {changed_fields}"
- [ ] Pull from `pilot.audit_events` table
- [ ] Only show field names (never values for minors)

**Acceptance:** Athlete record shows "Last corrected by X on date Y"

---

### CAP2-P2-003: DOB Timezone Handling Test
**Priority:** LOW (regression prevention)  
**Effort:** 1 hour

- [ ] Add unit test for `comparable()` function
  - Create DOB in one timezone
  - Parse as Date in another timezone
  - Verify `comparable()` returns same string
  - Verify no-op save does not report "changed"
- [ ] Test file: `apps/web/app/api/pilot/athletes/update/route.test.ts`

**Acceptance:** Test verifies DOB does not appear changed across timezones

---

### CAP2-P2-004: Weight Class Options
**Priority:** LOW (future)  
**Effort:** 2 days (requires schema + migration)

- [ ] Optional: Extract weight classes to org-specific list
- [ ] Example values: "Bantam", "Feather", "Light", "Middleweight", "Cruiserweight", "Heavyweight"
- [ ] Create schema: `pilot.organization_weight_classes` table
- [ ] Add UI: Organization admin can customize weight classes
- [ ] Not required for Capability #2 completion

---

## 📊 Summary by Priority

| Priority | Count | Effort | Status |
|----------|-------|--------|--------|
| P0 Security | 6 | — | ✅ Implemented |
| P0 Capability | 4 | 8-13 hrs | 🟡 2/4 Complete |
| P1 Improvements | 5 | 8-12 hrs | 🔴 Not Started |
| P2 Polish | 4 | 6-8 hrs | 🔴 Not Started |
| **Total** | **19** | **22-33 hrs** | **2 Complete** |

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

## 🚀 Recommended Implementation Order

**Sprint 1 (Security Critical):**
1. SEC-001 through SEC-006 (all security fixes)

**Sprint 2 (Capability Correctness):**
1. CAP2-P0-001 - Constrain gym_status
2. CAP2-P0-002 - Clarify coach create rights
3. CAP2-P0-003 - Validate coach exists
4. CAP2-P0-004 - Athlete self-update scope

**Sprint 3 (Operational):**
1. CAP2-P1-001 through CAP2-P1-005 - Friction reduction

**Sprint 4+ (Polish):**
1. CAP2-P2-001 through CAP2-P2-003 - Observability

---

**Branch:** `claude/ppbf-platform-audit-w3va0j`  
**Last Updated:** 2026-08-03  
**Ready for:** Team review and sprint planning
