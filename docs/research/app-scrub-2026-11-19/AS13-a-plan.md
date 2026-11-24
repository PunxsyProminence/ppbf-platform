# AS13-a plan (read-only, step 1) -- one name per thing, words sweep, part a

Read at main 5f7f41d, 2026-11-24. Open PRs then: #2150 only (infra; touches none of these files). Plan only; no app file changed. Line numbers are OBSERVED on that SHA (all under apps/web/).

| Row | Current words (file:line) | New words | Source of the new words | Tests that pin the old words |
|---|---|---|---|---|
| CS-12c | VA app/coach/video-analysis/page.tsx:893 `<h2>Video Library</h2>` | "Session footage" | VA:794 "Upload session footage"; page LIB keeps "Video Library" (door buildingMap.ts:491, h1 LIB:121). INFERRED | none found |
| CS-12d | LIB app/coach/video-publications/library/page.tsx:125 intro "Every clip published to the gym's library, newest first." | one added line, see Q2 | code note LIB:24-25 (no playback control). INFERRED | none found |
| CS-16a | SH app/shadow/page.tsx:1570 "Use The Library and Research Intake." | "Use The Library and Research Inbox", each name a Link (/research/chat, /research) | doors buildingMap.ts:678 "The Library", :676 "Research Inbox". "Authority Boundary" line (SH:1565) untouched | none found |
| CS-16b | SH:350-351 `SCOUT ONLINE.` / `SCOUT ONLINE FOR ${role}.` | opens with the page heading, see Q4 | page h1 `{heading}` SH:1535 ("SHADOW" from buildHeading SH:385). "Shadow Scout" not renamed anywhere | app/shadow/page.test.tsx:205 asserts SCOUT ONLINE is absent (family); page.dna.test.tsx:127 is OMEGA, unaffected |
| CS-16c | SH:353 "Entered from {context}", SH:1549 "Context: {context}"; context fed by RoleStandaloneView.tsx:318 `${roleLabel} ${routeLabel}` (routeLabel is a web address on most pages) | the page's door name | BUILDING (buildingMap.ts) lookup by routeLabel; 38 of 40 literal routeLabel values are door hrefs. Fallback, see Q3 | none found |
| CS-18a | SM app/coach/sports-medicine/page.tsx:747 "Performance Analytics" | "Who to See First" (label only) | door buildingMap.ts:456, h1 app/coach/performance-analytics/page.tsx:481 | sports-medicine/page.test.tsx:2971 (link list), src/design/goldenEraClinicScope.test.ts:337 (pinned clinic control labels): both change with it |
| CS-18b | CW components/CoachWorkspace.tsx:4640 "Open Video Analysis Surface" | "Open Video Analysis" | brief; page is Video Analysis | coachWorkspaceHonesty.test.tsx:641 |
| CS-18c | CW:4826 "Open Progression Intelligence Surface" | "Open Progression Intelligence" | h1 progression-intelligence/page.tsx:939 | coachWorkspaceHonesty.test.tsx:678 |
| CS-18d | CW:4309 link "Your development" | "Your Coaching Growth"; tab CW:247 "Your Growth" stays | door buildingMap.ts:577, h1 development/page.tsx:380; tab pinned by glossaryWords.test.ts:101 | none for the link |
| CS-18h | PI app/coach/progression-intelligence/page.tsx:970 placeholder "Enter athlete ID (e.g., ath-001)" | see Q1 | INFERRED | progression-intelligence/page.test.tsx:100 and :231 find it by placeholder |
| ATH-06 rem. | DLT components/doorLabelsMatchTitles.test.ts:35 still exempts `/profile` ("the shell prints roleLabel \"Your Profile\" as the h1"). #2147 (c99cb35) set the door to "Your Profile" and added a door-only test (DLT:~101) | remove `/profile` from the exempt list so the scan checks it. The page has no literal h1 (app/profile/page.tsx:25 passes `roleLabel="Your Profile"`; RoleStandaloneView.tsx:249 prints it), so the scan must also read a page's `roleLabel="..."` literal for exempt-listed doors; exact change settled when built, tested to fail with the label changed | OD-2026-11-20-001 (OW27-15 A); #2147 | the same file |
| FAM-18 rem. | PV app/parent/progression-visibility/page.tsx:403 fallback "Parent Progression Visibility" | "Progress Visibility" (child-named title unchanged) | door buildingMap.ts:361; eyebrow PV:401 already reads it | none found |
| PH | ParentHub.tsx:1666 "Open Scheduler" | "Open Schedule" | OW27-13 (OD-2026-11-20-001), page title; AthleteCorner.tsx:204 already reads it | parentHubOverviewOrder.test.tsx:10,98 (the athleteCorner.test.tsx:252 absence check stays true) |

Already fixed by a merged PR (dropped): the /profile door label (#2147, c99cb35). Nothing else of these rows found already done.

Allowlist (files): the 12 codes in the brief, plus RoleStandaloneView-adjacent test files named above (sports-medicine/page.test.tsx, goldenEraClinicScope.test.ts, coachWorkspaceHonesty.test.tsx, parentHubOverviewOrder.test.tsx, progression-intelligence/page.test.tsx, shadow tests). Size: about 60 changed lines outside tests, about 60 in tests. No permission, role or gate change; no migration; no new warning or gate.

## Questions

All four: "Checked, not answered in: OWNER_DECISIONS.md (OW27-13, OW27-15), docs/research/app-scrub-2026-11-19/ stage 1 and 3, this brief, this PR's comments (none yet)."

1. QUESTION FOR App Overwatch: CS-18h placeholder. The brief says the box shows only when the roster read fails; the code (PI:952, :408-409, :431) also shows it before the roster answers and when the roster is empty, so "The roster could not be read." would be false then. Options: A (Recommended): "Type the athlete's ID." (true in all three cases); B: "The roster could not be read. Type the athlete's ID." as briefed, only if the box is shown on failure alone (needs a failure flag, small code change); C: leave as is. Source of A: the code.
2. QUESTION FOR App Overwatch: CS-12d exact line. A card shows title, description, tags and date (LIB:17-18), so "Titles and tags only" is not exact. Options: A (Recommended): "This page has no player."; B: "Titles, descriptions and tags only; this page has no player."; C: as briefed.
3. QUESTION FOR App Overwatch: CS-16c fallback. Where the page has no door (2 of 40 routeLabels: "/coach/review-queue", and "Session Plans" which is already a name), show: A (Recommended): the page's own heading (roleLabel); B: nothing (no Context line).
4. QUESTION FOR App Overwatch: CS-16b. The opener `SCOUT ONLINE.` (when a subject is set, SH:350) has no role code. Options: A (Recommended): both openers become `${heading}.` ("SHADOW." / "<SUBJECT> SHADOW."), so no "Scout" word remains in the welcome; B: only the role-code opener (SH:351) changes, as briefed.
