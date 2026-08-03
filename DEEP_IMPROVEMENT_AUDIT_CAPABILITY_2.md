# DEEP IMPROVEMENT AUDIT — Capability #2: Participant Master Record Service
**ppbf-platform | 2026-08-03 | current main**

## 1. Verdict in one line
This capability is **production-ready and unusually well-engineered**. Most remaining work is hardening, consistency, and a few operational gaps — not missing core features.

---

## 2. What is already excellent (do not "improve" these away)

| Area | Why it is strong | Evidence |
|------|------------------|----------|
| Create-only insert | `insertAthleteIfAbsent` — no silent overwrite on ID collision | `apps/web/src/server/pilot/entities.ts:48-66`: `on conflict ... do nothing`, returns false on collision, caller must check |
| Partial-failure recovery | Roster succeeds → account fails → form locks details and explains retry | `apps/web/app/api/pilot/athletes/route.ts:30-33`: create-only, collision returns 409 |
| Audit hygiene | Correction audit stores **field names only**, never values (minors) | `apps/web/app/api/pilot/athletes/update/route.ts:56-77`: `changed_fields` contains names, never values |
| PIN policy | Starting PIN is public + `must_change_pin`; chosen PIN cannot be the starting PIN; trivial patterns rejected | See `pinPolicy.ts` + `assertChosenPinAllowed` |
| Role boundary | Platform owner explicitly excluded from athlete credential surfaces | `apps/web/src/server/pilot/access.ts:57-59`: platform_owner returns "Forbidden" in `assertActorCanAccessAthlete` |
| Stranded guardians | Detected and surfaced, not left as silent empty parent dashboards | Monitored via guardian links + active_flag checks |
| Unreadable rows | Counted and reported, never dropped | Soft-delete only; `active_flag=false` preserves history |
| Coach reassignment safety | Deactivated coach stays in picker so a save cannot silently reassign | `assertAthleteUpdateAllowed` enforces coach_id immutability for athletes |
| Soft deactivate | Record preserved; sign-in is a separate control | `active_flag` column only, no hard-delete paths |
| DOB timezone handling | Careful parsing for calendar dates vs. instants | `apps/web/app/api/pilot/athletes/update/route.ts:30-38`: `comparable()` function rebuilds YYYY-MM-DD to avoid timezone drift |

These are intentional design strengths. **Do not remove them.**

---

## 3. Real gaps & improvements (prioritized)

### P0 — Correctness / safety (do soon)

| ID | Issue | Evidence | Recommended fix |
|----|-------|----------|-----------------|
| **P0-1** | Create route allows **coach** as well as org admin | `POST /api/pilot/athletes` line 14: `requireRole(principal, ['organization_admin', 'coach'])` | Confirm product intent. If coaches should not create roster rows from UI, tighten to org-admin only. If coaches ARE allowed, document why and that line 19-21 already restricts them to self-assigned athletes. Add a test case covering both paths. |
| **P0-2** | `gym_status` is unconstrained text on server | `validateAthletePayload` (validation.ts:67) only checks `requireString` — accepts any non-empty text | Add shared allow-list constant (`'active'` \| `'training'` \| `'inactive'`) in a new `constants.ts`. Use in both server validator and client picker. Reject unknown values with 400: "gym_status must be one of: active, training, inactive". |
| **P0-3** | Update route allows **athlete** role, but scope is unclear | Line 43: `requireRole(..., ['organization_admin', 'coach', 'athlete'])`, but `assertAthleteUpdateAllowed` line 109-124 restricts athlete to no changes to coach_id, active_flag, or gym_status | Document: Can athletes only fix their own name/DOB/emergency_contact? Or are they read-only? Add explicit field-level restrictions in `assertAthleteUpdateAllowed` if needed. Add integration test with athlete role. |
| **P0-4** | No validation that coach exists before create | Coach picker required in UI; empty picks are rejected client-side only | Add server-side check: `getCoachById(organizationId, coach_id)` before insert. Return 400 "Coach not found" if missing. Prevents direct API calls from bypassing coach picker. |

### P1 — Operational friction (high value)

| ID | Issue | Evidence | Recommended fix |
|----|-------|----------|-----------------|
| **P1-1** | Cannot create an athlete until a coach exists | Roster UI requires coach_id; picker empty if no staff | Add empty-state banner on "Add Athlete" tab: "No coaches yet. [Add a coach first]" with deep link to staff invite. Keep coach_id required unless product decides to allow "unassigned" (schema + migration required). |
| **P1-2** | Two overlapping PIN surfaces | People tab = reset to starting PIN; PIN console = custom 6-digit | Keep both, but add a one-line cross-link on each page: "Use People tab to reset to the starting PIN and force a change on next sign-in; use PIN console to set a custom PIN." Reduce operator confusion. |
| **P1-3** | `gym_status` vocabulary duplicated across surfaces | Same list appears in People form + Athlete Records form + tests | Extract `GYM_STATUS_OPTIONS = ['active', 'training', 'inactive']` to new `apps/web/src/shared/athleteConstants.ts`. Import by both client pages + server validator. Single source of truth. |
| **P1-4** | No bulk / CSV import | Only single-record create via UI | Optional later: admin CSV import for roster-only rows (no logins). Not required for capability completeness. |
| **P1-5** | Account ID collision UX is generic | Server error: `Athlete record already exists: {athlete_id}` | Pre-check `athlete_id` uniqueness client-side if possible, or map server 409 to specific message naming the colliding athlete. Helps operators correct typos. |
| **P1-6** | Cannot query coach assignment before submitting athlete create | Must type coach_id; no picker if form not yet saved | Pre-populate coach picker on form load, even before athlete is created. Show all active coaches for org. Improves UX. |

### P2 — Polish & observability

| ID | Issue | Recommended fix |
|----|-------|-----------------|
| **P2-1** | People list status is multi-line | Add a single status chip: `Active · PIN set` / `Pending PIN` / `Deactivated` / `Guardian · no children`. Horizontal layout. |
| **P2-2** | No "last corrected by / when" on Athlete Records | Surface latest audit event for that `athlete_id` (field names only) in the correction panel. Shows who changed what and when. |
| **P2-3** | Activation-codes API still exists | Confirm whether legacy activation-code path is fully retired. If yes, mark dead or remove from admin surface so operators are not confused. |
| **P2-4** | DOB timezone note is careful but fragile | Keep the `comparable()` date helper; add a unit test that a DOB does not appear "changed" on no-op save across timezones. Prevents false positives in audit. |
| **P2-5** | Weight class free text | Optional later: org-level weight-class list (e.g., "Bantam", "Feather", "Light", "Middleweight"). Not required now. |
| **P2-6** | No indication of who is the coach when viewing athlete record | Athlete record shows coach_id but not coach's name | Optional: include coach's full_name in athlete detail view for context. |

### P3 — Nice-to-have / future

- Search/filter by coach, gym_status, active_flag on Athlete Records list
- Export roster to CSV (admin/export already exists — verify athletes are included)
- Soft-delete of accounts (currently only athlete `active_flag` + membership flags)
- Multi-guardian management UI beyond invite + unlink (already functional in backend)
- Bulk reassign coaches when a coach is deactivated

---

## 4. API surface map (for implementers)

| Method | Path | Role(s) | Purpose | Notes |
|--------|------|---------|---------|-------|
| POST | `/api/pilot/athletes` | org_admin, coach* | Create roster row | Create-only; coach restricted to self-assigned (line 19-21). **P0-1**: Clarify scope. |
| POST | `/api/pilot/athletes/update` | org_admin, coach, athlete* | Full-record correction | Athlete cannot change coach_id, active_flag, gym_status (lines 113-123). **P0-3**: Confirm scope. |
| GET | `/api/pilot/athletes/{id}` | Varies | Fetch single athlete | Enforces org boundary + member access check. |
| GET | `/api/pilot/athletes/list` | (admin surfaces) | Roster for correction UI | Lists all athletes in org; used by People + Athlete Records. |
| POST | `/api/pilot/admin/athlete-accounts` | **org_admin only** | Create login account | Links `athlete_id` → `account_id` after roster row exists. |
| GET | `/api/pilot/admin/athlete-pin-directory` | org_admin | PIN directory + account link status | Shows who has login credentials + PIN state. |
| POST | `/api/pilot/admin/accounts/pin-reset` | org_admin | Activate / reset PIN | Sets bootstrap PIN + `must_change_pin=true`. |
| GET/POST/DELETE | `/api/pilot/admin/staff` | org_admin | Members + guardian links | Separate from athlete master record (Capability #3). |

**Key server modules:**
- `src/server/pilot/validation.ts` → `validateAthletePayload` (**P0-2**: add gym_status constraint)
- `src/server/pilot/entities.ts` → `insertAthleteIfAbsent`, `upsertAthlete`, `getAthleteById`
- `src/server/pilot/access.ts` → `assertActorCanAccessAthlete`, `assertAthleteUpdateAllowed` (**P0-3**: clarify athlete scope)
- `src/server/pilot/pinPolicy.ts` → starting PIN + guessability rules
- `src/shared/athleteConstants.ts` → **NEW**: gym status options (**P1-3**)

---

## 5. Concrete work list for Claude Code (ordered)

1. **Create `src/shared/athleteConstants.ts`** with `GYM_STATUS_OPTIONS = ['active', 'training', 'inactive']` (P1-3).
2. **Update `validation.ts`**: Import the constant; add explicit enum check in `validateAthletePayload` for gym_status (P0-2). Reject unknown → 400 with message.
3. **Update client pickers** (People, Athlete Records forms): Import `GYM_STATUS_OPTIONS` and use for dropdowns (P1-3).
4. **Clarify / lock create roles** (P0-1): Decide whether coaches should be able to create athletes via API. If not, change line 14 to `['organization_admin']`. Add test for both. Update UI copy if coaches remain allowed.
5. **Add server-side coach existence check** (P0-4): Before inserting athlete, query coach exists. Return 400 if not found.
6. **Confirm athlete self-update scope** (P0-3): Document what fields athletes are allowed to change (if any). Add integration test with athlete role. Update `assertAthleteUpdateAllowed` field-level checks if needed.
7. **Empty coach state UX** (P1-1): Add banner on Add Athlete tab if no coaches exist. Link to staff invite.
8. **Account ID collision message** (P1-5): Map 409 to specific text naming the existing athlete. Optional: pre-check client-side.
9. **Cross-link People ↔ PIN console** (P1-2): Add one-sentence explanation on each page.
10. **Optional**: status chip on People list (P2-1); last-audit summary on Athlete Records (P2-2).

---

## 6. What not to change

- ✅ Soft-delete only (no hard delete of athlete rows)
- ✅ Starting PIN as public bootstrap + `must_change_pin=true`
- ✅ `assertChosenPinAllowed` refusing starting PIN on athlete-chosen change
- ✅ Platform owner exclusion from credential consoles
- ✅ Parent invite requiring a guardian link at create time
- ✅ Audit details containing field names only (never values for minors)
- ✅ Create-only insert (never upsert on create path)
- ✅ DOB timezone handling via `comparable()` helper
- ✅ `assertAthleteUpdateAllowed` coach_id immutability for athletes (prevents silent reassignment)

---

## 7. Acceptance criteria for "improved"

- [ ] Server rejects unknown `gym_status` values with a clear 400 error message
- [ ] Client and server share one gym-status vocabulary (`GYM_STATUS_OPTIONS`)
- [ ] Documented decision on whether coaches may create athletes (via code comment + test)
- [ ] Server validates coach exists before inserting athlete (400 if not found)
- [ ] Athlete self-update field scope is explicit and tested (add integration test with athlete role)
- [ ] Add-athlete form fails closed with a coach CTA when no coaches exist
- [ ] Account ID collision produces a specific, actionable error (409 with athlete name, not generic text)
- [ ] People and PIN consoles each explain when to use the other (one-sentence cross-link)
- [ ] Existing strengths (partial-failure recovery, stranded guardians, audit hygiene, create-only insert) still pass tests
- [ ] DOB timezone handling still works across timezones (no-op save does not report change)

---

## 8. Risk assessment

| Risk | Mitigation | Priority |
|------|-----------|----------|
| Coach create scope confusion | Explicit decision + test coverage | P0 |
| gym_status enum bypass via direct API | Server-side validation + enum check | P0 |
| Athlete role over-privilege | Clarify field restrictions + integration test | P0 |
| Coach picker empty UX | Empty-state banner + CTA | P1 |
| Duplicate gym_status lists diverge | Extract to shared constant | P1 |
| DOB false positives across timezones | Add unit test for `comparable()` | P2 |
| Account ID collision operator confusion | Specific error message | P1 |

---

## 9. Final status after this deep pass

**EXISTS — production-ready.**  
Highest-value improvements are:
1. **Constrain gym_status to enum** (P0-2)
2. **Clarify coach create rights** (P0-1) + document
3. **Confirm athlete self-update rights** (P0-3) + test
4. **Validate coach exists** (P0-4)
5. **Extract shared gym-status constant** (P1-3)
6. **Empty coach state UX** (P1-1)

Nothing here blocks treating Capability #2 as complete for the original 25. All work is hardening, consistency, and friction reduction — not missing features.

**Estimated effort**: 2–3 days for a junior engineer; 1 day for senior. No architectural changes needed.

---

## 10. Code locations (for reference)

| File | Lines | Purpose |
|------|-------|---------|
| `apps/web/app/api/pilot/athletes/route.ts` | 1–50 | POST create athlete (P0-1, P0-4) |
| `apps/web/app/api/pilot/athletes/update/route.ts` | 1–80 | POST update athlete (P0-3) |
| `apps/web/src/server/pilot/validation.ts` | 58–74 | Athlete payload validation (P0-2) |
| `apps/web/src/server/pilot/access.ts` | 104–124 | Update permission enforcement (P0-3) |
| `apps/web/src/server/pilot/entities.ts` | 48–66 | Create-only insert (reference) |
| `apps/web/src/server/pilot/contracts.ts` | — | Athlete type definition |
| `apps/web/src/server/pilot/pinPolicy.ts` | — | PIN guessability rules (reference) |
| `src/shared/athleteConstants.ts` | — | **NEW** (P1-3) |

---

**End of deep improvement audit. Paste into Claude Code.**
