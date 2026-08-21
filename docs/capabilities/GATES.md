# The gate inventory

**What stops the wrong adult from acting on a child here.**

One index of every gate guarding a capability in this platform: what it checks,
where it is enforced, what it refuses with, and -- the column that matters most
-- **whether it exists today**.

Read this first; each section names the code and tests that carry the full
detail.

---

## How to read the Status column

| Status | Meaning |
|---|---|
| **LIVE** | On `origin/main` at `04dd116b` (2026-08-17), the commit this file was written against. Verified by reading the code, not by reading a ticket. |
| **PR #nnn** | Being added by a named open pull request. **Not on main.** Do not rely on it. |
| **branch `x`** | Being added on a named branch that has no PR number recorded here yet. **Not on main.** |
| **GAP** | Does not exist. Named here because an absent gate is a finding, not an omission. |

An aspirational entry presented as live is the class of dishonesty this whole
audit was about. If an entry below is wrong, the fix is to correct this file, not
to widen the claim.

**This file is documentation on disk.** Nothing imports it, it is not under
`apps/web/public/`, and no page renders it. It will go stale. It carries the
commit it was written against so a reader can tell how stale.

---

## First: how a refusal reaches the caller

Every "refuses with" below depends on two files. Read them before trusting any
status code in this document.

`apps/web/src/server/pilot/http.ts:jsonError` maps a thrown error to a response,
in this order:

1. **`PilotError` (by type)** -- returns its own `status`, its message intact, and
   its `code` when it has one.
2. **`MedicalStatusBlockedError`**, **`GuardianConsentMissingError`** (by type) --
   409, message intact.
3. **`ShadowRuntimeUnavailableError`** (by type) -- 503, message replaced,
   diagnostic logged.
4. **By message prefix**: `Unauthorized` -> 401; `Forbidden` -> 403;
   `Missing` / `Request body` / `Unsupported` / `PIN` -> 400;
   `Not found` / `Athlete not found` -> 404;
   `Account already exists` / `Athlete is already linked` /
   `Athlete record already exists` / `Coverage already exists` /
   `Hold already exists` -> 409.
5. **Everything else** -> 500 with the message **scrubbed** to
   `Internal server error`.

Step 5 is correct as a default -- a raw message can carry connection strings, SQL
or stack detail -- and it is also the trap. `apps/web/src/server/pilot/errors.ts`
exists because "a load-bearing contract was expressed as a string prefix and
enforced by comment, so a validation message could stop being disclosed by being
reworded." It happened: `pinPolicy.ts` documented the convention and broke it
eleven lines later, and an athlete who picked `111111` got
`Internal server error` instead of the reason.

**Prefer the typed errors** (`ValidationError` 400, `ForbiddenError` 403,
`NotFoundError` 404, `ConflictError` 409). Throwing one asserts: *this message
was authored for the caller to read, and I have checked it carries no internal
detail.* A plain `Error` keeps meaning "redact me."

`http.ts:hiddenNotFound()` is the deliberate exception to `NotFoundError`: routes
where a distinct 404-vs-403 would disclose that a record exists return an
identical `404 {"error":"Not found"}` for both cases. Do not "fix" those into
403s.

---

## 1. Session and tenancy -- the floor everything else stands on

Full detail: `auth.ts` and its test suite.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Session token | Hashed opaque token matches an unrevoked, unexpired `pilot.session_tokens` row; account `active_flag`; **an active `organization_memberships` row for the session's org** (an inner join) | `auth.ts:resolvePrincipal` | 401 `Unauthorized` | **LIVE** |
| Absolute session lifetime | 24h, no refresh, no sliding window | `sessionPolicy.ts:computeSessionExpiry` | 401 once expired | **LIVE** |
| Bootstrap-PIN stop | `mustChangePin === true` blocks **every** route except session-read and PIN-change | `http.ts:requirePrincipal` | 403 `Forbidden: PIN change required before using this account` | **LIVE** |
| Same stop, for pages | as above, redirected rather than refused | `pageGuard.ts:requirePageRole` | redirect to `/change-pin` | **LIVE** |
| Credential class per role | admins Microsoft, adults magic link, athletes PIN; **any** board seat upgrades to Microsoft; total over `PilotRole` (a new role is a compile error) | `credentialPolicy.ts:requiredCredentialFor` | 401 `Invalid credentials`, reason logged `role_not_pin_eligible` | **LIVE** |
| Privileged-session gate | `authProvider !== 'microsoft'` on account/role/access management routes | `http.ts:requireMicrosoftAuthenticatedPrincipal` | 403 `Forbidden: Microsoft-authenticated session required` | **LIVE** |
| Revoke-on-sight | a live `ppbf_local` session for a non-PIN role is revoked mid-request | `auth.ts:resolvePrincipal` | 401, token row revoked | **LIVE** |
| Organization must be active | `organizations.status <> 'active'` ends every member's session (platform owner excepted) | `auth.ts:resolvePrincipal`, both login paths | 401 `Unauthorized` | **LIVE** |
| No orphan tokens | every sign-in refusal is decided **before** the token insert | `auth.ts:loginWithMicrosoftEmail` | 403 `Forbidden: unsupported authenticated role` / `Forbidden: platform owner identity mismatch` | **LIVE** |
| **Org-scoping convention** | a route may not read `organization_id` from the caller without one of four recognised guards | `organizationScope.convention.test.ts` (build-time, reads route files off disk) | a failing test before merge | **LIVE** |
| Cross-org revocation | target must hold an **active membership in the acting admin's org**; platform owners are never revocable; only that org's sessions are cut | `auth.ts:revokeAllSessionsForAccountInOrganization` | `Account not found or cannot be revoked` -- **but see GAP-1** | **LIVE** |
| PIN choice policy | refuses the published starting PIN, non-digits, wrong length, all-one-digit and ascending/descending runs **with wraparound** | `pinPolicy.ts:assertChosenPinAllowed`, `:validatePinPolicy` | 400 with codes `PIN_IS_DEFAULT_FIRST_LOGIN`, `PIN_REQUIRED`, `PIN_NOT_NUMERIC`, `PIN_WRONG_LENGTH` | **LIVE** |
| PIN reset invariant | a reset always sets `must_change_pin` **and** revokes every session, in one transaction | `auth.ts:resetAccountPin` | -- | **LIVE** |
| Brute-force throttle | volatile **and** durable buckets, per account and per IP; 5 attempts, backoff 1s->60s, 15-minute window; cleared on success | `rateLimit.ts` + `app/api/pilot/auth/login/route.ts` | 429 `Too many login attempts...` | **LIVE** |
| Forensic trail | every login rejection logs a reason code, never the PIN | `auth.ts:loginWithAccountIdAndPin` | -- | **LIVE** |
| Client IP resolution | walks `x-forwarded-for` right-to-left by `PPBF_TRUSTED_PROXY_COUNT`, never trusts the leftmost value | `rateLimit.ts:getClientIp` | -- | **LIVE** |
| Bootstrap key | header secret + **durable** per-IP limiter (the route is an oracle even though it never grants access) | `security.ts:bootstrapKeyMatches`, `admin/bootstrap/route.ts` | 403 `Forbidden: invalid bootstrap key`, 429 | **LIVE** |
| Public surfaces name no org | unauthenticated reads hard-code the default org rather than accepting one | `announcements/public`, `wall`, `floor-hours/public` | -- (no parameter exists) | **LIVE** |

---

## 2. Reaching a specific child

The single function every athlete-scoped read and write funnels through.
`access.ts` is called, never edited, by everything below. (This section
previously attributed `access.ts` to "open PR #431" -- that was wrong on both
counts: #431 closed on `fcabbde5` as "Batch shadow-job list authorization
instead of one check per row", not an access.ts feature branch, and
`access.ts` itself is not owned by any open PR. What #431 actually added --
the batched `accessibleAthleteIds` used by `getJobsForActor` -- is the
"Batched form" row below, already marked **LIVE**.)

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| The actor/athlete gate | org admin: any athlete in their own org. coach: `coach_id` of record **or** an active coverage grant. athlete: only themselves. parent: a guardian link. `platform_owner` and `board`: refused outright | `access.ts:assertActorCanAccessAthlete` | 403 `Forbidden: coach not assigned to athlete` / `Forbidden: athlete does not belong to organization` / `Forbidden: athlete cannot access another athlete record` / `Forbidden: parent not linked to athlete` / `Forbidden: platform owner cannot access organization-private athlete records by default` / `Forbidden: board role is restricted to organization-level aggregates` / `Forbidden: role not allowed` | **LIVE** |
| Batched form | same answers for many candidate ids in a bounded number of queries | `access.ts:accessibleAthleteIds` | the id is absent from the returned set | **LIVE** |
| Org membership of the athlete | `pilot.athletes` row must carry this `organization_id` | `access.ts:assertAthleteBelongsToOrganization` | 403 `Forbidden: athlete does not belong to organization` | **LIVE** |
| Coach cannot re-assign | a `coach` actor may not change `athletes.coach_id` | `access.ts:assertAthleteUpdateAllowed` | 403 `Forbidden: coach cannot change coach assignment` | **LIVE** |
| Athlete cannot self-promote | an `athlete` actor may not change `coach_id`, `active_flag` or `gym_status` | `access.ts:assertAthleteUpdateAllowed` | 403 `Forbidden: athlete cannot change coach assignment` / `...status flags` / `...gym_status` | **LIVE** |
| Guardian reach, one definition | `guardian_links` joined to `parents` **organization-scoped on both levels** | `guardianAccess.ts:isGuardianLinkedToAthlete`, `:guardianAthleteIds` | false / `[]` (callers must pass `[]` through, never widen to `undefined`) | **LIVE** |
| No second guardian join | a build-time check that no route hand-writes the viewer-scoped guardian join again | `guardianAccess.test.ts` | a failing test | **LIVE** |

The `coach_id` gate is not roster bookkeeping. `profileDb.ts` mints
`coach_of_subject` straight from that column, and that relationship is one of the
three in `profileVisibility.ts:MINOR_CIRCLE`. **Writing that column admits the
writer to a child's portrait.**

---

## 3. Coach coverage -- temporary access, expiry, revocation

Full detail: `access.ts` and the route's tests. One disclosure worth knowing:
`GET` returns `login_email` for the covering coach and the granter — an
intra-org, admin-only field disclosure no tier check gates.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Grant authority | Microsoft session + organization admin, on all three verbs | `admin/coach-coverage/route.ts` | 403 `Forbidden: Microsoft-authenticated session required` / `Forbidden: role not allowed` | **LIVE** |
| Subject is ours | athlete in the granting org | `access.ts:assertAthleteBelongsToOrganization` via `:grantCoachCoverage` | 403 `Forbidden: athlete does not belong to organization` | **LIVE** |
| **Grantee is a real coach** | `accounts` row with `role='coach'`, `active_flag=true`, same org | `access.ts:assertActiveCoachAccount` | 400 `Missing covering_coach_id: must be an active coach account in this organization` | **LIVE** |
| TTL bound | positive integer <= 336h; default 24h | `access.ts:resolveCoverageTtlHours` | 400 `Missing ttl_hours: must be a positive integer of at most 336` | **LIVE** |
| No stacking | at most one live grant per (athlete, coach) | `access.ts:grantCoachCoverage` | 409 `Coverage already exists: <id> for this coach and athlete is still active` | **LIVE** |
| Expiry without a cron | `starts_at <= now() and expires_at > now()` in the SQL predicate on every read | `access.ts:assertCoachAssignedToAthlete`, `:accessibleAthleteIds` | 403 `Forbidden: coach not assigned to athlete` -- **byte-identical** to "no relationship", so which of the three states applies is not disclosed | **LIVE** |
| Revocation | `expires_at = now()` under an `expires_at > now()` guard; idempotent; expires rather than deletes | `access.ts:revokeCoachCoverage` | 200 `revoked: false` (deliberately **not** 404, so a coverage id cannot be probed across gyms) | **LIVE** |
| Audit | grant and effective revoke both written to `pilot.audit_events` under `entity_type='coach_coverage'` | `admin/coach-coverage/route.ts` | -- | **LIVE** |
| Pre-migration tolerance | Postgres `42P01` on `coach_coverage` reads as "no coverage"; any other error propagates | `access.ts` (both read paths) | -- | **LIVE** |
| Coverage reaches the alarm too | the escalations feed unions assigned **and** actively-covered athletes | `app/api/pilot/escalations/route.ts:coachAthleteIds` | -- | **LIVE** |
| Cap on simultaneous grants per coach | -- | -- | -- | **GAP** (see GAP-5) |
| Reason for a grant | -- | -- | -- | **GAP** (no reason column, no required note) |

---

## 4. Guardian linking and media consent

Full detail: `guardianConsent.ts` (its `resolveActingParent` header carries the
wrong-parent-row bug history) and `guardianConsent.test.ts`.

Consent = **every** linked guardian has a current (`distinct on (parent_id) ...
order by created_at desc`) `photo_media` waiver with `status = 'signed'`.
**Zero guardians fails**, as unverifiable rather than vacuously satisfied.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Parent-role write | consent is a guardian's decision; no staff route records it for them | `parent/consent/route.ts` (`requireRole ['parent']`) | 403 `Forbidden` | **LIVE** |
| Own child only | the `athlete_id` must be in `guardianAthleteIds` for this account | `parent/consent/route.ts:POST` | **404** `Not found` (`hiddenNotFound`) -- a 403 would confirm the child exists | **LIVE** |
| Per-athlete guardian resolution | the specific `parents` row that is a real `guardian_links` guardian **of this athlete** -- never "the account's first parent row" | `guardianConsent.ts:resolveActingParent` -> `guardianAccess.ts:guardianParentIdForAthlete` | 400 `Unsupported: no guardian record on file for this account` | **LIVE** |
| Consent before approve | complete consent before a publication is approved | `admin/video-compliance/route.ts:POST` -> `guardianConsent.ts:assertGuardianMediaConsent` | 409 `Blocked: guardian media consent is missing or withdrawn for N of this athlete's guardians...` / `Blocked: this athlete has no guardians on file...` | **LIVE** |
| Consent before publish | same, at the research-library claim | `publications/publish/route.ts:POST` | same 409 | **LIVE** |
| Consent before AI Film Study | `'ready'` means the scan passed, not that anyone consented | `shadow/video-analysis/route.ts:POST` | same 409 | **LIVE** |
| Race-closed re-check | the same check re-run on the committing transaction's client, with `guardian_links ... FOR SHARE`; **required, not optional**, on the publish path | `guardianConsent.ts:assertGuardianMediaConsentWithClient` as `verifyBeforeCommit` | same 409, transaction rolled back | **LIVE** |
| Withdrawal retracts | published media is swept to `retracted` in the withdrawal request, under `FOR UPDATE` on the same rows | `publication.ts:suppressPublishedMediaForAthlete` | -- | **LIVE** |
| A failed sweep is loud | unlike every audit write on these routes, a failed suppression is **not** swallowed | `parent/consent/route.ts:POST` | 500 `Your consent withdrawal was recorded, but suppressing already-published media failed...` + an audit row | **LIVE** |
| Blocked attempts are audited | who tried to act on unconsented footage of this child, and when | video-compliance and publish routes | -- | **LIVE** |
| Org-wide audit is unpaginated | a default page cap would hide the finding the screen exists to surface | `guardianConsent.ts:listOrganizationConsentStatus` (org-admin only, read-only) | -- | **LIVE** |
| **Consent SCOPE enforcement** | `covers_video` / `public_use_allowed` are recorded and **never read by any gate** | -- | -- | **GAP** (see GAP-2) |
| **Guardian identity on link creation** | nothing validates the `account_id` attached to a guardian record | -- | -- | **GAP** (see GAP-3) |

---

## 5. A child's face and name

Full detail: `profileVisibility.ts` (its header states the
relationship-not-consent model). Two notes with no other home: a guardian's
`photo_media` withdrawal never un-releases a portrait — guardians have no
takedown route; they ask staff to block (`photo/review` admits admin+coach
only). And the portrait-review POST accepts an approve with no attestation
field (curl bypasses the console's view gate); the compensating control is
that an approval lacking a matching `portrait_review_image_viewed` audit
event for that reviewer+account is detectable after the fact.

The strictest tier in the platform (`privacyTiers.ts` calls it `minor_circle`).
It decides on **relationship**, not consent, because -- as
`profileVisibility.ts` states -- there is no display consent in this system to
find.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Upload is self-only | the route **takes no account id**; path and row derive from `principal.accountId` | `profile/photo/route.ts:POST` | -- (no request shape expresses the forbidden action) | **LIVE** |
| Format allow-list | only JPEG/PNG -- formats whose metadata this platform can strip exactly. WebP/HEIC/GIF/SVG refused | `profilePhotoPolicy.ts:describeProfilePhotoUpload` | 415 `Only bounded JPEG and PNG photos are accepted.` | **LIVE** |
| Content matches declaration | header must parse as the declared format; the signature check and the dimension read are the same operation | `profilePhotoPolicy.ts:validateProfilePhotoContent` | 415 `The photo content does not match its declared file type.` | **LIVE** |
| Dimensions measured, not asked | real pixel dimensions read from the file; <=640px long edge, >=96px short edge, <=1.5MB | same | 413 `Photos are stored at 512px. This one is <N>px on its long edge -- resize it and try again.`; 400 `A portrait needs to be at least 96px on its short edge.` | **LIVE** |
| **EXIF/GPS stripped before storing** | every APPn and comment segment (JPEG); every non-essential chunk incl. `eXIf`/`tEXt`/`iTXt`/`zTXt` (PNG) | `profilePhotoPolicy.ts:stripJpegMetadata`, `:stripPngMetadata` | -- | **LIVE** |
| Born pending | `photo_review_state = 'pending_review'`; only the uploader sees it | `profileDb.ts:setPhoto`; `profileVisibility.ts:decidePortrait` | plate / 404 | **LIVE** |
| Human review has a door | an org admin, or one of the athlete's **own** coaches, releases or blocks | `profile/photo/review/route.ts` | 404 `Not found` for a coach with no `coach_of_subject` relationship | **LIVE** |
| Block deletes the bytes | not just a flag | `profile/photo/review/route.ts` -> `blob.ts:deletePilotProfilePhoto` | -- | **LIVE** |
| Takedown beats self-access | `blocked`/`removed` shows the plate to the uploader too | `profileVisibility.ts:decidePortrait` | plate | **LIVE** |
| **The minor circle** | a minor's released portrait reaches only `self`, `coach_of_subject`, `guardian_of_subject`. Org admins, the board and the platform owner are **outside** it | `profileVisibility.ts:MINOR_CIRCLE`, `:decidePortrait` | 404 / plate, reason `minor_outside_own_circle` | **LIVE** |
| Ring name scoped identically | the chosen name travels with the face | `profileVisibility.ts:decideRingName` | `null` | **LIVE** |
| Cross-family boundary | a parent not linked to **this** athlete is `'none'`, not `organization_staff` | `profileDb.ts:resolveRelationship` | plate / 404 | **LIVE** |
| Defaults resolve to less | unknown DOB = minor; unrecognised review state = `pending_review`; different org = `'none'` | `profileVisibility.ts:normalizePhotoReviewState`, `wallDisplay.ts:isMinor`, `profileDb.ts:resolveRelationship` | plate | **LIVE** |
| No shareable link | portraits are an authenticated byte stream; **no SAS URL is minted for that container** (verified: `blob.ts` has none) | `profile/photo/[accountId]/route.ts` | -- | **LIVE** |
| Cache defeat | `private, no-store, max-age=0`, `nosniff`, `default-src 'none'; sandbox` | same | -- | **LIVE** |
| Uniform refusal | "no such account", "no photo", "not released", "not your family" all return the same 404; the card is assembled **after** the decision so it cannot be read backwards | `profile/photo/[accountId]/route.ts`, `profile/card/route.ts` | 404 `Not found` | **LIVE** |
| Roster decides per row | `scope=organization` changes which rows come back, never what may be seen on one | `profile/roster/route.ts` | plate per row | **LIVE** |
| Wall / wall-of-names privacy | public surfaces resolve every athlete to initials unless a guardian-signed waiver row says otherwise; opaque hashed keys, no `athlete_id`; org fixed; IP-budgeted | `wallDisplay.ts:resolveDisplayVisibility`, `wallRateLimit.ts`, `app/api/pilot/wall/route.ts` | 429 `Too many requests.`; 503 with **no** detail (deliberately not `jsonError` -- the response renders on a screen in a public room) | **LIVE** |
| Reviewer must have seen the image | a narrow, audited, review-only route (mirrors `video/review-link`'s split from `video/[videoId]`) serves the pending photo only, organization-admin only, `pending_review` state only; the console's Approve stays disabled until the reviewer's own `<img>` has fired `onLoad` for that photo | `admin/portrait-review/photo/[accountId]/route.ts`, `profileVisibility.ts` boundary unchanged | hidden 404, same posture as the release path | **LIVE** -- merged as **PR #461** (`c78f181a`). Re-verified against current `main` (this file's 2026-08-17 version listed it as a not-yet-on-main branch; git log + `NETWORK_STATUS.md`'s Closed table confirm it merged.) |
| Route-level tests for any of the above | -- | -- | -- | **GAP** (see GAP-4) |

---

## 6. Video -- quarantine, release, publication

Full detail: `videoSessions.ts` and the video route tests. One asymmetry with
no other home: a blocked video's blob is retained (only
`scan_state='blocked'`), unlike a blocked portrait whose bytes are deleted.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Upload authority | coach or org admin; transport; declared type; **first 16 bytes** against it; `assertActorCanAccessAthlete` for a named athlete | `video/upload/route.ts` + `videoUploadPolicy.ts` | 415 `Only bounded MP4, MOV, AVI, WebM, and MPEG video files are accepted.` / `The video content does not match its declared file type.`; 411; 413; 429 + `Retry-After` | **LIVE** |
| Born quarantined | `status` is a literal `'quarantined'` on insert; every reader requires `'ready'` | `video/upload/route.ts` | 202, and an honest message naming whether a scanner exists | **LIVE** |
| Absence is never a pass | promote only when **every enabled** gate returned an affirmative pass | `videoScanPolicy.ts:decideVideoScanOutcome` | `retry` / `needs_human_review`; row stays quarantined | **LIVE** |
| `uncertain` routes to a human | a first-class outcome, not an error | same | `needs_human_review`, reason `CONTENT_SCREEN_UNCERTAIN` | **LIVE** |
| Exact verdict parse | only `SCAN_PASS`/`SCAN_FAIL` as the whole first line | `videoScanPolicy.ts:parseContentScreenVerdict` | `uncertain` | **LIVE** |
| No scanner = no promotion, ever | both gates default **off**; `hold` is distinct from `retry` so the worker does not spin | `videoScanPolicy.ts:resolveVideoScanConfig`, `:decideVideoScanOutcome` | `scan_state='unconfigured'`, status untouched | **LIVE** |
| No concurrent scan | `FOR UPDATE SKIP LOCKED`; attempts burned at **claim** time | `videoSessions.ts:claimNextVideoSessionForScan` | -- | **LIVE** |
| Coach may resolve, never overturn | release admits only `needs_human_review` / `unconfigured`; the predicate is repeated on the `UPDATE` | `video/[videoId]/release/route.ts` | 409 `The content screen refused this video. It cannot be released here; ask an administrator to review it.` / `This video is still waiting on its content scan...` / `This video changed state before it could be released. Reload and try again.` | **LIVE** |
| Malware is never a judgement call | `status='infected'` refused on every human surface | `videoScanReview.ts:authorizeVideoScanReview` | 409 `A scanner found malware in this file. It cannot be released by review.` (`VIDEO_SESSION_INFECTED`) | **LIVE** |
| Machine never overturns the human | `scan_state <> 'blocked'` on the settle; a late verdict is **appended** to `scan_detail`, never replacing the `human_review` record | `videoSessions.ts:settleVideoSessionScan`, `:recordScanOutcomeOnBlockedVideo` | -- | **LIVE** |
| Attestation is merged, with `prior_scan_state` | a human-released video must never look like one the screen passed | `videoSessions.ts:reviewVideoSessionScan` | -- | **LIVE** |
| Reviewer must be admin or uploader | closes an alternate playback path around "held until released" | `videoScanReview.ts:authorizeVideoScanReview` | 404 `Not found` | **LIVE** |
| Watch is separated from decide | `VIDEO_REVIEW_VIEW_ROLES` (admin+coach) vs `VIDEO_REVIEW_DECIDE_ROLES` (admin only) | `videoScanReview.ts` | 403 `Forbidden: role not allowed` | **LIVE** |
| Every review view is audited | link issuance and decision both written before the response, with the athlete and the scan state | `video/review-link/route.ts`, `video/scan-review/route.ts` | -- | **LIVE** |
| Existence not disclosed | identical 404 for "no such video", "not ready", "athlete not accessible", "unattributed and you are neither coach nor admin" | `video/[videoId]/route.ts`, `videoScanReview.ts` | 404 `Not found` | **LIVE** |
| Per-role list shapes | athlete/parent pinned to `ready`; coach sees own quarantined + unassigned (**owner-confirmed breadth, 2026-08-08**); admin org-wide | `video/list/route.ts` | 403 `Forbidden: your role does not have permission to list videos` | **LIVE** |
| Publication compliance console | org-admin only; CAS-guarded transition **and** its check row in one transaction; a rejection/request-for-changes/retraction needs a stated reason | `admin/video-compliance/route.ts` -> `publication.ts:decidePublicationCompliance` | 400 `Missing note: a rejection needs a stated reason` / `Missing note: a retraction needs a stated reason`; 400 `Unsupported: publication was already decided by another reviewer`; 409 for the wrong lifecycle state | **LIVE** |
| Video retention/deletion clock | -- | -- | -- | **GAP** |
| Consent gate on plain playback | `ready` video is watchable by staff and family with no consent check anywhere | -- | -- | **GAP** (by design; consent gates publication and AI only) |

---

## 7. Sports medicine -- training holds and medical clearance

Full detail: `trainingHolds.ts`, `contactClearanceGate.ts` (block-vs-flag
doctrine in its own comments), and their tests.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Staff only | coach or org admin place/lift; athlete and parent read their own; board and platform owner get nothing | `training-holds/route.ts` | 403 `Forbidden: role not allowed` | **LIVE** |
| Standing with this child | coach: `assertCoachAssignedToAthlete` (coverage counts); admin: org membership; parent: `guardianAthleteIds` | `training-holds/route.ts` | 403 `Forbidden: coach not assigned to athlete` / `Forbidden: parent not linked to athlete`; on lift, `Missing hold record` for both "not yours" and "not real" | **LIVE** |
| **A sentence the child can read** | `athlete_explanation` is mandatory -- "a hold a child cannot read a reason for is a punishment, not a safety measure" | `training-holds/route.ts:POST` | 400 `Missing athlete_explanation: the sentence the athlete reads is required` | **LIVE** |
| Athlete-safe projection | athlete and guardian receive scope, explanation, lift condition, dates -- **never** `reason_text`, category, or who placed it | `training-holds/route.ts:athleteFacing` | -- | **LIVE** |
| One active hold | sweep, then check, then a partial unique index with a `23505` catch | `trainingHolds.ts:placeTrainingHold` | 409 `Hold already exists: <id> is active for this athlete -- lift it first` / `...placed concurrently...` | **LIVE** |
| Expiry cannot be dressed up as a lift | the lift `UPDATE` carries `status='active'` **and** the expiry predicate; the refusal re-derives the true status | `trainingHolds.ts:liftTrainingHold` | 400 `Unsupported transition: hold is 'expired' and cannot be lifted` | **LIVE** |
| Lapsed rows are swept | so the staff list never shows a child as protected when they are not, and the unique-index slot is freed | `trainingHolds.ts:sweepExpiredHolds` | -- | **LIVE** |
| **STOP: class registration** | an active `all_training` hold refuses registration, in the registration's own transaction, before the duplicate and capacity checks | `schedulerDb.ts:registerForClassTransactionally` -> `trainingHolds.ts:findRegistrationBlockingHold` | outcome `training_hold` carrying the athlete's own explanation and lift condition | **LIVE** |
| Hold + escalation commit together | severity `high` for `all_training`, `moderate` for scoped; target `organization_admin` | `trainingHolds.ts:placeTrainingHold` | -- | **LIVE** |
| **REGRESS: contact during a hold** | contact logged while an `all_training`/`contact_only` hold is active raises a `high` near miss, deduped per session -- a **flag, never a block** | `trainingHolds.ts:flagContactDuringHold` | (no refusal, by doctrine) | **LIVE** |
| **Contact without clearance** | only an explicit `'cleared'` status passes; `pending`, `restricted`, `not_cleared` and *no record* all flag. `critical` for the two affirmative refusals, `high` otherwise. Includes the lesson text | `contactClearanceGate.ts:flagContactWithoutClearance` | (flag, not a block -- see below) | **LIVE** |
| Both flags run **before** the write | so a failure aborts loudly rather than storing contact nobody was told about | `shadow/formulas/observations/route.ts` | -- | **LIVE** |
| Medically sensitive recommendations | unconditional fail-closed clearance check -- it used to be armed by a request-body flag, and "a safety gate the caller decides to arm is not a gate" | `shadowRecommendations.ts:assertMedicalStatusAllowsRecommendation` | 409 `Blocked: this athlete's medical administrative status is '<x>', not 'cleared'...` / `Blocked: this athlete has no medical administrative status on file yet...` | **LIVE** |
| Medical status is read-only to the model | the write function must never be imported by recommendation or decision logic | `shadowMedicalStatus.ts` (documented invariant) | -- | **LIVE** |
| Per-org gate deactivation | an organization may set `safety_gates.active_flag=false` for a named gate -- a configuration, **not** a per-evaluation override (no such override exists) | `safetyGateMatrix.ts:getSafetyGateDefinition` | -- | **LIVE** |
| Contact-event hold gate (competitions) | `all_training` + `contact_only` blocks a competition entry | `trainingHolds.ts:findContactEventBlockingHold` | 403 `TRAINING_HOLD_BLOCKS_COMPETITION` | **LIVE** (merged as PR #452) |
| **`conditioning_only` enforcement** | the scope is storable, escalating and displayed -- and **no code path reads it** | -- | -- | **GAP** (see GAP-6) |
| Hold vs. medical record reconciliation | a `medical` hold is not tied to `shadow_medical_administrative_status`; lifting one does not clear the other | -- | -- | **GAP** |
| Required note on lifting | -- | -- | -- | **GAP** (`lift_note` optional, unlike compliance's required closing note) |
| Maximum hold duration | `expires_at` may be null = indefinite | -- | -- | **GAP** (deliberate for medical holds; contrast coverage's 336h cap) |

**Why two of these are flags and not blocks** -- the doctrine, from
`contactClearanceGate.ts`: refusing a *record of contact that already happened*
"does not un-spar the athlete, it destroys the only record that it occurred, and
it teaches whoever is logging to leave the contact fields blank next time.
Under-reporting is the failure mode that actually hurts an athlete." A
**pre-action** gate (registration, competition entry) refuses; a **post-action**
record flags.

---

## 8. Safety compliance and escalation

Full detail: `compliance.ts` (`TRANSITION_CONTRACT` states what resolution
does and does not mean) and the compliance/escalation tests.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| File authority | coach/admin file and read; **admin only** moves the lifecycle | `compliance/violations/route.ts`, `compliance/escalate/route.ts` | 403 `Forbidden` | **LIVE** |
| Standing with this child | `assertActorCanAccessAthlete` before the rule lookup | `compliance/violations/route.ts:POST` | 403, `access.ts` messages | **LIVE** |
| Cross-org ids hidden | rule, video session and violation all resolved org-scoped | same + `escalate/route.ts` | 404 `Not found` | **LIVE** |
| Evidence belongs to this child | a cited `video_session_id` attributed to a **different** athlete is refused | `compliance/violations/route.ts:POST` | 404 `Not found` | **LIVE** |
| Severity vocabulary | the table has no CHECK constraint, so the code supplies one | `compliance.ts:createComplianceViolation` | 400 `Unsupported severity: must be one of critical, high, medium, low` | **LIVE** |
| Violation + escalation atomic | both on one transaction client | `compliance.ts:createComplianceViolation`, `:escalateViolation` | 400 `Unsupported: violation is not in an escalatable state` (rolls back) | **LIVE** |
| Lifecycle CAS | each transition names its allowed source states; `resolved`/`dismissed` terminal; org id in the predicate | `compliance.ts:transitionComplianceViolation` | 409 `This violation cannot be <resolved> from its current state.` + the current status | **LIVE** |
| Resolving closes the escalation track | in the same transaction, so `resolved` + `in_progress` is unrepresentable | same | -- | **LIVE** |
| Closing verdicts need a reason | `resolve`/`dismiss` require a note; `acknowledge` does not | `compliance/violations/route.ts:PATCH` | 400 `Missing note: a resolution needs a stated reason` | **LIVE** |
| No unsafe auto-escalation target | rules with `escalation_level` `board` or `parent` do **not** auto-file on the ladder | `compliance.ts:RULE_ESCALATION_LEVEL_TO_TARGET_ROLE` | silent no-op, reported as a known gap rather than widened | **LIVE** |
| Ladder target constraint | `safety_escalations.escalated_to_role` is `check (... in ('coach','organization_admin','admin'))` | migration `pilot_slice_postgres_safety_escalations_migration.sql` | constraint violation | **LIVE** |
| Board sees gated counts only | each severity and status bucket independently k-anonymity-gated; `athlete_id` never selected; empty stays distinguishable from suppressed | `compliance.ts:getOrganizationViolationSummary` -> `boardSummary.ts:boardCountMetric` | a **withheld** bucket, never a small number | **LIVE** |
| Coach escalation feed excludes `athlete_voice` | their existence alone says "this child said something", and the coach may be who it is about | `escalations/route.ts:GET` | rows omitted | **LIVE** |
| Severity sorts correctly | `severity` is text; an explicit rank stops `medium` outranking `critical` | `compliance.ts:SEVERITY_RANK_SQL` | -- | **LIVE** |
| Morning Read surfaces open escalations/violations | -- | -- | -- | **LIVE** (merged as PR #450) |
| **`violation_escalations.escalated_to_role` validation** | free text, no CHECK constraint, no code validation | -- | -- | **GAP** (see GAP-7) |
| Compliance rule write route | rules are seed-only; there is no create/edit/deactivate route | -- | -- | **GAP** (nothing to gate; a gym cannot add a rule without a migration) |

---

## 9. Competition entry

The first per-athlete gates on the two competition capabilities, merged as
PR #452. Full detail: `competitionSafetyGates.ts` (its own comments state the
every-season-is-travel, fail-closed-absent-a-home/away-flag rationale) and
`competitionSafetyGates.test.ts`.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Standing with this child | `assertActorCanAccessAthlete` before any hold or waiver read | `competitionSafetyGates.ts:assertAthleteMayBeEnteredInCompetition` | 403, `access.ts` messages | **LIVE** (merged as PR #452) |
| No contact-covering hold | `all_training` or `contact_only`, expiry in the predicate | same -> `trainingHolds.ts:findContactEventBlockingHold` | 403 `ForbiddenError` code `TRAINING_HOLD_BLOCKS_COMPETITION`, carrying the athlete's own explanation | **LIVE** (merged as PR #452) |
| Signed travel waiver | newest `travel` waiver must be `signed`; `missing`/`declined`/`withdrawn` all refuse | same -> `waiverCompliance.ts:getAthleteWaiverStatus` | 409 `ConflictError` code `TRAVEL_WAIVER_NOT_SIGNED` | **LIVE** (merged as PR #452) |
| Age / weight / medical-clearance eligibility | -- | -- | -- | **GAP**, and the PR says so: an athlete with medical status `not_cleared` and no training hold can still be rostered |

---

## 10. Evidence and truth-on-screen

All four rows below were listed in this file's 2026-08-17 version as
not-yet-on-main branches. Re-verified against current `main` (git log +
`docs/capabilities/NETWORK_STATUS.md`'s Closed table): all four merged and are
now on main. Corrected here rather than left to mislead a reader into thinking
they still need watching.

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Only an accepted Film Study proposal is admissible evidence | `review_state` must be in `ADMISSIBLE_FILM_STUDY_REVIEW_STATES` (today exactly `['accepted']`), bound to the source union via `as const satisfies` so the predicate and the SQL cannot drift; a new verdict kind (PR #419) is **inadmissible on arrival** | `shadowFilmStudyProposals.ts` and its caller | 404 `Not found` (the module's existing hidden not-found) | **LIVE** -- merged as **PR #459** (`b070fa50`) |
| A per-child value belongs to the child now selected | superseded loads aborted; `controller.signal.aborted` re-checked after every await and before every `setState`; an abort never clears existing state; anchored per-selection so a slow earlier response cannot overwrite a faster later one | `app/parent/progression-visibility`, `components/ParentHub`, and a third progression surface's client effects | -- | **LIVE** -- merged as **PR #460** (`4d6a2b05`) |
| The revenue console disowns its fabricated rows | an unconditional "Planned -- Not Yet Implemented" stamp plus per-tab notices naming the data as fabricated; pinned by a test that mocks `global.fetch` and asserts it is never called | `RevenueFundingCenter.tsx` | -- | **LIVE** -- merged as **PR #462** (`008d57b2`) |
| Rule-justification map exhaustiveness | a missing key is a compile error | `progressionSuggestions.ts:RULE_JUSTIFICATION_FIELDS` | TS2741 at build time | **LIVE** -- PR #451 landed as `04dd116b`, the commit this file was written against. `npx tsc --noEmit` is clean on `origin/main` as of this writing; if you were told to expect one known error there, that is stale. |

---

## 11. Uploads, rate limits and anonymous surfaces

| Gate | What it checks | Enforced at | Refuses with | Status |
|---|---|---|---|---|
| Three upload paths, one shape | transport check -> descriptor from declared name/type/size -> content-signature check on the bytes -> nothing trusted from the client | `shadowUploadPolicy.ts`, `videoUploadPolicy.ts`, `profilePhotoPolicy.ts` | 415 / 411 / 413 | **LIVE** |
| Per-actor upload budgets | durable per (org, account) buckets by operation kind | `shadowRateLimit.ts:enforceShadowRateLimit` | 429 + `Retry-After` | **LIVE** |
| Public wall budget | per-IP, sized for a TV polling every 30s | `wallRateLimit.ts:consumeWallBudget` | 429 `Too many requests.` | **LIVE** |
| Anonymous write is one route only | the public interest form, with a honeypot field, bounded strings and both limiters | `public-interest/route.ts` | 400 / 429 | **LIVE** |
| Anonymous read holds no child data | the public store selects a `PUBLIC_FIELDS` projection, exposes exactly one verb, and "must never" join to anything about a child | `app/api/public/store/route.ts`, `gearCatalog.ts` | -- | **LIVE** |
| Payment webhook | every event signed with the one platform secret; the account is resolved by lookup, never inferred from the payload | `paymentConnect.ts:verifyStripeWebhookSignature` | 400 for an unknown account | **LIVE** |
| Research bridge export | a dedicated access check, not a session | `researchBridgeAuth.ts:requireResearchBridgeAccess` | its own status; a generic 500 otherwise | **LIVE** |
| No runtime DDL | a build-time check that routes carry no schema statements | `httpRoutesCarryNoDdl.test.ts`, `noRuntimeDdl.test.ts` | a failing test | **LIVE** |

---

## 12. Role-shaped boundaries worth knowing

| Boundary | Rule | Enforced at | Status |
|---|---|---|---|
| Board | organization aggregates only, k-anonymity-gated; never an individually identifiable athlete record | `boardSummary.ts`, `compliance.ts:violationMetric`, `escalationLadder.ts:getBoardEscalationSummary`, pinned by `boardRoleBoundaries.test.ts` | **LIVE** |
| Platform owner | "broader in breadth, strictly narrower in depth" -- refused every athlete-scoped record and every portrait by name | `access.ts:assertActorCanAccessAthlete`, `profileDb.ts:resolveRelationship`, `shadowRoleSets.ts` | **LIVE** |
| Parent | never learns that a safety escalation exists at all | `parent/safety/route.ts`, `escalationLadder.ts` (documented refusal to add a `parent` target) | **LIVE** |
| Coach | may not see `athlete_voice` escalations -- the coach may be who they are about | `escalations/route.ts:GET` | **LIVE** |
| Athlete | may not change their own coach, active flag or gym status | `access.ts:assertAthleteUpdateAllowed` | **LIVE** |
| Privacy tiers as a registry | six tiers named, each pointing at the module that actually refuses; deliberately **not** a table, not an engine, not middleware, not authorization; tiers must never be compared numerically | `privacyTiers.ts`, pinned by `privacyTiers.test.ts` | **LIVE** |
| LEGACY-READINESS / `readinessMath.ts` | registered `support: 'experimental_unsupported'`, `humanReviewRequired: true`, with the reason "Coefficients, input scales, fairness, and clinical/safety validity are unproven. **It must not clear, restrict, or prescribe training.**" Deliberately **unwired by owner decision** -- the only references to it are the registry entry and the id union | `formulas/registry.ts` (the `LEGACY-READINESS` definition), `formulas/types.ts` | **LIVE (as an absence)** -- and must stay that way |

---

## Known gaps

Each of these was verified by reading the code at `04dd116b`. None is fixed by
this document.

### GAP-1 -- a cross-org revoke returns a scrubbed 500, not a 4xx

`auth.ts:revokeAllSessionsForAccountInOrganization` throws
`Account not found or cannot be revoked`. That message starts with `Account`,
which matches **no** branch in `jsonError` -- the 404 branch requires the message
to *start with* `Not found`. It therefore falls into the generic-500 branch and
the caller receives `{"error":"Internal server error"}` at status 500.

The non-disclosure property survives (the response is opaque either way), but the
status is wrong: an admin who mistypes an account id cannot distinguish a bad
request from an outage. `app/api/pilot/admin/accounts/revoke/route.test.ts`
covers the 403 and the 200 only, so nothing pins the current behaviour.

*Fix shape:* throw `NotFoundError` (or `ForbiddenError`) from `errors.ts` with
the same opaque message. Small, and it touches `auth.ts`.

### GAP-2 -- guardian consent scope is collected and never enforced

`pilot.waivers` carries `covers_video` and `public_use_allowed`;
`POST /api/pilot/parent/consent` accepts both and `GET` reports both. **No gate
reads either.** `assertGuardianMediaConsent` checks only `status = 'signed'`.

So a guardian who signs with `covers_video: false` still satisfies the gate for a
**video** publication, and one who leaves `public_use_allowed` false still
satisfies it for a publish into the research library. `guardianConsent.ts`'s
header records this as "a documented MVP cut, not an oversight" -- but the UI
collects the switches as though they were load-bearing, so a guardian believes
they have limited something they have not.

The defaults compound it: `covers_video` defaults to **true**
(`body?.covers_video !== false`).

### GAP-3 -- nothing validates who is attached as a guardian

`POST /api/pilot/intake/domain-upsert` with `entity_type: 'guardian_link'`
(`organization_admin` or `coach`, behind `assertActorCanAccessAthlete` for the
child) calls `intake.ts:upsertGuardian` with an `account_id` taken **straight
from the request payload**. Nothing checks that the id names an account at all,
that it is a `parent`-role account, or that it belongs to this organization.
There is no analogue of `access.ts:assertActiveCoachAccount` -- the gate that
exists on the coverage path for exactly this reason ("a typo'd id is not a bad
reference -- it is access granted to whatever account the typo names").

Because `upsertGuardian` runs
`on conflict (organization_id, parent_id) do update set account_id = excluded.account_id, ...`,
a caller may also **repoint an existing guardian record at a different account**,
overwriting that guardian's name, phone and email in the same statement.

What that account then gains, if its role is `parent`:
`guardianAccess.ts:guardianAthleteIds` returns this child, so
`assertActorCanAccessAthlete` admits them; `profileDb.ts:resolveRelationship`
returns `guardian_of_subject`, which is inside `MINOR_CIRCLE`, so they see the
child's **portrait and ring name**; they can read the child's training hold and
video list; and they can **grant or withdraw media consent** for that child.

The sibling path does not have this gap:
`POST /api/pilot/intake/review-action` runs
`createOrUpdateMicrosoftStaffAccount({ role: 'parent' })` before linking.

*Scope note, so this is not overstated:* the actor must already hold standing
with the child, and a `coach`-role account cannot grant *itself* guardian
visibility -- both `resolveRelationship` and `assertActorCanAccessAthlete` key the
guardian branch on `viewer.role === 'parent'`. The exposure is that an
**arbitrary third account** can be made a guardian of a named child by one API
call, with no check on that account.

*Fix shape:* an `assertGuardianAccount`-style check on the
`domain-upsert` guardian branch, mirroring `assertActiveCoachAccount`; plus a
decision about whether `parent_id` should be caller-supplied at all.

### GAP-4 -- the portrait routes have no route-level tests

There is no `app/api/pilot/profile/**/route.test.ts` anywhere in the tree.
`profileVisibility.test.ts` covers the *decision* thoroughly. The *wiring* --
that `photo/[accountId]/route.ts` really calls `assertViewerMayReachSubject`
before `decidePortrait`, really returns `hiddenNotFound()` rather than the bytes,
really sets `no-store` -- is pinned by nothing. A refactor could reorder those
four gates and every existing test would still pass.

This is the most significant verification gap on the platform's strictest privacy
tier.

### GAP-5 -- coverage bounds one child, not one coach

`access.ts:grantCoachCoverage` refuses a second *overlapping* grant on the same
(athlete, coach) pair. Nothing stops an organization admin issuing simultaneous
grants to one coach across twenty different children, one `POST` at a time --
which reconstructs the roster-wide grant the design deliberately rejected.
Contained by the fact that the actor is already the role that can read every
athlete record in the gym, but the bound is per-child, not per-coach, and no
document said so before this one.

### GAP-6 -- `conditioning_only` holds enforce nothing

`conditioning_only` is a valid `TrainingHoldScope`: it is storable, it files an
escalation, it shows on the athlete's banner and the staff list. **No code path
reads it.** `findRegistrationBlockingHold` narrows to `all_training`;
`flagContactDuringHold`'s scope set is `('all_training', 'contact_only')`; PR
#452's `findContactEventBlockingHold` uses the same pair.

A coach who places a `conditioning_only` hold has recorded an intention and
notified an admin. Nothing in the platform will stop the conditioning.

**Context that makes this fairer, and the finding sharper.** `trainingHolds.ts`'s
header records an owner decision (2026-08-06) splitting the scopes into two
different jobs: `all_training` is **STOP/HOLD** (training pauses until a person
lifts it), while `contact_only` and `conditioning_only` are **REGRESS** --
"training CONTINUES at reduced scope". So a scoped hold was never meant to stop
a session outright, and reading this row as "a gate someone forgot to write"
would be unfair to the design.

The finding survives that context as an **asymmetry**, which is the honest
version: `contact_only` did get an enforcement path -- it is in
`flagContactDuringHold`'s scope set, and PR #452 (merged) added it to competition entry --
while `conditioning_only` got none anywhere. Both are REGRESS scopes; only one
of them regresses anything.

It matters because the reduced scope is stated to a guardian as fact.
`/parent/safety` renders `conditioning_only` as **"Conditioning is paused right
now"**, which is the correct reading of the scope and is exactly what is not
true. A parent is told a restriction is in force that no code enforces.

The honest close is one of two decisions, not a patch: either give
`conditioning_only` an enforcement surface (there is no conditioning-activity
gate in the platform today to hang it on), or stop offering the scope until
there is one. Both are owner calls.

### GAP-7 -- the manual escalation target is unvalidated free text

`compliance.ts:escalateViolation` takes `escalatedToRole: string`;
`app/api/pilot/compliance/escalate/route.ts` requires only that it be non-empty;
and `pilot.violation_escalations.escalated_to_role` is `text not null` with **no
CHECK constraint** -- unlike `pilot.safety_escalations.escalated_to_role`, whose
migration constrains it to `('coach','organization_admin','admin')` and whose
comment explicitly notes the difference.

So an admin can escalate a violation "to parent" or "to board" through this
route -- precisely the two targets the auto-escalation path refuses to file for,
for stated non-disclosure reasons (a board must not see an identifiable athlete
record; a guardian must not learn an escalation exists).

Nothing currently *shows* those rows to a parent or the board, so this is a
data-integrity and audit-honesty gap rather than a live disclosure. It becomes a
live one the day somebody builds a surface that reads
`escalated_to_role`.

Related, smaller: `escalation_reason` **defaults** to
`'Policy violation requires escalation'` when omitted, so an escalation can carry
no human reasoning at all -- the opposite of the rule the same capability applies
to closing verdicts.

### GAP-8 -- coach reads that gate on role but not on the child

Three routes accept a caller-supplied `athlete_id` and check **role only**
(`coach` or `admin`), never standing with that particular child:

- `app/api/pilot/competence-cohorts/route.ts` -- one athlete's assessed levels,
  logged training and derived age.
- `app/api/pilot/multidiscipline/route.ts` -- one athlete's grappling exposure
  history and current participation level. The route's own comment calls this
  "athlete safety data".
- `app/api/pilot/coach/transfer-check/route.ts` -- one athlete's transfer
  readout.

Each is org-scoped, and each comments carefully about *not widening the role
set* -- but any coach in the gym can name any athlete id. Compare
`app/api/pilot/compliance/violations/route.ts`, which calls
`assertActorCanAccessAthlete` for exactly this shape of read.

This sits against a real, recorded doctrine: `app/api/pilot/athletes/list/route.ts`
holds that "a coach plans a floor and picks up cover across the whole gym" and
already exposes every athlete's name and gym status org-wide, restricting only
`dob` and `emergency_contact`. Grappling exposure history is a different kind of
field from a name. Whether these three should narrow is an owner decision, not a
bug fix -- but nothing currently records that the decision was ever made.

### GAP-9 -- unfiltered coach violation list ignores coverage

`compliance.ts:getOrganizationViolations`'s `coachAccountId` filter matches
`athletes.coach_id` only. It does **not** union in `pilot.coach_coverage`, unlike
`app/api/pilot/escalations/route.ts:coachAthleteIds`, which does. A covering coach
who may file a violation about a covered child will not see it in their own
unfiltered list. Not a disclosure hole -- a coverage gap in a read.

### GAP-10 -- no retention clock on video or portraits

Nothing ages a `pilot.video_sessions` row, its blob, or a stored portrait out.
`src/server/pilot/dataDeletion.ts` (and the retention work pinned by
`dataRetentionDeletion.pg.test.ts`) covers other tables. Named here because "we
keep children's video indefinitely" is a policy position, and no code states it
either way.

### GAP-11 -- `getPilotDefaultOrganizationId()` as a silent fallback

`auth.ts:resolvePrincipal` and both login paths use
`row.organization_id || getPilotDefaultOrganizationId()`. An account with a null
`organization_id` is therefore treated as a member of the default gym. On a
single-gym deployment that is correct; on a multi-gym one it is a quiet default
rather than a refusal, and nothing warns. The active-membership join constrains
the damage, but the fallback itself is ungated.

### GAP-12 -- the role-destination map is the de facto sign-in allow-list

`loginWithMicrosoftEmail` refuses a role only because
`getPilotRoleDestination(role)` returns nothing for it. That is an
indirection: a routing table doubles as an authentication policy, and adding
a destination for a new role silently makes it signable-in. Related
deliberate absences: no concurrent-session limit and no device binding — a
stolen cookie works from anywhere within its 24-hour life.

---

## Maintaining this file

- **Status is the load-bearing column.** When a PR merges, move its rows to
  **LIVE** and delete the PR marker. When a gap is closed, delete the GAP entry
  and add the gate.
- **Verify, do not infer.** Every LIVE row above was read in the source at
  `04dd116b`. A row copied from a ticket is worse than no row.
- **A gap is a first-class entry.** "An honest empty section beats an invented
  gate" applies here too: the GAP rows are the reason this index is worth
  keeping.
- **This file is not authority.** Current executable code describes current
  behaviour (`AGENT_KERNEL.md`, source hierarchy). If they disagree, the code
  wins and this file is wrong.
