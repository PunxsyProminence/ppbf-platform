# Branch salvage triage, 2026-09-29

History, not a plan. Before the eleven leftover GitHub branches listed below were deleted (Jason 2026-09-29, "QA A, QB A", OD-2026-09-29-002 item 4), each was read against `main` at `91de82ca` and every change on it was sorted into one of seven kinds. This file is that sort, moved here from a session scratch file so it survives the branches. The branch code itself survives only in the local git bundle named in OD-2026-09-29-002 item 4. Line citations are to the commit named in each entry and will drift.

Where each kind went: **Bug on main** items were fixed by PRs #1004-#1007, or by #1015 and #1016 (open when this was written). **Owner question** items: three were put to Jason and answered (birth date, OD-2026-09-29-003 Q2 and -004 P2; the 20% floor and school standing, OD-2026-09-29-003); the name-and-birth-date block was not put to him and is an open question on `docs/current/ACTIVE_WORK.md`. **Code worth redoing** and **Idea** items are not built and not scheduled, and have no row on `docs/current/ACTIVE_WORK.md` unless Jason adds one; the exception is the admin People page's blank ID box after switching mode, a live bug, which is on the build list. **Document** items are copied into this folder (see `README.md`). **No longer a bug** and **Dropped** say why nothing was kept.

## `claude/ppbf-platform-audit-w3va0j`

### Bug on main: Login response time reveals which sign-in IDs are real

Main answers a wrong sign-in ID almost instantly, but it takes a clearly slower PIN check when the ID belongs to a live athlete. Someone outside the gym can time the replies and learn which athlete sign-in IDs are real before they start guessing PINs. The risk is low because rate limits still apply, and the fix is small.

Evidence: OBSERVED main 91de82ca apps/web/src/server/pilot/auth.ts:180 returns on unknown/inactive before any hashing; :191 returns on no pin_hash; :200 returns on the retired 123456; only :205 runs verifyPin (scrypt, security.ts:17-32). So 'no such account' skips scrypt and 'live account + wrong PIN' pays it: a measurable gap on the unauthenticated /api/pilot/auth/login (login/route.ts:92). Sign-in IDs are admin-typed (admin/people/page.tsx:1737-1747), so they are guessable. Rate limits (login/route.ts:48-88) slow the probing but do not remove the signal.

Sketch: In loginWithAccountIdAndPin, compute one dummy scrypt hash lazily (hashPin of random bytes, cached in a module variable), then run verifyPin(pin, data?.pin_hash ?? dummy) BEFORE the rejection branches. Keep main's reason-code console.warn lines and the retired-123456 refusal, and just evaluate them after the hash runs. Do not copy the branch version (7628ec60 auth.ts), which drops those logs and reorders the checks. Add a unit test showing verifyPin is called for an unknown account.

### Owner question: Athletes can change their own date of birth, name and weight class

On main, a signed-in athlete can send a request that edits their own name, date of birth and weight class. No screen offers this, but the server allows it. Date of birth is the serious part: a 14-year-old who sets an adult birth date turns off the minor photo circle and the guardian-signature rule for the wall display. Recommend locking date of birth for athletes, and deciding on name and weight class.

Evidence: OBSERVED main: athletes/update/route.ts:43 admits role 'athlete'; access.ts:562-608 (assertAthleteUpdateAllowed) blocks athletes only on coach_id, active_flag and gym_status; athletes/get/route.ts:12 lets the athlete read their own record to build the payload. DOB drives isMinor in profileVisibility.ts:161 (minor photo only to own coach and guardian; adult also to org staff), profileVisibility.ts:218 (ring name), wallDisplay.ts:266 (guardian signer required only for minors), competenceCohorts.ts:17/375 (contact-eligibility age). The only screen calling the update route is admin/athletes/page.tsx:404 (admin). Changing this changes who may do what, so it is Jason's call.

Sketch: If yes: in assertAthleteUpdateAllowed, refuse athlete changes to dob (plus full_name and weight_class if chosen). Compare DOB with the same Date-to-YYYY-MM-DD normalizer update/route.ts:30 uses (comparable). The branch's raw `before.dob !== after.dob` (branch access.ts) would refuse EVERY athlete save, because node-postgres returns dob as a Date. The simpler option is to drop 'athlete' from update/route.ts:43, since no athlete screen uses it. Add route tests for each refused field.

### Code worth redoing: Server does not check that an athlete's coach is an active coach in the gym

When an athlete is created, edited or promoted from intake, the server accepts any account as the coach. The screens only offer active coaches, so nobody hits this through the app. A bad value still either fails with an unclear error or leaves the athlete with no coach who can see them. Main already has the right check, it just isn't called here, and the roster-loading work from ruling 3B will need the same check.

Evidence: OBSERVED main: athletes/route.ts:14-33 (create) and athletes/update/route.ts:43-54 never validate coach_id; intake/review-action/route.ts:412 writes promotion.athlete.coach_id unchecked (route admits coach, :71). Only the FK pilot_athletes_coach_fk exists (infra/azure/pilot_slice_postgres.sql:74), which accepts any account in any gym. access.ts:178-195 assertActiveCoachAccount already exists (used by scheduler/route.ts:770). UI limits choices to active coaches (admin/people/page.tsx:358-360), and people/page.tsx:277-279 notes an FK miss surfaces as an opaque 500.

Sketch: Call assertActiveCoachAccount(orgId, coach_id, 'coach_id') in athletes POST, in intake promotion before upsertAthlete, and in update ONLY when coach_id changes. A deactivated coach who is already assigned must stay saveable (admin/athletes/page.tsx:349-357). Reuse it in the 3B roster-load path. Do not port the branch's getCoachById or its org-admin-only change.

### Code worth redoing: One shared gym-status list, checked on the server

The three gym statuses (active, training, inactive) are copied in three places, and the server accepts any text for them. The screens only offer the three, and nothing in the app branches on the value, so nothing breaks today. Merging them into one list with a server check is a small cleanup.

Evidence: OBSERVED main: private copies in admin/people/page.tsx:109, admin/athletes/page.tsx:78, rosterImport.ts:174; validation.ts:137 uses requireString for gym_status (any text) on create/update; intake promotion writes it unchecked (review-action/route.ts:409). The only logic reading it compares before and after (access.ts:606). admin/athletes/page.tsx:756-757 already shows an out-of-list value as '(as stored)'.

Sketch: Add src/shared/athleteConstants.ts with the list and an isGymStatus guard (the branch file is a fine model), import it in both pages, rosterImport and validation.ts (400 naming the field), and check it in intake promotion. Keep the '(as stored)' option so old rows still open.

### Code worth redoing: 'Last corrected by / when' line on the athlete record screen

The branch showed, on each athlete record, who last corrected it, when, and which fields changed. It shows field names only, never the values. Main already records this in the audit trail but no screen shows it on the record. It is useful when fixing a child's record, and not a bug.

Evidence: Main admin/athletes/page.tsx has no audit read (grep for 'audit/get|lastCorrection' hits only app/audit/page.tsx). Main athletes/update/route.ts writes changed_fields and active_flag_change to the audit trail, and /api/pilot/audit/get exists (org admins org-wide). Branch implementation: origin/claude/ppbf-platform-audit-w3va0j apps/web/app/admin/athletes/page.tsx (loadLastCorrection, uses formatGymStamp). It will not merge cleanly onto main's rewritten page.

Sketch: Re-add to main's athletes page: on select, POST audit/get {entity_type:'athlete', entity_id, limit:1}, show actor, gym-time stamp and field labels, say 'history unavailable' on failure, and refresh after save. If the newest row should be an update only, filter to event_type 'update'.

### Idea: Roster admin ideas: move all of a coach's athletes when the coach leaves, and more

The branch's review listed roster ideas main still lacks. The main one: when a coach leaves, move all their athletes to a new coach in one step instead of one at a time. Others: a per-gym weight-class list, the coach's name (not their ID) on the athlete record, and filtering the roster by coach or status.

Evidence: Branch DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md sections 3 P2-5, P2-6 and P3. Main has no bulk reassign (grep 'reassign' finds only per-record editing, admin/athletes/page.tsx:479). The athlete list shows the raw coach ID (admin/athletes/page.tsx:579). The roster filter matches name and ID only (admin/athletes/page.tsx:345-346).

Sketch: Record as a build-list row. Bulk reassign = an org-admin action: pick the departing coach, pick an active coach, then one audited update of pilot.athletes.coach_id for that gym, using assertActiveCoachAccount on the target.

### Document: The Aug 3 security audit and the roster-record review

Keep the two written reviews as history only. Most of the security report's 'high' findings turned out not to be real, or are already handled on main. The four 'medium' findings are one-line notes with no location, and nobody has checked them.

Evidence: Branch files SECURITY_AUDIT_REPORT_2026-08-03.md (6 high, 4 medium findings; medium 7-10 say 'Location: TBD' or name only an area) and DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md (roster record review, P0-P3). This triage found: finding 2 (timing) real; 1, 3, 4, 5 and 6 not real or harmful (see other items). Spot check: finding 7 is already shape-checked on main (shadow/medical-status/route.ts:128-135).

Sketch: Copy both files into the archive, marked evidence and not app source, with a note pointing to this triage.

### No longer a bug: Shared 123456 starting PIN and the athlete-shell takeover

Main fixed both another way. New athletes get a one-time activation code and choose their own PIN, 123456 is refused at login, and the platform owner's 'athlete shell' is now an inert account that nobody can sign in to. The branch's per-athlete random PIN and its screen changes are superseded.

Evidence: OBSERVED main: auth.ts:200 refuses 123456 at login; auth.ts:628-705 createAthleteAccount writes pin_hash null, active_flag false ('The shell is INERT', :675), with the athlete-in-gym check at :645; platform/athlete-shell/route.ts:41 calls it; admin/athlete-accounts/route.ts and admin/accounts/pin-reset/route.ts both issue activation codes via provisionAthleteActivation. Minor leftover: createAthleteAccountPendingActivation (auth.ts:848) lacks the athlete-in-gym check. Its only caller, platform/users/create/route.ts (org admin, gym from session), has no screen calling it, and the unique index uq_pilot_accounts_org_athlete blocks double-linking.

Sketch: None required. Optional tiny: copy the 'Athlete not found in organization' check (auth.ts:637-646) into createAthleteAccountPendingActivation.

### No longer a bug: Colliding athlete ID message, 'add a coach first' prompt, PIN-screen cross-links

Main already names the athlete who holds a typed ID and suggests the next free ID. It already tells the admin to add a coach first when the gym has none. The branch's PIN cross-link text describes a random-PIN reset that main no longer has.

Evidence: OBSERVED main: admin/people/page.tsx:420-430 suggests the next ath-NNN, :448-455 collidingAthlete names the existing athlete before submit, :1653-1655 shows 'No coaches in your gym yet ... add a coach' text; admin/pin/page.tsx:23 says pin-reset now reads only account_id and returns an activation code.

Sketch: None.

### Dropped: Making athlete creation org-admin only

The branch took away a coach's ability to add athletes. An AI made that call, not Jason, and his 3B ruling goes the other way: coaches loading a roster may assign athletes to any active coach. Don't bring it back.

Evidence: Branch commit f9c573fb changed athletes/route.ts requireRole to ['organization_admin']; branch DEEP_IMPROVEMENT_AUDIT_CAPABILITY_2.md P0-1 records it as 'Decision' with no owner quote. Main athletes/route.ts:14,19-21 lets a coach create athletes assigned to themselves. Binding ruling 3B (2026-09-29) lets a coach loading a roster assign rows to any active coach in the same gym.

Sketch: None.

### Dropped: Branch's bootstrap-key compare change (would let anyone in when the key is unset)

Do not bring this back. When the operator key is not configured, the branch version accepts a header made of 64 'x' characters as a valid key. Main's version is correct. It only reveals the key's length, which does not matter for a long random key.

Evidence: Branch security.ts bootstrapKeyMatches: expectedOrDummy = expected || 'x'.repeat(64); providedOrDummy = provided || ...; timingSafeEqual(provided, expectedOrDummy). With the key unset and x-ppbf-bootstrap-key = 'x'*64, it returns true. OBSERVED main security.ts:54-70 returns false when either side is empty and uses timingSafeEqual after an equal-length check.

Sketch: None.

### Dropped: Cookie HTTPS detection, startup refusal without durable rate limits, SSL-disable guard

None of these can fire on the real deployments. Every deployed container already marks cookies Secure. Staging and production already set durable rate limiting, and main reports it on the readiness check. Main already ignores the 'disable SSL' flag outside tests.

Evidence: OBSERVED main: Dockerfile:23 and :65 set ENV NODE_ENV=production for the built image (staging and prod), so login/route.ts:136 and the other auth routes set secure:true; deploy-production.yml:705 and deploy-staging.yml:359 set PPBF_DURABLE_RATE_LIMIT=true; pilotOpsReadiness.ts:141-150 reports it when missing; db.ts:53-65 resolveSslConfig honours the disable flag only with NODE_ENV=test (or the loopback offline launcher). The branch's own SECURITY_FIXES_APPLIED.md says 'Neither check can fire on a correctly configured deployment'. Its production-mode check would also stop a local `next start` that lacks the flag.

Sketch: None.

### Dropped: Placeholder isolation tests, extra timezone tests, and the branch's own work-queue and process docs

The 'organization isolation' test file is mostly `expect(true)` placeholders and proves nothing. The multi-timezone birth-date tests guard a helper main already has. The work-queue, fix-list, task-queue and 'fixes applied' notes only track this branch's own progress and are now out of date.

Evidence: Branch apps/web/src/server/pilot/organizationIsolation.test.ts:77,97,116,135,152,171 are `expect(true).toBe(true)`. Main athletes/update/route.ts:24-38 has the comparable() DOB normalizer, with a test at update/route.test.ts:100. Branch TASK_QUEUE_AUDIT_IMPROVEMENTS.md, SECURITY_FIXES_APPLIED.md, and edits to docs/WORK_QUEUE.md and docs/FIX_LIST_2026-08-02.md record branch claims and statuses (e.g. the 'FIXED on this branch' starting-PIN entry) that main superseded.

Sketch: None.

## `copilot/vscode-mt00rxqp-4f0h`

### Bug on main: A question over 12,000 characters gets the reply 'Enter a question for SHADOW.'

If a coach pastes a long question (over 12,000 characters), SHADOW answers 'Enter a question for SHADOW.' instead of saying the question is too long, and the text box is emptied. The branch does not fix what the coach sees: it only changes a hidden field the page never displays.

Evidence: OBSERVED on main 91de82ca. apps/web/app/api/pilot/shadow/chat/route.ts:552 rejects rawMessage.length > MAX_MESSAGE_LENGTH (12_000, :163) in the same check as an empty message, and :569 returns response 'Enter a question for SHADOW.' (the error field at :576 is generic). apps/web/app/shadow/page.tsx:186 shows payload?.response before payload?.error, so the user reads 'Enter a question for SHADOW.'; :1212-1214 has already cleared the input; the composer textarea at :1835-1849 has no maxLength. No test on main covers the over-length path (git grep for the copy finds only route.ts). The branch (bbdc7e50) put a per-field reason in `error` only, which the page never shows.

Sketch: In route.ts, split the over-length case out of the combined check and return its own response copy, e.g. 'That question is too long for SHADOW (limit 12,000 characters). Shorten it and send again.' Export MAX_MESSAGE_LENGTH from a shared module and set maxLength on the shadow/page.tsx composer (optionally a character counter near the limit). Add one route test for a 12,001-character message.

### Code worth redoing: Move (or delete) the three unusable PIN-account helpers out of auth.ts

Main's login module still exports three old helpers that create coach/parent/admin accounts nobody can sign in with; only tests use them. The branch moves them to their own file. Worth doing, preferably by deleting them and having the tests insert the rows directly. It is a tidy-up, not a user-facing bug.

Evidence: OBSERVED main 91de82ca apps/web/src/server/pilot/auth.ts:895 createCoachAccount, :939 createParentAccount, :983 createOrRotateAdminAccount (marked @deprecated). Only callers: auth.revocation.test.ts:21-25,68-88 and sessionExpiry.migration.pg.test.ts:697-770; review-action/route.test.ts:25 still mocks createParentAccount though route.ts:4 no longer imports it. The branch's move (28772035) also makes auth.ts export two internal transaction helpers (revokeAllSessionsForAccountTx, assignOrganizationMembershipTx), which widens the login module's surface.

Sketch: Preferred: delete the three helpers from auth.ts; in the pg suite seed the legacy coach/admin rows with rawQuery inserts (the suite already has rawQuery); drop the three unit tests that only exercised the helpers' revoke-on-update; remove the stale createParentAccount mock in review-action/route.test.ts. Alternative: move them to a test-only fixtures file without exporting the Tx helpers from auth.ts. Redo against main; the branch commit is on an old base.

### No longer a bug: The 'CRITICAL LOG ERROR ... Head Coach Jason' blocker message and its warning log

The branch reworded SHADOW's scary 'CRITICAL LOG ERROR' refusal and logged when it fired. Main already replaced that message and rebuilt the logic: it now refuses only when the Library is truly empty, and logs that case itself.

Evidence: OBSERVED main 91de82ca route.ts:165-180 (comment quoting the old string, replaced by EMPTY_LIBRARY_RESPONSE; commit f5d4fa42 'SHADOW answers and labels instead of showing a crash string'); route.ts:1161-1174 libraryEmpty check with console.error 'SHADOW library holds no retrievable evidence'. The branch's hallucinationBlocked variable and V21_HALLUCINATION_BLOCKER_RESPONSE no longer exist on main.

Sketch: None.

### No longer a bug: Global Command Switcher gating and removal of the Winter Grit nav

The branch hid the mock 'Global Command Directory' in production and deleted an unused nav component. Main has since deleted both files.

Evidence: OBSERVED: git ls-tree main 91de82ca has neither apps/web/src/components/core/GlobalCommandSwitcher.tsx nor WinterGritGlobalNav.tsx; both deleted by 35272aa6 'The director dashboard stops inventing safety incidents'. No remaining references (git grep, apps/, no hits).

Sketch: None.

### Dropped: Request ID on every SHADOW error reply, plus a warning log naming why a request was rejected

The branch adds a tracking ID to error replies and logs the rejection reason. No screen shows the ID, and main's own error logs don't carry it, so nothing links a coach's report to a log line. Not worth carrying as written; if support tracing is wanted later, do it once for the whole app.

Evidence: Branch bbdc7e50 + bd9c96f6 (route.ts resolveRequestCorrelationId, requestCorrelationId on each error body, console.warn 'shadow-chat-request-validation-failed'). Main 91de82ca has no x-request-id/traceparent handling anywhere in apps/web (git grep, no hits). apps/web/app/shadow/page.tsx:182-187 reads only payload.response/error, so the ID never reaches the user. The branch also copies an unchecked, unlimited-length client header (x-request-id / traceparent) into the response and logs.

Sketch: None now. If request tracing becomes a real need: one middleware that sets a server-generated ID (ignore or length-cap client headers), puts it on every log line and error body, and has the UI show it on error.

### Dropped: 48 KB size cap on SHADOW messages

The new 48 KB limit can never trigger: the existing 12,000-character limit already caps a message at about 36 KB, so this is dead code.

Evidence: Branch bbdc7e50 adds MAX_MESSAGE_BYTES = 48_000 checked after the 12,000-length check. OBSERVED (node, TextEncoder): 12,000 UTF-16 units encode to at most 36,000 bytes ('ࠀ' x12000 = 36000; lone surrogates x12000 = 36000; emoji x6000 = 24000). Main route.ts:163 keeps the 12,000 limit.

Sketch: None.

### Dropped: next-env.d.ts and package-lock.json changes

Machine-generated file churn from the editor session. Main already has what matters.

Evidence: Branch 0538f2bc changes next-env.d.ts (auto-generated by Next.js; main's copy already differs, adding a root-params import) and adds @next/swc-* entries to package-lock.json for next 16.2.9; main's package-lock.json already has all eight @next/swc-* entries (lines 4448-4560) for next 16.3.2.

Sketch: None.

## `claude/corpus-coverage-gaps-awq7aw`

### Bug on main: Capability coverage says 'covered' for evidence search cannot serve

The Library's coverage check counts any registered source, even one still waiting for review, not indexed, or pulled for retraction. A capability can read 'covered' while search returns nothing for it, and because it reads covered, no research gap ticket is opened.

Evidence: OBSERVED on main 91de82ca: apps/web/src/server/pilot/shadowLibrary.ts:1397-1407 (recompute) and :1491-1501 (listShadowCapabilityCoverage) match sources on s.status='active' + authority tier + source type ONLY. Retrieval requires far more: :1078-1087 and :1172-1181 add approval_state='approved', verification_state='verified', not retrieval_suppressed, and an indexed/approved/verified document. createShadowLibrarySource defaults status to 'active' (:488) while approval_state defaults to 'pending_review' (infra/azure/pilot_slice_postgres_shadow_evidence_migration.sql:7). ensureCoverageGapResearchRequirement returns early for 'covered' (:405), so no gap ticket opens. Real-user path: ppbf@ org admin runs npm run seed:shadow:library (apps/web/scripts/seed-shadow-library.mjs:327-338) -> 4 doctrine sources registered pending_review -> recompute returns 'covered' for the shadow.doctrine.* rules, while the same script prints 'everything registered is pending_review. Approve it at /evidence before SHADOW can cite it.' A retracted source also keeps its capability covered. Main's own tests pin this fail-open: shadowLibraryPipeline.pg.test.ts:427-443 expects 'covered' right after the :389 test shows search returns 0 results; shadowLibraryCoverage.pg.test.ts (added on main after the branch point) seeds bare status='active' sources via seedActiveSource (:120) and expects covered/partial (:221, :240). Main's log since the branch point has no predicate change (only the batched-UPDATE rewrite).

Sketch: Redo by hand; a cherry-pick will not apply cleanly because main rewrote recompute as a batched unnest UPDATE and added shadowLibraryCoverage.pg.test.ts. (1) Pull the matched-sources subquery into one shared SQL constant used by both recompute (:1397) and list (:1491), adding what retrieval requires: s.approval_state='approved', s.verification_state='verified', not coalesce(s.retrieval_suppressed,false), and exists a document with ingest_state='indexed', index_completed_at not null, approval_state='approved', verification_state='verified' (the branch's COVERAGE_MATCHED_SOURCES_SQL at 3a193bc3). (2) Update shadowLibraryPipeline.pg.test.ts:427-443 to assert uncovered while the document is withdrawn, then covered after re-index and re-approval (as the branch does). (3) Change seedActiveSource in shadowLibraryCoverage.pg.test.ts to seed an approved/verified source plus an indexed approved document, and add one negative case (active but pending_review -> uncovered). Build-time choice to decide: retrieval also reads the __platform__ baseline (libraryRetrievalOrganizationIds, platformLibraryScope.ts:35), but coverage (on main and on the branch) counts only the gym's own sources. To truly match 'what search can serve', also count baseline sources. INFERRED: without that, a gym rule reads 'uncovered' when approved baseline evidence would answer it. Expected effect: capabilities backed only by pending_review sources move covered -> uncovered, and each opens one research requirement.

### Bug on main: Research-bridge export still ships retracted sources (found while checking, not branch work)

When a source is pulled for retraction, search stops using it, but the research-bridge export still includes its text under 'approved evidence'. This is the same kind of hole as the coverage bug. The branch did not touch it; I found it while checking.

Evidence: OBSERVED on main 91de82ca: apps/web/src/server/pilot/shadowLibrary.ts:589-628 listApprovedGlobalEvidenceForResearchBridge says it 'reapplies the same source + document approval gate used by Library search', but its WHERE clause (:616-624) has no 'not coalesce(s.retrieval_suppressed, false)'. Search has it at :1082 and :1176, and so does shadowEvidence.ts:101. The column comment (infra/azure/pilot_slice_postgres_retraction_surveillance_migration.sql:169-170) says suppressed sources are 'Excluded from retrieval and citation while true.' Caller: researchBridgeExport.ts:162 -> approved_evidence in the export served by app/api/pilot/shadow/research-bridge/export/route.ts and session-export/route.ts. Failure: an admin suppresses a retracted peer-reviewed source via /api/pilot/admin/retraction-checks, and the next bridge export still lists its excerpt as approved evidence.

Sketch: Add 'and not coalesce(s.retrieval_suppressed, false)' to the export WHERE clause. Better: share one servable-source predicate with search and coverage (item 1) so the three cannot drift again. Add one pg or unit test: a suppressed source is absent from buildResearchBridgeExport().approved_evidence.

### Owner question: Should 'covered' require boxing-specific evidence (the 20% floor)?

The research maps say a capability counts as covered only if at least 20% of its evidence is boxing-specific, but the app never checks that. It only counts sources. Do you want the app to enforce a boxing-specific share, or keep plain source counting?

Evidence: OBSERVED on main 91de82ca: coverage is graded on a raw count against minimum_source_count (shadowLibrary.ts:1414-1416); no code references boxing_ratio or a floor (git grep over apps/web/src, app, scripts returned nothing). 2026-08-07/README_RESEARCH_INTAKE_SEED.md calls the 20% floor a 'PROPOSED PPBF PARAMETER — REQUIRES VALIDATION'. Chunks already carry metadata.boxing_specificity (read in search at shadowLibrary.ts ~:1070). Recorded by the branch in NOT_LOADABLE.md; the branch does not implement it. This is a product rule about when the Library may call a capability covered, so it is Jason's call.

Sketch: If yes: add a minimum_boxing_share column to the capability map (default null = off), compute the boxing-specific share over the same servable-source set as item 1, and grade partial when below it. Seed the value per capability from the 08-07 map. If no: record in OWNER_DECISIONS that coverage stays count-based, and strike the floor language from the seed READMEs so it stops reading as live policy.

### Code worth redoing: Seed importer should reject unknown coverage verdicts

The research seed importer accepts any word in the coverage column, and the database has no check on it. The current seed file is clean, so nothing is broken today. A typo in a future seed would quietly drop a capability out of the 'blocking' list.

Evidence: OBSERVED on main 91de82ca: apps/web/scripts/import-shadow-research.mjs:437 uses required(row.coverage_state, ...), a non-empty check only. The column is 'coverage_state text not null default unknown' with no CHECK (infra/azure/pilot_slice_postgres.sql:229). The triage view keys on cm.coverage_state in ('partial','uncovered') (infra/azure/pilot_slice_postgres_research_triage_view_migration.sql:27), so a value like 'mostly_covered' would silently leave the 2_BLOCKING_CAPABILITY tier. The loaded 2026-08-07 map uses only legal values (OBSERVED: covered 19 / partial 10 / uncovered 1), so this is latent, not live. Branch version: be5f6dee adds COVERAGE_STATES + parseCoverageState.

Sketch: Add a COVERAGE_STATES set mirroring ShadowCoverageState (shadowLibrary.ts:45) and a parseCoverageState() that throws INVALID_COVERAGE_STATE:<value>, used at import-shadow-research.mjs:437, plus the branch's one unit test. Optional, stronger: a CHECK constraint on the column via a migration. Related, INFERRED: the importer writes these precomputed verdicts with last_evaluated_at=now() into the __platform__ map, which no session can recompute, so after item 1 those stored verdicts will not match the new rule until someone re-evaluates them.

### Document: NOT_LOADABLE.md: why the 08-08 capability map is not a newer version of the loaded one

This note explains that the 08-08 coverage numbers were calculated a different way from the loaded 08-07 ones, so comparing them is misleading. Main already says 08-08 can't be loaded but not why the numbers can't be compared, so it's worth keeping. Main's 08-07 README currently calls 08-08 a recompute of the same map, which this note contradicts. You decide which framing stands.

Evidence: Branch path apps/web/seed-data/shadow-research/2026-08-08/NOT_LOADABLE.md (be5f6dee), absent on main. Spot-checked on main's CSVs (OBSERVED): 08-08 _boxing_ratio = boxing_usable/(usable+contested) on 30/30 rows; 08-07 = boxing_usable/usable on 29/30 (the doc says 30/30; one row off within rounding). The four runtime columns (required_source_types, minimum_authority_tier, minimum_source_count, feeder_tracks) are identical between the two maps. No code on main references boxing_ratio or any 20% floor (git grep over apps/web/src, app, scripts). Stale versus main: it quotes the 08-08 README as 'PROPOSED. Nothing applied.' and says that README lists seed_drill_stop_rules.csv as if it were here. Main rewrote that README to say it is unloadable and that the stop-rules file lives in ../../drill-library/. Conflict to surface: main's 2026-08-07/README_RESEARCH_INTAKE_SEED.md says 'The 2026-08-08 package recomputed this map after a parsing-bug fix...', which frames 08-08 as the same map recomputed; NOT_LOADABLE.md says the two are not comparable.

Sketch: Archive as-is, with a one-line header noting the two stale README references. If Jason wants it live instead, merge sections 'Why the capability map here cannot be compared' and 'The 20% boxing-specificity floor is not enforced anywhere' into README_PENNSTATE_INTEGRATION.md and correct the 08-07 README's 'recomputed this map' sentence.

### Document: UNINGESTED_EVIDENCE_2026-08-17.md: research leads sitting outside the corpus

This is a dated read-through of the research folders from 08-17. It lists paper IDs worth acquiring (strongest: a boxing performance-analysis template and a combat-athlete attentional-focus study), duplicates and mislabeled files, and problems with the folders themselves. Worth keeping as a research-backlog source. One section describes one named athlete's personal training plan and belongs in Club Operations, not the code archive; it is why the file was not copied here.

Evidence: Branch path docs/current/UNINGESTED_EVIDENCE_2026-08-17.md (238c4c7a, revised 115c35aa), 229 lines, absent on main (git grep for its key terms on main finds no equivalent). Its contents are REPORTED as of 2026-08-17 about the OneDrive/SharePoint intake tree, not the repo. By its own label, none of the DOIs/PMIDs has been resolved against a publisher record. The 'owner position' that R15 aquatics stays dormant is attributed to a manifest in the tree; it is not in docs/current/OWNER_DECISIONS.md on main (grep returned nothing). The 115c35aa revision separates youth water safety, adult water readiness and weight cutting, and withdraws the earlier 'unsourced aquatic protocol / highest-risk' framing; keep that revision, not the first one. Personal data: one section and one listed defect describe a named athlete's personal plan.

Sketch: Archive the 115c35aa version. Suggested split, per the storage rules: identifiers and folder defects -> research backlog (OneDrive .../REVIEW_REQUIRED/PPBF_FULL_APP_RESEARCH_BACKLOG_NOT_BUILD_SOURCE/, marked NOT APP SOURCE); the named-athlete section -> SharePoint Club Operations, or drop it from any GitHub archive copy. Verify each identifier with verify-research-citations before any citation.

### Dropped: Test pinning the seed map at 19/10/1

This test fails if someone swaps the loaded capability-map file for the 08-08 copy. Loading that folder is already blocked three ways, and this test has never caught anything, so it isn't worth keeping.

Evidence: Branch be5f6dee adds a test asserting the 2026-08-07 map is covered 19 / partial 10 / uncovered 1. On main 91de82ca the 08-08 folder is already unloadable: DEFAULT_SEED_DIR is hardcoded to 2026-08-07 (import-shadow-research.mjs:14-17); EXPECTED_COUNTS pins the file set (:19-25), and 08-08 holds only one of the five required CSVs (git ls-tree); main's README_PENNSTATE_INTEGRATION.md status line says the importer cannot load it. The only thing the test would catch is a hand-edit of the capability-map file inside 08-07, which is hypothetical.

Sketch: None.

## `claude/admin-athlete-id-autofill`

### Bug on main: Retry after a failed sign-in step makes a second record for the same child when the ID was auto-filled

If you accept the filled-in record ID and the sign-in step fails (say the sign-in ID is already taken), the page reloads and the ID box quietly moves on to the next number and unlocks. The error message says the record "will not be created twice", but when you fix the sign-in ID and press the button again, it creates a second record for the same child. That child's sessions and goals then end up split across two records.

Evidence: OBSERVED by reading the code on main 91de82ca (not run; read-only task). apps/web/app/admin/people/page.tsx on main: :445 effectiveAthleteId = athleteMode==='existing' ? athleteId : athleteIdTouched ? athleteId : suggestedAthleteId -- never looks at rosterCreatedFor; :420-429 suggestion is recomputed from the roster (highest ath-NNN + 1); :727 recordId = trimmedAthleteId, and nothing sets athleteIdTouched/athleteId at submit (setAthleteIdTouched only at :664 reset and :1510 onChange); :739 setRosterCreatedFor('ath-005'); account POST fails (e.g. 409 'Account already exists', http.ts:197); :783-785 catch calls load(), which (:335-337) reloads the roster -- the directory route lists every pilot.athletes row via left join (athlete-pin-directory/route.ts), so ath-005 is now in it and the suggestion becomes ath-006; :497 athleteDetailsLocked = rosterCreatedFor === trimmedAthleteId -> 'ath-005'==='ath-006' false, so the details unlock; :792 error text still says 'details are now locked ... it will not be created twice'. Admin fixes the sign-in ID and resubmits: :732 recordExists = rosterCreatedFor === 'ath-006' -> false, :737-738 createAthleteRecord('ath-006') writes a second row; the account links to ath-006 and ath-005 is left orphaned. Only guard left is the name-only warning at :1532-1539, which never blocks. No main test covers this path (main page.test.tsx tests at :402-535 list no retry case). Branch fixes it: branch page.tsx effectiveAthleteId adds '!rosterCreatedFor' and addAthlete pins the id into state before the first write ('if (!athleteIdEdited) { setAthleteId(recordId); setAthleteIdEdited(true); }').

Sketch: In addAthlete on main (page.tsx ~:727), when athleteMode==='new' && !athleteIdTouched, call setAthleteId(recordId) and setAthleteIdTouched(true) before createAthleteRecord, so the id that was actually written stays in the box across the reload; the lock at :497 then holds and :732 skips the re-create. Belt-and-braces: at :445 return athleteId (not the suggestion) whenever rosterCreatedFor is set. Test: account POST returns 409 once then ok; assert exactly one POST to /api/pilot/athletes, both account POSTs carry athlete_id 'ath-003', and the details fieldset is disabled after the first failure. That test also covers 'submits the suggested id the admin never touched', which main has no test for.

### Bug on main: ID box claims 'next free one for your gym' when the roster could not be read

If the gym roster fails to load, the form still fills in ath-001 (or a guess from an old list) and says it is the next free ID for your gym. The page cannot know that. If the ID is taken, the server refuses it and nothing is written, so no data is lost. But the screen says something false, and the admin has to guess again.

Evidence: OBSERVED (code reading, main 91de82ca). page.tsx :227 roster starts as []; :338-340 a failed roster read sets rosterAvailable=false and leaves roster as it was (empty on first load, stale on a later reload); :420-429 suggestedAthleteId has no rosterAvailable check, so it returns 'ath-001' on an empty list; :1495-1502 helper text renders 'Filled in with the next free one for your gym (ath-001)'; :453-456 the collision warning reads the same empty/stale rosterById, so it cannot catch a clash. Harm is limited: apps/web/app/api/pilot/athletes/route.ts:30-32 is create-only and throws 'Athlete record already exists', which becomes a 409 and the message at page.tsx:707-710 ('Nothing was changed'). Branch fix: 'if (!rosterAvailable) return '';' at the top of suggestedAthleteId, plus the test 'suggests nothing when the roster could not be read'.

Sketch: page.tsx:420 -- start suggestedAthleteId with 'if (!rosterAvailable) return '';' and add rosterAvailable to the deps. Then an empty suggestion leaves the box blank, and 'Still needed' already lists 'Athlete record ID' (:538). At :1495, show the 'Short and unique, like ath-001' copy when athleteIdTouched || !suggestedAthleteId, so it never prints 'next free one (… )' with an empty value. Test: rosterOk:false -> record ID field value ''.

### Owner question: Block the add when name AND birth date match someone already on the roster (needs every child's DOB sent to the admin page)

The branch changes the duplicate-child check from a warning into a hard stop when the name and birthday both match. To do that, it sends every child's date of birth to the admin's browser. Main chose the opposite on purpose: match on name only, warn but never block, and keep birthdays out of that list. This changes what child data the page receives and adds a new rule for the form, so it is your call. My recommendation: keep main's version. If you want the sharper match, do the birthday comparison on the server, so the browser only hears 'possible duplicate: ath-005' and never gets the list of birthdays.

Evidence: Branch: apps/web/app/api/pilot/admin/athlete-pin-directory/route.ts adds 'ath.dob::text as dob' to the directory payload; branch page.tsx adds duplicateChild (name+dob match) gating canSubmitAthlete until a 'different child' checkbox is ticked. Main 91de82ca: page.tsx:458-479 records the deliberate opposite choice ('NAME ONLY, deliberately ... Adding every child's birthday to that payload to sharpen a convenience warning is the wrong trade ... this warns and never blocks'), :480-490 and :1532-1539 implement it; main's athlete-pin-directory/route.ts selects no dob. No ruling in docs/current/OWNER_DECISIONS.md on main covers this (grepped for duplicate/dob/birthday/pin directory/add athlete: no relevant hit). Minors' privacy is on the L1 hard floor, so this is not a bug fix.

Sketch: If Jason wants it: do the check on the server. Add a possible-duplicate lookup (name + dob, org-scoped, organization_admin only) that returns only the matching athlete_id and name. Show it on the form as a blocking tick-box, and clear the tick whenever the name or DOB changes. The directory payload stays as it is. If not: leave main as it is and drop the branch's version.

### Code worth redoing: Switching modes after typing an ID leaves the record ID box blank instead of re-suggesting

If an admin types their own ID, switches to 'Already on the roster', then switches back, main shows an empty ID box instead of the suggestion. It is harmless because the 'Still needed' line names the field, but it is a one-line fix that fits in with the retry fix.

Evidence: Main page.tsx:1459-1466: the mode radio's onChange calls setAthleteId('') but not setAthleteIdTouched(false), so :445 keeps returning the now-empty athleteId. The branch adds setAthleteIdEdited(false) in the same handler.

Sketch: Add setAthleteIdTouched(false) next to setAthleteId('') at page.tsx:1465. Fold it into the retry-bug PR.

### No longer a bug: Walk past taken IDs instead of counting from the highest

The branch keeps stepping forward until it finds an ID nobody has. Main takes the highest ath-number and adds one, which can never land on a taken ath-number, and it already has a test for gaps in the numbering.

Evidence: Main page.tsx:420-429: highest /^ath-(\d+)$/i match on the trimmed id, plus 1, zero-padded. An ath-NNN above the highest cannot exist by construction. Main page.test.tsx:470-480 ('skips over ids already used rather than counting rows', ath-001 + ath-007 -> ath-008). The branch needed the loop only because its regex was case-sensitive and did not trim.

Sketch: None.

### No longer a bug: Say which fields are holding the button down, and name the cure when the gym has no coach

Main already lists what is still needed above the button, and the Coach field already tells you to add a coach on the 'Add Coach, Staff Or Guardian' tab when there are none.

Evidence: Main page.tsx:528-544 missingAthleteFields; :1759-1766 renders 'Still needed before this can be saved: …' (landed as #195, commit 8af03f82, the day after this branch). :1652-1656 coach hint: 'No coaches in your gym yet … add a coach on the "Add Coach, Staff Or Guardian" tab'. Tests: main page.test.tsx:434-457.

Sketch: None.

### Dropped: Rest of the branch's parallel implementation (its own blocked-reason wording, test mocks, tests written against its UI copy)

The branch and main built the same feature two ways. Once the two fixes above are carried over, nothing else on the branch is worth keeping.

Evidence: Branch-only b06455f0 touches apps/web/app/admin/people/page.tsx, page.test.tsx and athlete-pin-directory/route.ts. Its tests assert 'Still needed:' with role=status and a 'different child' checkbox, neither of which exists on main (main uses 'Still needed before this can be saved:' with aria-live, page.tsx:1760-1764). The onAthleteWrite fetch-mock branch is worth re-creating inside the retry-bug test, not copying.

Sketch: None beyond the two bug fixes above.

## `claude/github-audit-sections-nhuxtr`

### Code worth redoing: Form-based 'promote intake to athlete' (from 841391eb)

The branch had a proper form for turning an approved intake into an athlete record (athlete details, guardian, waiver). On main, the only way to do this is for an org admin to type raw JSON into a Notes box. Worth rebuilding as a form, but not on /coach/review-queue, which you have reserved.

Evidence: Main apps/web/app/admin/shadow/page.tsx:413-424: parsePromotionPayloadFromNotes JSON.parses the Notes text. :1360-1374: processPromotion blocks with 'To promote, set Notes to a valid JSON promotion payload.' unless Notes holds hand-written JSON. The server route already takes a structured promotion (apps/web/app/api/pilot/intake/review-action/route.ts:94, action 'approve'|'reject'|'promote'). The branch put its form on /coach/review-queue, but main's apps/web/app/coach/review-queue/page.tsx:7-16 records an owner ruling (2026-08-14) that keeps that route as a placeholder until the real queue is built from recommendation/readiness/decision records. That ruling is REPORTED from the code comment; searching docs/current/OWNER_DECISIONS.md for '2026-08-14' and 'review queue' found no entry. apps/web/components/shortcuts.ts:45-49 notes that promote carries a whole guardian/emergency contact/medical/waiver payload.

Sketch: Add a structured promotion form (athlete id, name, DOB, weight class, coach, guardian, waiver) to the existing promote step on /admin/shadow. It replaces the JSON-in-Notes path and sends the same payload to /api/pilot/intake/review-action. Keep promote org-admin-only as the server enforces now. The branch's PromotionDraft fields in apps/web/app/coach/review-queue/page.tsx can serve as reference. Jason decides where it lives.

### No longer a bug: Login cookie SameSite=None + Secure (55c17250)

This fix assumed the website and the server run on two different web addresses. They don't anymore: one server now runs both at www.punxsyprominence.org, so the current login cookie already works. The branch's change would only weaken cookie protection.

Evidence: INFERRED from main 91de82ca. The branch's premise is a separate Static Web App front end that calls the Container App API from another origin. On main: (1) apps/web/src/lib/apiBase.ts:15-16 returns process.env.NEXT_PUBLIC_API_BASE ?? ''. The empty string means same-origin calls. (2) A search of all of main for NEXT_PUBLIC_API_BASE finds it only in apiBase.ts, scripts/lib/offline-runtime-env.mjs:83 (which blanks it) and docs. No workflow or Dockerfile sets it, and the Dockerfile has no NEXT_PUBLIC lines (it sets only NODE_ENV/PORT/HOSTNAME and builds a Next standalone app, Dockerfile:22-23,65-73). (3) The SWA deploy is disabled legacy: .github/workflows/azure-static-web-apps-purple-bush-04c73e010.yml:1-9 is manual-only and requires typing LEGACY_SWA_ONLY, and :35-42 refuses otherwise with 'Use deploy-staging.yml / deploy-production.yml for Container Apps releases'. (4) docs/current/PRODUCTION_STATE.json:77 records production app_origin https://www.punxsyprominence.org on container app app-ppbf-production. So the site and its API share one origin, and main's SameSite=Lax cookie (apps/web/app/api/pilot/auth/login/route.ts:133-139) is sent on every fetch. Switching to SameSite=None would drop Lax's cross-site request protection for no gain. Safari also blocks third-party cookies whatever SameSite says, so None would not fix a real cross-site setup on an iPad anyway. NOT OBSERVED: the live container app's settings, and a signed-in journey on production.

Sketch: None. If a split front end ever comes back, the fix is a same-site API subdomain (e.g. api.punxsyprominence.org), not SameSite=None.

### No longer a bug: Intake approve/reject screen on /coach/review-queue (841391eb, rest of it)

Main already lets coaches approve or reject intake cases from the coach workspace. The page the branch replaced is now a reserved placeholder by your ruling.

Evidence: Main apps/web/components/CoachWorkspace.tsx:1791-1793 and :1878 call /api/pilot/intake/review-action for approve/reject (promote is deliberately not offered there). Main apps/web/app/coach/review-queue/page.tsx:7-16 is the reserved 'Planned — Not Yet Implemented' page, pointing coaches to /coach/environment/intake-router.

Sketch: None.

### No longer a bug: Athlete daily check-in data dropped (6347cb69)

The old sliders that saved nothing are gone from main. The Wellness tab now saves to its own check-in record. The branch's fix also let athletes write through a coach-only route, which main never adopted.

Evidence: Main apps/web/components/AthleteWorkspace.tsx:618-621: 'The five sliders ... are gone ... their replacements live in AthleteCheckInPanel writing to /api/pilot/athlete/check-in'. :69-73 says the Wellness panel came back 2026-08-28 writing to that route. :1195 fetches it. The route exists: apps/web/app/api/pilot/athlete/check-in/route.ts (+route.test.ts). Main's domain-upsert still allows only ['organization_admin','coach'] (apps/web/app/api/pilot/intake/domain-upsert/route.ts:57). The branch had widened that to 'athlete', which would change who may do what, and main no longer needs it.

Sketch: None.

### No longer a bug: video_sessions status check rejected 'quarantined' uploads + schema tracking + tests (095810ad, 2b9e32ca)

Main fixed this its own way, with a dedicated video-sessions migration that allows 'quarantined' and repairs old databases.

Evidence: Main infra/azure/pilot_slice_postgres_video_sessions_migration.sql:76-77 creates the table with default 'quarantined' and the check (uploaded, quarantined, infected, processing, ready, error, archived). :99-130 replaces any old constraint missing 'quarantined' and sets the default. The runner is apps/web/scripts/pilot-apply-video-sessions-migration.mjs. The branch's other target, apps/web/app/api/pilot/admin/migrate-multiorg/route.ts, no longer exists on main (git cat-file on 91de82ca: missing).

Sketch: None.

### No longer a bug: 14 tables only created by an admin endpoint (a02d0484)

Main now creates these tables through proper migration files. The four old chat-audit tables are deliberately treated as unused leftovers.

Evidence: Main has create-table DDL in dedicated migrations: announcements in infra/azure/pilot_slice_postgres_announcements_migration.sql; compliance_rules/compliance_violations/violation_escalations in pilot_slice_postgres_compliance_migration.sql; progression_gaps/drill_assignments/assignment_completions in pilot_slice_postgres_progression_migration.sql; video_publications/publication_checks/research_library in pilot_slice_postgres_publications_migration.sql. coach/athlete/board/individual_chat_audit have no code references on main and are flagged as orphans in .github/workflows/check-database.yml:29-35. The migrate-multiorg route they came from is gone from main.

Sketch: None.

### No longer a bug: SHADOW Library API routes restored (a487fd2e, 0818c690)

All six library routes the branch brought back are already on main, with tests, plus one more.

Evidence: git ls-tree on main apps/web/app/api/pilot/shadow/library lists sources, documents, chunks, capability-coverage, search and claims route.ts files, plus review-flags, and tests for 4 of them. Last touched on main by 9e7b3051 (#502). apps/web/scripts/seed-shadow-library.mjs:124,202,214 call /api/pilot/shadow/library/sources, which exists.

Sketch: None.

## `claude/artifact-code-session-7piryt`

### Bug on main: Nothing in the app can file a compliance violation (b65d490e: Film Study 'Escalate to Compliance' + coach rules lookup)

The Compliance Center, the coach morning read and the compliance alarms all read a violations list that no screen in the app can add to, so they stay empty forever. This branch added the missing button on the Film Study review queue; main still has no way to file one.

Evidence: OBSERVED on main 91de82ca: the only writer is POST apps/web/app/api/pilot/compliance/violations/route.ts:70 (coach/admin/organization_admin at :73, calls createComplianceViolation at :110), and createComplianceViolation has no other caller (git grep over apps/web, tests excluded). The only UI file that calls that route is apps/web/app/admin/compliance-center/page.tsx: GET at :105/:169/:239, PATCH at :217-219, plus POST to /compliance/escalate at :153-155. It never POSTs a new violation. Film Study queue apps/web/app/coach/video-analysis/page.tsx:929-950 offers only Accept/Correct/Reject. The only rules read is board-only: apps/web/app/api/pilot/board/compliance-rules/route.ts:25 ['board','platform_owner'], so a coach screen has no rule list to pick from. Readers that stay empty as a result: coachIntelligence.ts:241-275 (open violations item), compliance.ts:157-204 (auto-escalation that only fires on insert), operations/page.tsx:145 (which lists Safety Compliance Center as EXISTS). Filing authority is already coach/admin per docs/capabilities/GATES.md:298, so wiring a screen to it does not change who may do what. Consequence: a coach who spots a technique or protocol breach in footage has nowhere to record it, and an admin opening the Compliance Center always sees an empty register.

Sketch: Hand-port b65d490e onto current main; don't merge the branch, because main's Film Study page has changed since (it now has a Correct verdict). (1) Add GET /api/pilot/compliance/rules with requireRole coach/organization_admin/admin, returning getComplianceRulesByCategory(principal.organizationId). That read already leaves out detection_logic (compliance.ts:488-493). Leave platform_owner out. (2) On coach/video-analysis/page.tsx, next to Accept/Correct/Reject on each pending proposal, add a rule picker and an 'Escalate to Compliance' button. It POSTs /api/pilot/compliance/violations with rule_id, athlete_id, video_session_id and severity from the chosen rule, plus details {source:'film_study_proposal', proposal_id}, and not the AI text. If the rules fail to load, hide the button without breaking the queue. (3) Tests: 403 for athlete/parent/board/platform_owner on the rules route, a page test for the POST body, and a check that main's existing coach/admin auto-escalation (compliance.ts:251) now fires from this path. Optional follow-up for Jason: a plain 'File a violation' form in the Compliance Center, so filing does not depend on a Film Study proposal existing.

### No longer a bug: Coach Intelligence shows open safety escalations and compliance violations (c81a105c)

Main already puts open safety escalations and open compliance violations on the coach's morning read.

Evidence: OBSERVED main apps/web/src/server/pilot/coachIntelligence.ts:104-113 (digest fields), :236-240 (listEscalations with excludeAthleteVoice), :241-275 (violations query), :384-385. Page reads them at apps/web/app/coach/intelligence/page.tsx:22-38,100. PR #447 closing comment names #450 as the fix (REPORTED).

Sketch: None.

### No longer a bug: Video scan block/infected verdict files a safety escalation (2dd36fd4)

Main already raises a safety alarm when the scan blocks footage. Main's version is broader than this branch's: it also covers 'needs human review' and sets severity per verdict. The branch version would be a step backward.

Evidence: OBSERVED main apps/web/src/server/pilot/videoScanSweep.ts:40-43 (infected/blocked/needs_human_review), :55-78 (per-verdict severity), :254-256 fileEscalation sourceType 'video_scan'. escalationLadder.ts:47 and infra/azure/pilot_slice_postgres.sql:729 include 'video_scan'. The branch fires only on blocked/infected at a fixed 'high'.

Sketch: None.

### No longer a bug: Guardian media consent checked before Film Study analysis (8674850c)

Main already checks parent consent before a Film Study analysis runs, and your Teach Shadow ruling keeps that check.

Evidence: OBSERVED main apps/web/app/api/pilot/shadow/video-analysis/route.ts:18 import, :117 await assertGuardianMediaConsent(principal.organizationId, video.athlete_id). docs/current/OWNER_DECISIONS.md OD-2026-09-28-006 item 4: 'Film Study keeps its existing consent check.'

Sketch: None.

### No longer a bug: Transfer-check-failed progression suggestion rule (06c49235)

Main already suggests a progression gap when a skill holds in drills but falls apart live.

Evidence: OBSERVED main apps/web/src/server/pilot/progressionSuggestions.ts:48 ('transfer_check_failed' rule type), :206 (rule emitted), :395. PR #447 comment names #441 (REPORTED).

Sketch: None.

### No longer a bug: Volunteer invite links to a volunteer roster row (1a7b4950)

Main already links a volunteer's login to their roster row when they are invited. It also reuses an existing row instead of making a duplicate.

Evidence: OBSERVED main apps/web/src/server/pilot/staffProvisioning.ts:497-540. When role === 'volunteer' it always reuses the account's own pilot.volunteers row (:512-517), or links a named row with an ownership check (:518-540). Doc at :66-73 also covers creating a new row. PR #447 comment names #448 (REPORTED).

Sketch: None.

### No longer a bug: Withdraw a competition entry / league roster entry (f18b3f5e)

Main already lets an admin withdraw a competition entry or take a wrestler off a league roster.

Evidence: OBSERVED main apps/web/src/server/pilot/externalCompetition.ts:225 withdrawCompetitionEntry. apps/web/src/server/pilot/wrestlingLeague.ts:254 withdrawLeagueRosterEntry. Wired in apps/web/app/api/pilot/operations/external-competition/entries/route.ts:112-130 and operations/wrestling-league/roster/route.ts:104-118.

Sketch: None.

### No longer a bug: Review submitted research sources (5078cae2)

Main already has a separate Submission Review page for research sources, and your org admin account can reach it. This branch's panel on the research page answers the same need a different way.

Evidence: OBSERVED main apps/web/app/research/review/page.tsx:159-170 PATCHes /api/pilot/shadow/research-submissions, gated by allowedRoles ['admin','platform_owner'] at :217-218. apps/web/components/roleSession.ts:226 maps organization_admin to the 'admin' client role, so ppbf@ gets in. Linked from apps/web/components/buildingMap.ts:553. The endpoint's own gate is shadowRoleSets.ts:112-116 (organization_admin/admin/platform_owner).

Sketch: None.

### Dropped: Auto-escalate board/parent-level compliance rules (ebd7e1c4)

The branch sent individual violations up to the board or to parents automatically. Main deliberately does not: the board only sees anonymous totals, and parents are not told an escalation exists. No rule in the app is set to board or parent level anyway, so this code could never run. Drop it. If rule editing is ever built, the question comes back to you.

Evidence: OBSERVED on main 91de82ca: apps/web/src/server/pilot/compliance.ts:19-32 maps only coach and admin, and says board/parent are 'deliberately absent'. apps/web/src/server/pilot/escalationLadder.ts:53-72 explains why: individual athlete records stay away from board (k-anonymity) and parents (non-disclosure), and this is 'reported as a known gap, not silently widened'. Every seeded rule is coach or admin: apps/web/src/server/pilot/complianceRuleSeeds.ts:44,54,64,74,84 and infra/azure/pilot_slice_postgres_compliance_rule_seeds_migration.sql:69-150. The only app code that inserts compliance rules is complianceRuleSeeds.ts:110, so no board/parent rule can exist through the app. The branch code (compliance.ts shouldAutoEscalateViolationRule) would also have filed escalations addressed to 'board'/'parent', roles main's SafetyEscalationTargetRole (escalationLadder.ts:72) no longer allows.

Sketch: None. If rule authoring is ever built, ask Jason then whether board/parent-level rules should fall back to organization_admin, which adds no new audience.

### Dropped: Research and Visuals handoff briefs under docs/handoffs/ (f7593de6)

These are early drafts of the two briefs that main already keeps up to date in docs/. Saving them would give each brief a second, competing copy. They are not the SHADOW docs.

Evidence: OBSERVED main has docs/HANDOFF_RESEARCH.md (277 lines, same six numbered items) and docs/HANDOFF_VISUALS.md (229 lines, same five jobs, marked HISTORY 2026-09-28), first landed in a57258af (#437, an ancestor of main) and maintained since. Main's docs/handoffs/README.md already points to them. The branch's docs/handoffs/HANDOFF_*.md files and README differ only in wording and are older.

Sketch: None.

## `docs/shadow-algorithm-lane-package`

### Bug on main: Knowledge Graph shows approved intake cases as 'Validated Lesson'

On the Knowledge Graph page, any intake case a coach approves or promotes is listed in the 'Validated Lesson' column, even though nothing validated it as a lesson. Every member of the gym, athletes and parents included, sees a false label.

Evidence: OBSERVED on main 91de82ca. apps/web/src/server/pilot/shadowReadModels.ts:636-637: `} else if (reviewState === 'approved' || reviewState === 'promoted') { type = 'Validated Lesson';`. toReviewState (:257-264) derives that state only from the event name containing 'APPROVED' or 'PROMOTED'. apps/web/app/api/pilot/intake/review-action/route.ts:308 emits 'SHADOW_INTAKE_CASE_APPROVED' and :630 emits 'SHADOW_INTAKE_CASE_PROMOTED'. The name contains SHADOW, so the filter at shadowReadModels.ts:~643 keeps it. apps/web/app/knowledge-graph/page.tsx:83/183 renders these under the 'Validated Lesson' heading. The route (app/api/pilot/shadow/knowledge-projection/route.ts) allows SHADOW_PROJECTION_READ_ROLES = ORGANIZATION_MEMBER_ROLES (incl. athlete, parent) + platform_owner (shadowRoleSets.ts:22-39). How it goes wrong: a coach approves an intake case in review, then anyone who opens /knowledge-graph sees it pinned as a Validated Lesson. This is already recorded on main as contract doc D1 but has not been fixed.

Sketch: Truth fix, small: in getShadowKnowledgeProjection, stop mapping approved/promoted to 'Validated Lesson'. Classify those events as 'Observation' and let the existing Approved/Promoted badge (page.tsx REVIEW_STATE_BADGES) show the review outcome. Leave the Validated Lesson column empty ('No items.') until real lessons feed it. Update the matching test in shadowReadModels. The bigger step, feeding the ladder from the patterns/ promotion and lessons contract, is Jason's call (handoff §7.2) and is not part of this fix. No change to who can see the page.

### Code worth redoing: SHADOW learning loop: 5 of 7 feedback signals are never produced (D6)

The feedback system has seven kinds of 'how did the advice go' signals, but the app only ever sends thumbs up or thumbs down. The scoring and 'retain' logic built for the other five never runs. It harms no one, because library changes still go to a human, but it is dead weight that makes the numbers look richer than they are.

Evidence: OBSERVED on main 91de82ca: the only writer is apps/web/app/api/pilot/shadow/feedback/route.ts:152, `const outcomeSignal = body.helpful ? 'thumbs_up' : 'thumbs_down';`. followed_advice, asked_followup, session_ended, ignored_advice and escalated_to_human appear only in type unions, read filters (shadowUnlocks.ts:178,197; shadowFeedback.ts:360-361) and scoring (shadowLearningLoop.ts:185,212,378,606-618). The retain band at shadowLearningLoop.ts:414-418 is unreachable. Library changes go to human review (shadowLearningLoop.ts:262 queueLibraryEntryChangeForHumanReview), so nothing changes automatically. Already recorded on main as contract doc D6; metrics/route.ts:274 already fixed the escalations tile that depended on it.

Sketch: Pick one. (a) Trim: remove the unproduced signals and the unreachable retain/0.8 branches so the code matches what the UI can send (small). (b) Build: add real follow-through capture (e.g. a 'did you use this?' prompt) so the signals exist (medium). This is not a bug fix, so it goes on the build list only if Jason wants SHADOW feedback worked on.

### Idea: One-week paper observation pilot (coach session sheets)

The SHADOW engines on main have no real coach observations flowing into them. The branch's cheapest next step was one week of paper sheets in one program: coaches record what they saw with up to 10 agreed behavior codes, plus an end-of-session 0-10 effort rating per athlete. The ruling names only the Floor Card as an idea row, so recording this one is optional.

Evidence: OBSERVED: SHADOW_OBSERVATION_CAPTURE_VOCABULARY_SPEC_v0.md §17 and SHADOW_PAPER_PILOT_PACKAGE.md §19 name this as the smallest useful next action. The main engines exist (apps/web/src/server/pilot/patterns/inference/*.ts) but refuse to promote without a signed policy (contract doc §7.1). INFERRED: the pilot is club work that needs no code.

Sketch: If Jason wants it, add one idea row pointing at the archived pilot package and vocabulary spec. Running it needs his pilot-scoped approvals (pilot package §17: behavior-code card, context letters, RPE wording, co-rating schedule, custody of the athlete code key, transcriber).

### Document: SHADOW algorithm design package (stack spec v1.1, capture vocabulary v0, promotion policy sheet, gate ledger)

These are the design papers behind the SHADOW pattern engine: which statistics it uses and why, how coaches should record observations, the unsigned threshold sheet, and the plan for switching pieces on. Main has none of them. Archive them as history, not as current rules.

Evidence: OBSERVED: none of these files exists on main 91de82ca (git cat-file on each path: 'does not exist'). The branch is 2 commits on merge-base 4289a6fe, docs only, 13 files, +1606 lines, no code. Their control-state sections are out of date: they call #358/#355/#357 OPEN, but main has merges 186b524f (#358), 25d4c56d (#355) and f1b83cee (#357), and the Phase A engines exist at apps/web/src/server/pilot/patterns/inference/{recurrence,attribution,drift,singleCase}.ts. The stack spec's Azure section (App Service B1, Postgres B1ms) also predates the current container-app production path.

Sketch: Copy them byte-for-byte into docs/archive/ using the existing date prefix, e.g. docs/archive/2026-09-29_SHADOW_ML_ALGORITHM_STACK.md, and add one line to each saying it is archived design history and that its control state is stale. Do not add them to MASTER_INDEX as active sources.

### Document: SHADOW paper observation pilot package

Printable coach sheets (session sheet, intervention half-sheet, co-rating card, coach rules) and a 7-day paper pilot plan for recording what athletes did, without app code. Archive it with the rest of the SHADOW docs.

Evidence: OBSERVED: docs/SHADOW_PAPER_PILOT_PACKAGE.md (303 lines) exists on the branch at 52d50345 and not on main 91de82ca. It depends on the capture vocabulary v0 spec in the item above.

Sketch: Archive as docs/archive/2026-09-29_SHADOW_PAPER_PILOT_PACKAGE.md alongside the vocabulary spec it is built on.

### Document: SHADOW Phase A-D work orders and Phase A cross-review checklist

The build orders for the SHADOW engine. Phase A was built and merged as #358. Phases B, C and D are drafts marked HOLD, never run. They are worth keeping as history and as a starting point if SHADOW work resumes.

Evidence: OBSERVED: docs/work-orders/ does not exist on main 91de82ca. PHASE_A_WORK_ORDER.md has the header 'STATUS (2026-08-15): EXECUTED — Phase A landed as PR #358', and main shows merge 186b524f for #358. B, C and D each say 'STATUS: DRAFT. DO NOT EXECUTE.' They name ChatGPT as the implementer, which OD-2026-09-28-001 has since superseded (Claude Code is the only builder).

Sketch: Archive under docs/archive/, either flattened with the date prefix (2026-09-29_SHADOW_PHASE_A_WORK_ORDER.md, etc.) or in a docs/archive/2026-09-29_shadow-work-orders/ folder. Do not create an active docs/work-orders/ folder on main.

### Document: SHADOW sprint handoff 2026-08-14

A resume sheet written after the pattern-formation sprint hit a usage limit. Its loose ends have since closed: #337 merged, and the medical-gate finding was fixed. It is history only.

Evidence: OBSERVED: docs/handoffs/SHADOW_SPRINT_HANDOFF_2026-08-14.md is not on main. Its findings (a) knowledge ladder, (b) learning loop and (c) medical gate are already on main in more detail as D1, D6 and D10 in docs/SHADOW_PATTERN_FORMATION_CONTRACT.md §6. D10 is marked CLOSED there (line 269). #337 is merged on main (e2a55705).

Sketch: Archive as docs/archive/2026-09-29_SHADOW_SPRINT_HANDOFF_2026-08-14.md. None of its content needs to move into an active doc.

### Document: Elite boxing development research synthesis

A 152-line AI-written research summary on how boxers develop, with an evidence-strength tag on every claim. It is scoped to adults only and is marked research input, never an instruction to build. Archive it with the SHADOW docs. Its own header says the master copy belongs in the SharePoint research lane, so Jason may want a copy there too.

Evidence: OBSERVED: docs/research/ELITE_BOXING_DEVELOPMENT_RESEARCH_2026-08-14.md is on the branch (commit 52d50345). docs/research/ does not exist on main 91de82ca. The header reads 'master copy belongs in the SharePoint Research Control lane' and 'Referenced by nothing in src/'. Its scope banner limits it to healthy adult beginners through elite adults and says it must not be applied to youth without a separate adaptation pass.

Sketch: Archive as docs/archive/2026-09-29_ELITE_BOXING_DEVELOPMENT_RESEARCH_2026-08-14.md with both banners intact. A SharePoint Club Operations copy is optional and needs Jason's yes, because it is a write to a new place.

### No longer a bug: Medical gate armed by a client-supplied flag (D10)

The branch docs report that the medical-clearance guard only ran when the caller's request asked for it. Main has fixed this: the guard now runs on every recommendation and decision write.

Evidence: OBSERVED: fix commit ed3637e2 ('fix: the medical gate no longer asks the caller whether to run') is an ancestor of main 91de82ca. apps/web/src/server/pilot/shadowRecommendations.ts:101 and apps/web/src/server/pilot/shadowDecisions.ts:48 call assertMedicalStatusAllowsRecommendation unconditionally. isMedicallySensitive survives only in comments (shadowRecommendations.ts:84, shadowDecisions.ts:43, app/coach/decision-loop/page.tsx:282). docs/SHADOW_PATTERN_FORMATION_CONTRACT.md:269 records D10 as CLOSED by #362.

Sketch: None.

### Dropped: MASTER_INDEX.md additions

The branch added 8 index lines pointing at these docs as active sources. Main's index has been rewritten since, and the docs are going to the archive, so these lines should not carry over.

Evidence: OBSERVED: the branch diff adds 8 bullet lines after main's old line 58. Main 91de82ca MASTER_INDEX.md is now a table (e.g. line 53: 'Pattern formation | docs/SHADOW_PATTERN_FORMATION_CONTRACT.md (algorithm built, thresholds not ratified)'), so the hunk no longer fits and would point readers at archived files.

Sketch: None. Leave MASTER_INDEX as it is on main.

## `claude/session-018wv6gmzwuufsy3a7d5bbir-ew6wsd`

### Idea: Module 202: Floor Card / Individual Workspace (personal space, earned by accomplishments)

Your idea from 2026-08-17: every user gets their own space for their workouts and goals, and extras unlock from real accomplishments that never get taken back. There is no points system, and nobody is compared or ranked. It is not on main anywhere, so keep it as one parked row. One catch: main already uses the name 'Individual Floor Card' for a coach's training card, so the name needs a decision.

Evidence: OBSERVED: branch-only file docs/capabilities/modules/202-floor-card-individual-workspace.md (98 lines, blob 51dff2e2, never in main history). main 91de82ca has modules 200 and 201 but no 202, and no 'Floor space' or 'individual workspace' text anywhere. Name clash on main: PRODUCT_CAPABILITIES.json:220 'Group Floor Card vs Individual Floor Card' and :833 'Group and Individual Floor Cards remain distinct' (OWNER_APPROVED_PRODUCT_DIRECTION, meaning the plan card a coach runs on the floor). The idea fits main as it is: achievementPaths.ts:28 says no milestone carries points and nothing ranks one athlete against another, and achievements.ts already records goals, recognitions and milestones, plus the 1% Club (onePercentClub.ts). Those are the accomplishment events phase 1 would unlock from. The doc disagrees with itself: its audit row says it is blocked on the Bronze/Silver/Gold rework, but its Dependencies section says phase 1 does not depend on that. On main, Bronze/Silver/Gold are SHADOW profiling badges that 'must never gate capabilities' (SHADOW_ML_ARCHITECTURE_SPEC.md:1304). Jason's quoted words in the doc are REPORTED from the 2026-08-17 session and cannot be re-checked here.

Sketch: Copy the 202 file into the archive. Add one PARKED row to docs/current/ACTIVE_WORK.md on main, e.g. BACKLOG-floor-card-personal-space, pointing to the archived doc. Re-open when Jason decides (a) which roles get one, (b) who besides the user may view it (the doc proposes the user's coaches and guardians, which is a who-may-see question for Jason), and (c) a name that does not clash with the coach's Individual Floor Card. Competition and leaderboards stay parked, as the doc already says.

### Idea: Video action classification: score against the gym's own coach-defined form (recorded as a 2026-08-17 'owner decision', never reached main)

The branch says you narrowed the video-scoring parking on 2026-08-17: naming punches (jab, cross, hook, 'power jab') could be built right away, and form checks would score only against your coaches' own template for each punch, never as a bare grade, and always through the Film Study coach-accept step. Your newer ruling of 2026-09-28 keeps per-skill scoring parked, so this is not a decision to merge. It is still worth keeping as the scoring approach to offer you when that parking lifts.

Evidence: OBSERVED: the branch adds docs/current/ACTIVE_WORK.md:50-54 ('Owner decision 2026-08-17 — video action classification') and rewrites :71, marking BACKLOG-video-skill-scoring 'Superseded 2026-08-17, moved to NOW'. On main that row is still PARKED (docs/current/ACTIVE_WORK.md:222), and it re-opens when 'a scoring approach with explicit evidence standards has been selected by the owner'. The newer controlling ruling, OD-2026-09-28-006 ruling 5 (docs/current/OWNER_DECISIONS.md:446), says Teach Shadow teaches recognition only and does not re-open per-skill AI video scoring, which stays parked for Phase 2+. No 2026-08-17 video decision appears in OWNER_DECISIONS.md on main. The 08-17 decision itself is REPORTED, from branch commits dd2f62ca, bce27854 and 12dcc486 only.

Sketch: Do not merge the ACTIVE_WORK change: it would reverse a newer ruling. Archive the 5-line entry (branch ACTIVE_WORK.md lines 50-54 and 71) as a candidate scoring approach. Add one pointer to the re-open cell of main's BACKLOG-video-skill-scoring row, naming it as the approach to put to Jason when Phase 2 opens.

### No longer a bug: D10: medical-clearance gate on SHADOW decisions switched on by a client checkbox

Commit bce27854 on the branch said a coach's checkbox decided whether the medical-clearance check ran on SHADOW decisions. It was fixed before this branch was written: main now runs the check on every decision, with no checkbox. The branch's own last commit deleted the claim.

Evidence: OBSERVED: main apps/web/src/server/pilot/shadowDecisions.ts:48 calls assertMedicalStatusAllowsRecommendation(organizationId, athleteId) unconditionally. apps/web/app/api/pilot/shadow/decisions/route.ts on main has 0 occurrences of isMedicallySensitive. docs/SHADOW_PATTERN_FORMATION_CONTRACT.md:269 records 'D10 — CLOSED' by ed3637e2 (#362, 2026-08-15, 'fix: the medical gate no longer asks the caller whether to run'), and ed3637e2 is an ancestor of both main and the branch. Branch commit 12dcc486 removed the D10 text from ACTIVE_WORK.md.

Sketch: None.

### Dropped: 15 engine-unlock proposals (015-036): parallel drafts of files main already has

Another session wrote the same 15 proposals the same day, and main kept that version. It is longer and already parked as one row. The branch copies would only be a competing second version. One point is worth carrying over later: the branch's 015 says a conditioning screen must check for an active training hold first, and main's 015 does not say that.

Evidence: OBSERVED: all 15 paths exist on main from e8a5a237 ('Engine unlock-prerequisite proposals (15 modules)', 2026-08-16), and no branch blob appears in main history. Main's versions are generally longer (e.g. 036: main about 750+ lines vs branch 116). Main parks them as one row: docs/current/ACTIVE_WORK.md:227 BACKLOG-engine-unlock-proposals ('Jason takes up a named proposal'). The difference: the branch's 015 has conditioning views read pilot.training_holds (scope conditioning_only/all_training, status active) before rendering. grep finds no 'training_holds' in main's 015; it appears in main's 023, 029, 031 and 035.

Sketch: Drop with the branch. If Jason takes up 015, add one line to main's 015: conditioning views check active training_holds (conditioning_only/all_training) first and show no progress framing while a hold is active.

### Dropped: SIGN_OFF_GUIDE, TEST_PIN_MAP, PLACEHOLDER_MAP: stale 2026-08-16 snapshots of docs main maintains

All three documents are on main in a newer, maintained form. The branch copies describe the code as it was on 2026-08-16, and that code has changed since, so keeping them would mislead.

Evidence: OBSERVED: main's docs/current/SIGN_OFF_GUIDE.md came from #406 (83b03242) and was last touched in a1c31ed2 (#995, 2026-09-28). docs/design/TEST_PIN_MAP.md came from #406 and was last touched in 25a3bfb1 (#996, 2026-09-29). docs/design/PLACEHOLDER_MAP.md came from e848ca3e and was last touched in a1c31ed2 (#995). The branch versions (680301c6, 2026-08-16) cover the same topics (the 82 DONE+PENDING_SIGN_OFF modules, test-pinned strings, stale placeholders), and none of their blobs appear in main history.

Sketch: None. Drop with the branch.

## `claude/session-01jaducld8vgt11zczyxjsu-rognwd`

### Bug on main: Intake can silently move a guardian's record to a different login

If an admin names an existing guardian (parent_id) with a different login account, main moves that guardian's record to the new login without warning. The real parent loses access to all their children and the new login gains it. Coaches can no longer do this; admins still can, by accident.

Evidence: OBSERVED on main 91de82ca: apps/web/src/server/pilot/intake.ts:1448-1478 upsertGuardian does `on conflict (organization_id, parent_id) do update set account_id = coalesce(excluded.account_id, pilot.parents.account_id)` (line 1469), so a supplied account_id replaces an existing one. Callers: domain-upsert/route.ts:196-214 (guardian_link, org-admin only; assertActiveParentAccount at :205 only checks the new account is an active parent, not that the row is unbound) and review-action/route.ts:482-489 (promotion, org-admin only, parent_id and account_id typed by the admin as JSON in the Notes field, admin/shadow/page.tsx:1366-1389). Reach follows the row: guardianAccess.ts:73-88 guardianAthleteIds joins guardian_links to parents on p.account_id. Failure: admin adds a second parent and reuses the first parent's parent_id. The row flips to the new account, the first parent's portal goes empty for every sibling, and the second account now sees siblings it was never linked to. staffProvisioning.ts:450-470 already refuses this exact takeover on the invite path; intake has no matching check. guardianUpsert.pg.test.ts (main) has no case for a changed account_id.

Sketch: Port the branch's guard (f9dff27e) onto main's current SQL. Keep main's coalesce for phone and email, and add `where pilot.parents.account_id is null or excluded.account_id is null or pilot.parents.account_id = excluded.account_id returning parent_id`. When no row comes back, throw a 409-mapped 'Conflict: this guardian record is already linked to a different account'. Add a pg test case to guardianUpsert.pg.test.ts and a route test. This refuses only a silent repoint: creating guardians, linking siblings, and setting an account on an unbound row all work as before. If Jason wants admins to be able to move a guardian to a new login on purpose, that should be its own explicit action, not an intake side effect. No such path exists today.

### Bug on main: Athlete under a training hold isn't told why or how it lifts

When an athlete under a training hold tries to register for a class, the server sends the coach's written explanation and what lifts the hold. The schedule page throws both away and shows only 'Training hold: registration is paused for this athlete'.

Evidence: OBSERVED on main 91de82ca: api/pilot/scheduler/route.ts:652-658 returns 403 with error, athlete_explanation and lift_condition. app/schedule/page.tsx:227-234 types the response as {ok, error, membership_flags} and runs `throw new Error(result.error || 'Action failed')` at :233, so the other two fields are never read. The athlete register path is at :373 (role === 'athlete'). The only UI surfaces that render athlete_explanation are coach/progression-intelligence, coach/sports-medicine and parent/safety (git grep), so the athlete never sees the coach's words.

Sketch: Port 3a15baf0 plus the showError part of 988cf4ed. Read athlete_explanation and lift_condition, store them next to errorMessage, and render them in the existing Failed box at page.tsx:330 ('To lift it: ...'). Route every error setter through one showError(message, detail = null) so a later 'Select an athlete first.' can't inherit an old hold explanation. Add one page test.

### Bug on main: Evidence and wrestling-league pages say 'nothing here' when the load failed

If the list fails to load, these two pages show the red failure banner and also 'No sources/documents have been recorded' or 'No seasons on record' underneath it. The second message is false: nobody could check.

Evidence: OBSERVED on main 91de82ca: app/evidence/page.tsx:64-70 sets only `error` on load failure (queue stays {sources:[],documents:[]}, loading goes false). The banner renders at :148-155, then `!loading && queue.sources.length === 0` at :177 and the documents equivalent at :223 render 'No sources have been recorded for this organization yet. This is an empty library, not a cleared queue.' app/operations/wrestling-league/page.tsx:82 throws 'Unable to load league seasons.', :94-98 sets errorMessage and loading false, the banner renders at :268, and :317-320 still renders 'No seasons on record' because that branch checks only loading and seasons.length. For comparison, performance-analytics/page.tsx:233-246 on main already has the correct errorMessage guard.

Sketch: Evidence: split loadError from actionError (a failed approve/reject must not hide an already-loaded queue) and gate both empty lines on !loadError. Wrestling-league: keep a separate seasonsLoadError and add an `: seasonsLoadError ? (<could-not-read panel>)` branch before the empty branch, the same way performance-analytics does. Add one failing-fetch test per page (the branch's e9153386 tests can be adapted).

### Code worth redoing: Shared loading/error/empty component (DataState)

The branch added one small component that always shows loading first, then error, then empty, then the data, so a page can't show 'nothing here' under a failure again. Main has no shared version, and each page does it by hand, which is how the bug above keeps coming back.

Evidence: Branch: apps/web/components/DataState.tsx + DataState.test.tsx (e9153386). Main 91de82ca: no DataState or dataStatus component (git grep on components and src/components found only unrelated local type names). Pages hand-roll the ordering: performance-analytics/page.tsx:229-246 (correct), wrestling-league/page.tsx:314-320 and evidence/page.tsx:157-177 (wrong).

Sketch: Optional. Re-create the component on main's current classes (.working, .alert--critical, .empty family) and use it for the two pages above. If one-off guards are enough for now, skip it. The guards alone fix the bug.

### Code worth redoing: Homepage has no link to the family interest form

The front page (/) gives a visiting parent 'Learn About Our Programs', 'Log In' and an email link, but nothing points to the interest form on /public. The only way there is Log In, then the back link.

Evidence: OBSERVED on main 91de82ca: app/page.tsx hrefs are #programs (:100), /login (:103, :378) and mailto (:282, :358, :376). No /public link. The form anchor exists at app/public/page.tsx:688 (id="interest-intake"). GlobalRoleHeader.tsx:151-158 renders only a bare 'PPBF' bar for signed-out visitors. The only route from / to the form is SignInPanel.tsx:373 (back link from /login).

Sketch: Add a 'Tell Us You're Interested' Link to /public#interest-intake in the hero CTA row and beside 'Get in Touch', as in branch commit 3fc50dfa, restyled to main's current classes. Also worth asking Jason whether / should simply become /public, since #417 called /public the front door.

### Code worth redoing: Interest form result looks the same whether it was sent or not

After a parent submits the interest form, success, 'not sent' and 'connection dropped' all appear as the same small brass line. The wording differs, but a red 'Not sent' box would be noticed on a phone and read out by screen readers.

Evidence: OBSERVED on main 91de82ca: app/public/page.tsx:367 has a single `confirmation` string. :404-452 writes distinct text per outcome ('did not go through', 'Got it -- thanks', 'The connection dropped'). :820 renders all of them as one `<p className=... brass-800>` with no role. The branch's claim that a parent 'could not tell' overstates it, since the words differ.

Sketch: Replace `confirmation` with {kind: 'success'|'refusal'|'network-error', text} and render it in the existing .alert family: role=alert for refusal, role=status for the others (branch 28a39670).

### Document: Docs for the second cross-gym privilege (master SHADOW access)

Besides the platform owner role, an account-level flag, has_master_shadow_access, lets its holder export de-identified research data across every gym. Main's auth docs don't describe it. The branch wrote it up: who can grant it, what refuses it, audit, the one route it opens, and what it does not open.

Evidence: Main 91de82ca: the flag is live in code (auth.ts; api/pilot/platform/users/master-shadow-access/route.ts; api/pilot/shadow/research-bridge/session-export/route.ts:53-59,108). AUTH_CONTRACT.md mentions it only as a JSON field (:59). The Authorization boundary section (:218-222) and ORGANIZATION_ROLE_MODEL.md say nothing about it. Branch commit 9f0ccb28 adds a 'Cross-Organization Privileges' section to AUTH_CONTRACT.md and a 'Master SHADOW access (account flag, not a role)' section to ORGANIZATION_ROLE_MODEL.md. It predates main's staging-only environment fence on session-export (route.ts:62-80), so it needs that added if ported. Consistent with OD-2026-09-28-005 because the export is de-identified.

Sketch: Archive the two branch files. Separately worth a small doc PR: port the section into main's AUTH_CONTRACT.md and ORGANIZATION_ROLE_MODEL.md and add the environment fence. Main's docs currently give the wrong answer to 'what crosses gyms besides platform_owner'.

### No longer a bug: Coach linking another family's parent to an athlete

Main already restricts the guardian_link write to organization admins and checks that the account is an active parent in the gym.

Evidence: Main 91de82ca apps/web/app/api/pilot/intake/domain-upsert/route.ts:196 `requireRole(principal, ['organization_admin'])` inside the guardian_link branch, and :205 assertActiveParentAccount. Landed in 5f19bd68 (#456). The branch's f8243407 did the same thing another way.

Sketch: None.

### No longer a bug: Login failing if the rate-limit store throws

The durable rate-limit helpers on main can't throw into the login route. They catch everything and fall back to the in-memory limiter. The branch commit itself said the failure wasn't reachable.

Evidence: Main 91de82ca apps/web/src/server/pilot/rateLimit.ts:51-66 withDurableClient wraps withPoolClient (including connection acquisition) in try/catch and returns null. checkDurableRateLimit (:237-259), recordDurableFailedAttempt (:262-306) and clearDurableRateLimit (:309-319) all go through it. The fake 'outage' test the branch rewrote was also fixed on main (login/route.test.ts:184-198 points to route.durableOutage.test.ts, which fails the real pool).

Sketch: None.

### No longer a bug: Never-assessed athlete showing READY FOR TRAINING

Main removed the readiness slider that defaulted to 8, and the tile no longer claims a colour or 'ready'.

Evidence: Main 91de82ca apps/web/components/AthleteWorkspace.tsx:636-642 ('readinessToTrain stood here as useState(8) until A-FIN-01 ... There is no replacement state'). components/RoleSummaryPanels.tsx:41-45 and :180-195: a neutral 'Today's Wellness' tile, 'Not a clearance'. READY FOR TRAINING text was removed in #597.

Sketch: None.

### No longer a bug: Sample-data notices on the six made-up consoles

Main's console components now carry their own 'Planned — Not Yet Implemented' stamp and say the figures are fabricated, so the branch's extra page-level notice isn't needed.

Evidence: Main 91de82ca: BoardViewportSwitcher.tsx:103-106, MacroCommandCenter.tsx:77-80, MediaAndCommsHub.tsx:39-41, CurriculumProgressionEngine.tsx:141-143, FloorOperationsDesk.tsx:123-125. Retro-lab's PunxsyEcosystemCore.tsx:216 has the 'mock-only front-end' warning. PR #422 ('Remaining prototypes undeclared') is listed as landed in docs/capabilities/NETWORK_STATUS.md:900.

Sketch: None.

### No longer a bug: Escalations page blank Source for incident/video_scan/compliance

Main now takes the source list from the server's own type, so all nine sources have labels.

Evidence: Main 91de82ca apps/web/app/admin/escalations/page.tsx:19 imports SafetyEscalationSourceType from escalationLadder. :49-58 SOURCE_LABEL is a Record over it, including incident, video_scan and compliance_violation.

Sketch: None.

### No longer a bug: Coach digest and gap engine disagreeing on 'attendance halved'

Both now use the same 'at least half' comparison.

Evidence: Main 91de82ca apps/web/src/server/pilot/coachIntelligence.ts:304 `training_days_late <= training_days_early * TRAINING_DAYS_DROP_RATIO`, matching progressionSuggestions.ts:143.

Sketch: None.

### No longer a bug: Performance analytics saying 'No athletes on your roster' after a failed load

Main already shows a 'could not be read' panel instead of the empty-roster message when the load fails.

Evidence: Main 91de82ca apps/web/app/coach/performance-analytics/page.tsx:233-246 (errorMessage branch before the items.length === 0 branch).

Sketch: None.

### No longer a bug: Research inbox empty message showing while still loading

Main has its own loading flag for the research projection list.

Evidence: Main 91de82ca apps/web/app/research/page.tsx:82 projectionLoading, :161 cleared in finally, :519-533 loading and empty branches gated on it.

Sketch: None.

### Dropped: Branch copy of NETWORK_STATUS.md and capabilities README

Main has its own, much newer NETWORK_STATUS.md that was kept up to date through #996. The branch's older copy would only compete with it.

Evidence: Main 91de82ca docs/capabilities/NETWORK_STATUS.md, last touched 25a3bfb1 (#996, 2026-09-29). git diff branch..main on that file is about 1300 lines. The branch's one correction (the wrong '#449 PIN-issued platform_owner' residual) is already absent from main's file (no 'residual' or 'PIN-issued' match).

Sketch: None.

### Dropped: Floor operations desk restyle

A visual redo of a console whose data is entirely made up. Its colour reasoning assumed red was reserved, which the 2026-09-29 ruling reversed.

Evidence: Branch cd02c3e3 (FloorOperationsDesk.tsx +499/-98, coach/operations/page.tsx). Main 91de82ca FloorOperationsDesk.tsx:123-125 still declares all figures fabricated. The commit's 'absence tag drops from red ... Law 2' calls conflict with OD-2026-09-29-001 (red not reserved), REPORTED in the brief and not yet in OWNER_DECISIONS.md at 91de82ca. Main's design system has since moved to design-system/current/ppbf-golden-era.css.

Sketch: None. Restyle the desk only when it gets real data.

### Dropped: CSS dressing: small-screen ornament density, sepia wall photos, 'two grounds' comment fixes

Visual preferences written against the old stylesheet. On main the wall photos have no sepia filter, so the upload preview already matches the wall.

Evidence: Branch 55de89aa and 47a21580 (design-system/ppbf.css), 5cda2166 and the globals.css part of 988cf4ed. Main 91de82ca apps/web/app/globals.css:1574-1578 `.photo-slot-mount > img` has no filter, so the preview/wall mismatch 988cf4ed fixed does not exist. The old sepia rule now lives only in design-system/legacy/ppbf-leather-brass.css:3229.

Sketch: None.

### Dropped: Stop next dev regenerating apps/web/AGENTS.md and CLAUDE.md

Main chose the opposite: it keeps the generated file committed so the tree stays clean.

Evidence: Main 91de82ca apps/web/AGENTS.md:1-9 ('committing it with your work keeps the tree clean'). apps/web/CLAUDE.md = '@AGENTS.md'. next.config.ts has no suppression. Branch 43ffcc42.

Sketch: None.

### Dropped: Contrast sweep reporting gradient backgrounds as failures

A developer tool bug: the colour-contrast checker measures the flat colour behind a gradient and reports false failures. It still exists on main, but the tool isn't run in CI or referenced in current docs, so it catches nothing today.

Evidence: Main 91de82ca apps/web/scripts/contrast-sweep.mjs:137-138 bails only when the gradient sits over a transparent colour, so a gradient over an opaque colour is measured against that colour. Invoked only by the npm script 'sweep' (apps/web/package.json:359). No match in .github, docs/current, CLAUDE.md or AGENTS.md. Branch c6e65b8b.

Sketch: If the sweep is revived, port c6e65b8b's 'unverified: gradient ground, check by eye' bucket (about 30 lines). Otherwise consider deleting the tool.

## `claude/parent-guardian-completion-2y0ijf-scheduler-staff-fields`

### Bug on main: Families (and coaches) see a wrong seat count, e.g. 'Seats: 0/20' on a full class

The schedule page shows how many seats are taken, but the count only includes the viewer's own children. A parent can see '0/20' on a class that is full, press Register, get 'Class registration submitted.', and actually be put on the waitlist. Coaches see wrong numbers too, on classes they do not own.

Evidence: OBSERVED on main 91de82ca. apps/web/app/api/pilot/scheduler/route.ts:198-203 decorateClasses(store) counts store.registrations; route.ts:447-448 calls it as decorateClasses(filtered), where filtered = filterStateForActor(...). The parent branch (route.ts:~405-411) keeps only registrations for the guardian's linked athletes, the athlete branch only their own (route.ts:~418-423), and the coach branch only owned-class AND reachable-athlete rows (route.ts:~364-393). apps/web/app/schedule/page.tsx:363 prints `Seats: {item.registered_count ?? 0}/{item.capacity}`, and class status is not shown. The server does not refuse a full class: schedulerDb.ts:250 waitlists when registeredCount >= capacity, and page.tsx:380 shows the fixed text 'Class registration submitted.' no matter the outcome. The fix was in PR #832, but that PR was merged into this branch (base = scheduler-staff-fields) after #828 had already carried this branch to main, so it never reached main (gh pr view 832/828: both MERGED 2026-08-28, #832 base is not main).

Sketch: Change decorateClasses to take (classes, countFrom) and call decorateClasses(filtered.classes, store). Rows still come from the filtered store and the count comes from the full store. Port the route.ts hunk plus the three seat-count tests from ebf3ce07: the family count test, the 'still receives only their own registration row' check that no other athlete id or email leaks, and the coach count test. This adds no new access: it is a single number on a class every role already receives, with no athlete id or name, and a family can already see 'full' in class status.

### Bug on main: A guardian can tell a real registration id from a fake one (400 vs 403)

When a parent marks a registration as reviewed, main answers 'Missing registration record' (400) if the id does not exist, but 'Forbidden: parent not linked to athlete' (403) if the id belongs to another family's child. Those two answers let a parent test whether an id is real. The fix makes both cases return the same 'Not found'.

Evidence: OBSERVED on main 91de82ca. apps/web/app/api/pilot/scheduler/route.ts:685-688: `if (!registration) { throw new Error('Missing registration record'); }`. route.ts:690-691: parent then calls assertActorCanAccessAthlete, which throws 'Forbidden: parent not linked to athlete' (src/server/pilot/access.ts:401-402). src/server/pilot/http.ts:179-183 maps 'Forbidden' to 403 and 'Missing' to 400. The same-answer helper already exists on main: http.ts:122-123 hiddenNotFound() returns 404 {error:'Not found'}. Impact is low because ids are randomUUID (per the branch comment; register path, not re-checked here). The fix was in PR #833, which merged into the seat-count branch, then #832 merged into this branch. Neither reached main.

Sketch: In parent_review_registration: `if (!registration) return hiddenNotFound();` and wrap the parent's assertActorCanAccessAthlete in try/catch that returns hiddenNotFound(). Import hiddenNotFound from http.ts. Port the 6 tests in the 'parent_review_registration does not distinguish missing from forbidden' describe block from ebf3ce07, plus the two added schedulerDb mocks (getSchedulerRegistrationById, markSchedulerRegistrationReviewed). Main's test mock leaves these out, so this route path currently has no test coverage. Who may review is unchanged: parent, org admin and platform roles pass the same gates as before. One side effect: an admin who sends a bad id now sees 'Not found' instead of 'Missing registration record'.

### No longer a bug: Staff account ids and attendance notes hidden from families; route-gate allowlist cleanup

The branch's first commit already reached main. It stops parents and athletes seeing staff account ids (in practice staff emails) and coaches' attendance notes, and fixes the page and ParentHub comment to match. The allowlist cleanup commit is also already on main. Nothing here needs saving.

Evidence: OBSERVED: PR #828 (head = this branch, base main) MERGED 2026-08-28 as 5d19ef2f on main. Main route.ts:259-337 has isFamilyReader/familyClass/familyRegistration/familyCoachingRequest/familyAttendance, and route.ts:454-465 applies them. Main page.tsx:363-365 makes Coach: conditional. `git diff main ebf3ce07` shows the only unique route.ts code is the two items above. The branch's page.tsx and routeGateDeclaration.convention.test.ts differences with main come only from main being newer (#954 type floor), not from branch work.

Sketch: None. Once the two fixes above are ported, delete the branch.

## `claude/sparring-claim-honesty`

### Bug on main: Athlete help tells kids to check an academic status and avoid an academic hold that do not exist

On the athlete Schedule tab, the help still says 'Check your academic status first' and warns against 'Booking while on academic hold'. The app has no academic status or academic hold anywhere, so a kid is told to check something they can't find. The rule the app really enforces is never mentioned: if a coach has paused your training, class sign-up is refused. The Dashboard help has the same kind of line: 'Assuming academic status is still current'.

Evidence: OBSERVED on main 91de82ca: apps/web/components/AthleteWorkspace.tsx:3364 has usage 'Check your academic status first' and :3376 has mistakes 'Booking while on academic hold' (Schedule Session HelpPanel, tab 'schedule-session'). :2291 has 'Assuming academic status is still current' (My Dashboard HelpPanel), which the branch did not touch. No academic gate exists. apps/web/src/server/pilot/trainingHolds.ts:45-46: scopes are all_training | contact_only | conditioning_only, and reason categories are medical | fatigue | behavioral | administrative | other. infra/azure/pilot_slice_postgres.sql:794 has the same check. The only registration gate is schedulerDb.ts:216-229, where an active all_training hold returns outcome 'training_hold' with the hold's athlete_explanation and lift_condition_text (trainingHolds.ts:391-402). A git grep for 'academic' across apps/web .ts/.tsx, packages and infra .sql on main finds only these help lines, the Academics goal category, the public home page, and an unrendered Collegiate Track desc. Main also pins the false line as true: athleteWorkspace.test.tsx:3698 does expect(getByText('Booking while on academic hold')), with the comment 'keeps what is still true'. That came from A-FIN-01 (5cd818ec). How it goes wrong: a child opens Schedule > HELP and is told to check an academic status that no screen shows. The help also implies an academic block the gym never set. It gives no warning that a real training hold will refuse sign-up.

Sketch: In AthleteWorkspace.tsx, Schedule HelpPanel: drop 'Check your academic status first' and swap 'Booking while on academic hold' for a line about the hold that really exists. The branch's wording ('...registration is blocked until a coach lifts it') is slightly wrong: holds also expire on their own (expires_at, trainingHolds.ts:398-401), and org admins can lift them too (trainingHolds.ts:26-27). Suggested line: 'If your training is paused, class sign-up is refused until the hold is lifted or ends -- the message tells you why and what lifts it.' Remove 'Assuming academic status is still current' from the Dashboard HelpPanel (:2291). In athleteWorkspace.test.tsx:3698, re-anchor the test on the new line and add expect(queryAllByText(/academic/i)).toEqual([]) inside the expanded panel. Copy and test only; who may do what is unchanged.

### Owner question: Should school standing ever block training?

Nothing in the app blocks a kid from training over grades. An old Collegiate Track description says the app 'enforces academic passing standards' for floor access, but that text isn't shown anywhere and nothing enforces it. If you want an academic block, it's a new rule about who can train, so it's your call. Otherwise the help copy fix above is the whole job.

Evidence: OBSERVED on main 91de82ca: apps/web/components/trackAssignments.ts:72 has Collegiate Track desc 'Enforces academic passing standards as a requirement for on-floor training access.' Its only consumer, app/admin/page.tsx:1685, renders trackManifests[trackId].name and not desc, so the desc string is shown nowhere. Hold reason categories have no academic value (trainingHolds.ts:46, pilot_slice_postgres.sql:794). docs/current/OWNER_DECISIONS.md on main has no academic, school or grades entry (grep for academic|school|grades found only unrelated 'eligib' adjudication text).

Sketch: If Jason says no: delete or reword the Collegiate desc (tiny). If yes: the smallest version is a coach placing an all_training hold with an athlete_explanation such as 'grades check' -- it already blocks registration (schedulerDb.ts:222), and a dedicated 'academic' reason category would be a small migration plus UI. A separate school-status record would be medium or large and touches minors' privacy.

### No longer a bug: Sparring log claimed a coach reads every entry

The branch's main change stopped the Sparring Log telling kids 'Your coach sees it'. That already landed on main in PR #612, and #765 built on it, so nothing is left to carry over.

Evidence: OBSERVED on main 91de82ca: apps/web/app/athlete/dashboard/sparring/page.tsx:291-304 has the comment plus 'Saved to your training record.'. :308 has the partial-save line 'check your connection. What went through is on your record.'. :370 has the plaque 'Your training record'. :565 has the label 'Notes on how it went'. :613 has the footer 'It stays on your record...'. The test pins at page.test.tsx:146-150 assert that /coach sees|coach reads|hand your coach|coach should know/ are absent. The commits are 995e27f6 'The sparring log stops claiming a coach reads it (#612)' (the same 2 files) and 5bdcbb15 (#765), which added the staff variant.

Sketch: None.

### No longer a bug: Schedule help claimed RED readiness limits contact work

The branch also removed the 'Readiness RED may limit contact work' help lines. Main removed them in A-FIN-01 and has its own test for that.

Evidence: OBSERVED on main 91de82ca: AthleteWorkspace.tsx:3366-3374 has the comment recording their removal in A-FIN-01, and neither line appears in the usage or mistakes lists. athleteWorkspace.test.tsx:3686-3701 expands the panel and asserts both strings are absent, plus queryAllByText(/readiness/i) equals []. That is stricter than the branch's test.

Sketch: None.
