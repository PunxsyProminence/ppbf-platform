# Test Pin Map

What a UI redesign needs before it renames anything: which visible strings — labels,
headings, button names, empty states, error copy — are asserted on by component/page
tests, and which role surface(s) each string lives on. Rename a pinned string and the
tests listed next to it fail; the more file:line pairs listed, the more expensive the
rename.

## Scope and method

- **Scanned:** every `apps/web/components/**/*.test.tsx` and `apps/web/app/**/*.test.tsx`
  file — 103 files total. `*.pg.test.ts` and pure API route tests were out of scope and
  were not touched.
- **Extraction:** a script scanned all 103 files for calls to `getByText`, `findByText`,
  `queryByText`, `getAllByText`, `findAllByText`, `queryAllByText`, `getByLabelText`
  (+ `find`/`query`/`getAll` variants), `getByPlaceholderText` (+ variants),
  `toHaveTextContent`, and `getByRole`/`findByRole`/`queryByRole`/`getAllByRole` **only
  when called with a `name:` matcher** (a bare `getByRole('button')` with no name is a
  structural assertion, not a text pin, and was excluded). This produced 2,052 raw call
  sites, of which **1,375** resolved to an actual literal string or regex being pinned
  (the remainder were bare structural role queries or assertions on a runtime variable,
  e.g. `getByText(handoff)`, which pin a shape, not a string).
- **Role surface** was assigned from the file's path first, then confirmed against the
  component under test and, for ambiguous routes, the `RoleSessionGate`
  `allowedRoles` / `requirePageRole` guard actually present in the corresponding
  `page.tsx`. Sections below note the guard where it disambiguates.
- **Sampling:** surfaces with a handful of files are shown close to exhaustively.
  Surfaces with many files (Admin: 26 files/445 pins, Coach: 20 files/431 pins) are
  covered representatively — every file is counted in the totals, but the table shows
  a sample drawn from the highest-pin-count files in that surface, called out under
  each table. No file:line in this document was invented; every row was pulled
  directly from the extraction script's output against the current tree.
- **The `athleteWorkspace.test.tsx` two-level nav pattern:** this file was recently
  updated so most tests no longer click a tab by its own name. `AthleteWorkspace`'s
  tabs are grouped two levels deep (six groups: Today, Development, Learn, Schedule,
  Messages, SHADOW), so the test file's `openTab(label)` helper presses the group
  button first, then the surface button within it, and only falls back to a single
  click when a group holds one surface. Concretely: `openTab('Goals')` clicks
  `Development` then `Goals`; `openTab('Schedule')` clicks only `Schedule` because that
  group holds no other surface. **This means the pinned strings for reaching a tab are
  now the group label AND the surface label** — renaming a group name (`Today`,
  `Development`, `Learn`, `Schedule`, `Messages`, `SHADOW`) breaks every test that
  reaches anything filed under it, not just tests naming that tab directly. The
  `GROUP_FOR_SURFACE` map living in the test file (lines 184–196) is a second,
  hand-maintained pin of the redesign's tab taxonomy and should be treated as part of
  the blast radius for any nav restructuring.

Total legitimate text pins found: **1,375**, across all 103 in-scope files.

---

## Athlete

**Files:** 10 (`athlete/dashboard`, `athlete/dashboard/sparring`,
`athlete/progression-intelligence` pages; `AthleteWorkspace`, `AthleteAchievements`,
`PersonalGoalBoard`, `TrainingCard` [+ ceremony variant], `ThenAndNow`,
`WordsOnTheWall`). **Pins counted: 112** (`AthleteWorkspace` alone contributes 78 of
these across its 95 raw call sites — the rest are structural role queries).
`PersonalGoalBoard`, `ThenAndNow`, and `WordsOnTheWall` are mounted **inside**
`AthleteWorkspace`/`TrainingCard` and are tested standalone as well as through the
parent — a rename in one of them can break both the standalone test and the workspace
test.

| Pinned string | Test file:line | Component |
|---|---|---|
| `Unavailable - not yet tracked` | `apps/web/components/athleteWorkspace.test.tsx:223` | AthleteWorkspace |
| `Open Unified Scheduler` (role: link) | `apps/web/components/athleteWorkspace.test.tsx:232` | AthleteWorkspace |
| `Start Assessment` (role: button, disabled) | `apps/web/components/athleteWorkspace.test.tsx:239` | AthleteWorkspace |
| `+ New SMART Goal` — **6 occurrences**, lines 246, 273, 693, 721, 805, 835 | `apps/web/components/athleteWorkspace.test.tsx` | AthleteWorkspace |
| `Goal title` (placeholder) — 3 occurrences | `apps/web/components/athleteWorkspace.test.tsx:248,275,695` | AthleteWorkspace / PersonalGoalBoard |
| `Goal target date` (label) — 3 occurrences | `apps/web/components/athleteWorkspace.test.tsx:254,281,699` | AthleteWorkspace / PersonalGoalBoard |
| `Create Goal` (role: button) — 3 occurrences | `apps/web/components/athleteWorkspace.test.tsx:257,284,702` | AthleteWorkspace / PersonalGoalBoard |
| `Check In` / `Check Out` (role: button) — 12 combined occurrences, lines 328–525 | `apps/web/components/athleteWorkspace.test.tsx` | AthleteWorkspace |
| `From the Gym` — 3 occurrences (491, 508, 520) | `apps/web/components/athleteWorkspace.test.tsx` | AthleteWorkspace (renders AnnouncementBanner) — also pinned in Coach and Parent surfaces, see "Highest blast radius" |
| `Gym Notices` | `apps/web/components/athleteWorkspace.test.tsx:509` | AthleteWorkspace — also pinned in Parent surface |
| `Nothing on the board.` — 2 occurrences | `apps/web/components/athleteWorkspace.test.tsx:513,523` | AthleteWorkspace |
| `Biomechanics of Kinetic Force Transfer` — 3 occurrences (574, 586, 597) | `apps/web/components/athleteWorkspace.test.tsx` | AthleteWorkspace — same title also pinned in Coach (`coachWorkspaceHonesty`, `research/page`) |
| `Messages` (role: button) — 2 occurrences | `apps/web/components/athleteWorkspace.test.tsx:846,859` | AthleteWorkspace |
| `Ask SHADOW` (role: button) | `apps/web/components/athleteWorkspace.test.tsx:848` | AthleteWorkspace |
| `Report progress for Land 100 clean jabs` (label) — 3 occurrences | `apps/web/components/athleteWorkspace.test.tsx:736,761,776` | AthleteWorkspace/PersonalGoalBoard |
| `Hands up, chin down.` | `apps/web/components/athleteWorkspace.test.tsx:488` | AthleteWorkspace (rendered coaching cue) |
| `Open your Family Dashboard` — cross-referenced (see Parent/Guardian) | `apps/web/app/guardian/page.test.tsx:35` | GuardianPortalPage (linked from athlete-adjacent flows) |

**Group nav pin (see method note above):** `Today`, `Development`, `Learn`, `Schedule`,
`Messages`, `SHADOW` — 6 strings that gate every tab beneath them via `openTab`.
Renaming any one is not a one-line fix in the test file; it changes which tests can
even reach their target tab.

---

## Coach

**Files:** 20 — the second-largest surface by pin count, just behind Admin.
**Pins counted: 431.** Includes 15 `app/coach/*` pages, `app/rabbit-holes/page.test.tsx`
(coach-authored lesson queue, gated `['coach','admin']`), and 4 standalone components
(`CoachMilestoneMarker`, `CoachRecognitionPad`, `CoachWorkspace` [tested via
`coachWorkspaceHonesty.test.tsx`, 66 pins], `SessionScriptLiveDelivery`, 67 pins — the
second- and third-largest test files in the whole corpus by pin count, behind only
`athleteWorkspace.test.tsx`'s 78). Sample below draws from the four highest-pin files
plus two representative page tests.

| Pinned string | Test file:line | Component |
|---|---|---|
| `Athlete` (label) — 5 occurrences across files | `apps/web/components/coachWorkspaceHonesty.test.tsx:153` (+ 4 more in Admin, see blast radius) | CoachWorkspace |
| `Acknowledge` (role: button) — 6 occurrences | `apps/web/components/coachWorkspaceHonesty.test.tsx:323,338,342,360,378,382` | CoachWorkspace — also pinned in Admin (`compliance-center`) |
| `Approve` / `Reject` (role: button) — 6 combined occurrences | `apps/web/components/coachWorkspaceHonesty.test.tsx:764,778,779,789,809` | CoachWorkspace — also pinned in Admin |
| `Session` (label) — 8 occurrences (251, 426, 577, 596, 642, 669, 689, 711, 718, 720) | `apps/web/components/coachWorkspaceHonesty.test.tsx` | CoachWorkspace |
| `Save Coach Review` / `Saving` (regex role name) — 5 occurrences | `apps/web/components/coachWorkspaceHonesty.test.tsx:255,258,274,508,598,619` | CoachWorkspace |
| `Not Started` / `In Progress` / `Completed` | `apps/web/components/coachWorkspaceHonesty.test.tsx:189-191` | CoachWorkspace |
| `Pause session` (role: button) — 6 occurrences | `apps/web/components/sessionScriptLiveDelivery.test.tsx:174,211,221,236,252,253,434,451` | SessionScriptLiveDelivery — same string in `coach/session-scripts/page.test.tsx:387` |
| `End session...` (role: button) — 6 occurrences | `apps/web/components/sessionScriptLiveDelivery.test.tsx:175,337,354,387,401,412` | SessionScriptLiveDelivery — same string in `coach/session-scripts/page.test.tsx:379` |
| `Record as completed` (role: button) — 5 occurrences | `apps/web/components/sessionScriptLiveDelivery.test.tsx:339,345,363,403,415` | SessionScriptLiveDelivery — same string in `coach/session-scripts/page.test.tsx:380` |
| `What happened` (label) — 6 occurrences | `apps/web/app/coach/decision-loop/page.test.tsx:188,213,237,257,277,298`, `apps/web/app/coach/intervention-review/page.test.tsx:91` | DecisionLoopReviewPage / InterventionReviewPage |
| `Log Note` / `Send to Family` / `File Incident Report` (role: button) | `apps/web/app/coach/decision-loop/page.test.tsx:71,95,104,114,130,154,163,173,189` | DecisionLoopReviewPage |
| `Forbidden` — 2 occurrences | `apps/web/app/coach/decision-loop/page.test.tsx:116,175` | DecisionLoopReviewPage — same string in Parent/Guardian and Board |
| `Publish` / `Submit for review` (role: button) — 9 & 6 occurrences respectively | `apps/web/app/coach/video-publications/page.test.tsx:69,81,82,127,160,174,182,194,209,242,245,260,261` | CoachVideoPublicationsPage — `Publish` is the single most repeated action name in the corpus (see blast radius) |
| `Open Floor` — 3 occurrences | `apps/web/app/coach/cohorts/page.test.tsx:99,137,259` | CoachCohortsPage |
| `No assessed level in composure.` — 3 occurrences | `apps/web/app/coach/cohorts/page.test.tsx:180,226,232` | CoachCohortsPage |
| `Rounds` (label) — 4 occurrences | `apps/web/app/coach/intervention-executions/page.test.tsx:100,131`, `apps/web/app/coach/intervention-protocols/page.test.tsx:89,117` | InterventionExecutionsPage / InterventionProtocolsPage |
| `Retire` (role: button) — 5 occurrences | `apps/web/app/rabbit-holes/page.test.tsx:267,270,279,296`, `apps/web/app/notices/page.test.tsx:179` | RabbitHolesPage — same string in Staff surface (`NoticesPage`) |
| `Biomechanics of Kinetic Force Transfer` | `apps/web/components/coachWorkspaceHonesty.test.tsx` (via research library reference) | CoachWorkspace — same title pinned in Athlete surface |

---

## Parent / Guardian

**Files:** 8 — `guardian/page`, `guardian/dashboard/page`, `parent/consent/page`,
`parent/progression-visibility/page`, `parent/safety/page`, `ParentDigest`,
`ParentHubChildSwitch` (38 pins), `PaymentSetupBubble`. **Pins counted: 93.**

| Pinned string | Test file:line | Component |
|---|---|---|
| `Open your Family Dashboard` (role: link) | `apps/web/app/guardian/page.test.tsx:35` | GuardianPortalPage |
| `What the Family Dashboard Covers` / `What You Can See Here` | `apps/web/app/guardian/page.test.tsx:54-55` | GuardianPortalPage |
| `Consent needed` / `Consent on file` — 2 each | `apps/web/app/parent/consent/page.test.tsx:61,70,96,109,130` | GuardianMediaConsentPage |
| `Grant Consent` / `Withdraw Consent` (role: button) — 3 & 4 occurrences | `apps/web/app/parent/consent/page.test.tsx:62,71,72,98,111,132,164` | GuardianMediaConsentPage |
| `No linked children found` — 5 occurrences across 2 files | `apps/web/app/parent/consent/page.test.tsx:142,151`, `apps/web/app/parent/safety/page.test.tsx:105,114,123` | GuardianMediaConsentPage / GuardianSafetyPage |
| `Database unavailable` — 2 occurrences (this surface's share of an 8-file string) | `apps/web/app/parent/consent/page.test.tsx:150`, `apps/web/app/parent/safety/page.test.tsx:122` | see "Highest blast radius" |
| `Rear foot stays flat through the cross.` — 2 occurrences | `apps/web/app/parent/progression-visibility/page.test.tsx:123,142` | ParentProgressionVisibilityPage — same coaching cue also pinned in Coach surface |
| `Training is paused right now` | `apps/web/app/parent/safety/page.test.tsx:67,78` | GuardianSafetyPage |
| `Contact Requires Medical Clearance` | `apps/web/app/parent/safety/page.test.tsx:86` | GuardianSafetyPage |
| `Photo & Video Consent` (role: link) | `apps/web/app/parent/safety/page.test.tsx:106` | GuardianSafetyPage |
| `Gym Notices` / `From the Gym` — 2 each | `apps/web/components/parentHubChildSwitch.test.tsx:162,163,174` | ParentHub — same strings pinned in Athlete/Coach surfaces |
| `Second Child` / `First Child` (role/text, mixed) — 8 combined occurrences | `apps/web/components/parentHubChildSwitch.test.tsx:91,98,107,110,113,114,175,237,250,362,373` | ParentHub |
| `View Safety Status` / `Manage Consent` (role: button) | `apps/web/components/parentHubChildSwitch.test.tsx:189,190,236` | ParentHub |
| `Send to Coach` (role: button) — 5 occurrences | `apps/web/components/parentHubChildSwitch.test.tsx:259,279,297,306,316` | ParentHub |
| `Finish connecting payments` | `apps/web/components/paymentSetupBubble.test.tsx:45` | PaymentSetupBubble |

---

## Admin

**Files:** 26 — the surface with the most pins. **Pins counted: 445** across the 24
`app/admin/*` pages plus `director/dashboard` (gated `requirePageRole(['organization_admin'])`)
and `audit/page` (gated `['admin','coach']`). Sample below is drawn from the
heaviest-pinned files (`video-compliance` 59 raw / ~55 kept, `people` 53, `bulkCapabilities`
54, `board-seats` 30, `coach-coverage` 31, `import` 29, `portrait-review` 20,
`activation-codes`, `waiver-status`, `athlete-consent`, `safety-review`, `video-review`,
`consent`, `memberships`, `feedback`, `compliance-center`, `safety-flags`, `attendance`,
`athletes`, `admin/page` [capabilities console]) — a representative cut across roughly
half the files in the surface, not an exhaustive listing of all 445 pins.

| Pinned string | Test file:line | Component |
|---|---|---|
| `Database unavailable` — appears in 6 admin files (of its 8 total, see blast radius) | `apps/web/app/admin/athlete-consent/page.test.tsx:106`, `coach-coverage/page.test.tsx:116`, `portrait-review/page.test.tsx:63`, `safety-review/page.test.tsx:99`, `video-compliance/page.test.tsx:139`, `waiver-status/page.test.tsx:127` | 6 different admin pages |
| `Sample Athlete One` — 15 occurrences across 4 admin files | `apps/web/app/admin/coach-coverage/page.test.tsx:98,125,155,189,203,213,233`, `consent/page.test.tsx:78,92`, `portrait-review/page.test.tsx:46,80,97,119,145,173`, `video-compliance/page.test.tsx:72` | test-fixture athlete name, not chrome copy — flagged so a redesign doesn't mistake it for a rename target |
| `Athlete` (label) — 5 occurrences | `coach-coverage/page.test.tsx:127,157,165,177,182`, `consent/page.test.tsx:79`, `memberships/page.test.tsx:86,133`, `people/page.test.tsx:181,200,268` | shared form-field label, also pinned in Coach |
| `Approve` / `Reject` (role: button) — combined 8 occurrences | `portrait-review/page.test.tsx:82,99,121,147,175`, `video-compliance/page.test.tsx:159,180,193,208,256,306,332` | PortraitReviewPage / VideoCompliancePage — same strings pinned in Coach (`coachWorkspaceHonesty`) |
| `Acknowledge` / `Escalate` / `Dismiss` / `Resolve` (role: button) | `apps/web/app/admin/compliance-center/page.test.tsx:67-79,94,107,118,144` | ComplianceCenterPage |
| `Jordan T.` — 5 occurrences | `attendance/page.test.tsx:98`, `safety-review/page.test.tsx:57`, `waiver-status/page.test.tsx:57,85,90` | test-fixture person name, cross-referenced in Parent surface too |
| `Platform console` (role: link/button) — 2 occurrences | `activation-codes/page.test.tsx:50`, `video-review/page.test.tsx:49` | ActivationCodesManagementPage / VideoReviewManagementPage |
| `Nothing in this view` — 7 occurrences | `athlete-consent/page.test.tsx:98,108`, `waiver-status/page.test.tsx:66,74,98,119,128` | AthleteConsentAuditPage / WaiverComplianceAuditPage |
| `All athletes` / `All signed` (role: button) | `athlete-consent/page.test.tsx:86`, `waiver-status/page.test.tsx:76,87` | shared filter-toggle pattern |
| `Capability Library` / `Overview` / `Assignment Board` (role: button/heading) | `apps/web/app/admin/page.test.tsx:171,180,194,195,197,199,200` | AdminCapabilitiesPage |
| `DELETE 1 CAPABILITY` / `DELETE 5 CAPABILITIES` / `SET BLOCKED` / `SET DRAFT` / `SET ARCHIVED` / `UNDO` (regex role names) | `apps/web/app/admin/bulkCapabilities.test.tsx:157,158,193,211,224,251,262,279,294,305,306,318,319,334,337,345,354,357,368,369,372,385,386,389,390,396,409,417,427` | AdminCapabilitiesPage (bulk toolbar) — 20+ occurrences alone, entirely internal to one file |
| `Board Chair` — 7 occurrences | `apps/web/app/admin/board-seats/page.test.tsx:114,129,148,179,195,214,232` | BoardSeatsPage |
| `Forbidden: role not allowed` | `apps/web/app/admin/board-seats/page.test.tsx:250` | BoardSeatsPage |
| `Roster CSV` (label) / `What this would do` — 8 occurrences | `apps/web/app/admin/import/page.test.tsx:61,71,72,81,83,87,88,89,96` | RosterImportPage |
| `Internal server error` — 2 occurrences | `apps/web/app/admin/feedback/page.test.tsx:244` (+ 1 elsewhere) | FeedbackTriagePage |
| `Marked triaged.` / `Nobody has sent anything yet.` | `apps/web/app/admin/feedback/page.test.tsx:108,210,245` | FeedbackTriagePage |
| `Who signed` / `Date signed` / `What was signed` (labels) | `apps/web/app/admin/consent/page.test.tsx:100-102,127-128,202` | ConsentPage |
| `No open safety flags` — 2 occurrences | `apps/web/app/admin/safety-flags/page.test.tsx:130,140` | SafetyFlagsBoardPage |
| `Active Training Holds (1)` / `Failing Safety Gates (1)` / `Open Escalations (1)` | `apps/web/app/admin/safety-review/page.test.tsx:56,73,89` | SafetyReviewPage |
| `Video "vid-101" approved — status updated to ready.` / `Video "vid-102" blocked — status remains quarantined.` | `apps/web/app/admin/video-review/page.test.tsx:182,228` | VideoReviewManagementPage |

---

## Board

**Files:** 7 — `board/page`, `board/compliance-monitoring/page`,
`board/escalation-monitoring/page`, `board/BoardSummaryPanel`, `BoardMemberDashboard`,
`BoardRoleGate`, `BoardSeatEvidence`. **Pins counted: 48.**

| Pinned string | Test file:line | Component |
|---|---|---|
| `Suppressed` — 3 occurrences | `apps/web/app/board/BoardSummaryPanel.test.tsx:101`, `board/compliance-monitoring/page.test.tsx:103`, `board/page.test.tsx:66` | BoardSummaryPanel — shown on 3 separate board routes |
| `Measured 2026-07-24 12:00 UTC` — 2 occurrences | `apps/web/app/board/BoardSummaryPanel.test.tsx:119`, `board/page.test.tsx:65` | BoardSummaryPanel |
| `Unable to load the organization aggregate.` | `apps/web/app/board/BoardSummaryPanel.test.tsx:125` | BoardSummaryPanel |
| `None open` / `Read this zero correctly` | `apps/web/app/board/escalation-monitoring/page.test.tsx:75,76,95,121` | BoardEscalationMonitoringPage |
| `new (suppressed)` / `acknowledged (9)` / `escalated (none filed)` / `All (14)` (role names) | `apps/web/app/board/compliance-monitoring/page.test.tsx:122-125,146,157` | BoardComplianceMonitoringPage |
| `Treasurer Workspace` / `Secretary Workspace` / `President Workspace` / `Program & Safety Director Workspace` (role: button/heading) | `apps/web/components/BoardMemberDashboard.test.tsx:64,72,82,91,97,106` | BoardMemberDashboard |
| `Board hub` (role: link) | `apps/web/components/BoardMemberDashboard.test.tsx:84` | BoardMemberDashboard |
| `Not stored by this platform` / `PLANNED \| FRONT-END PLACEHOLDER \| BACKEND REQUIRED` | `apps/web/components/BoardMemberDashboard.test.tsx:122,146` | BoardMemberDashboard |
| `role:board seats:treasurer,at-large` / `role:board seats:none` / `role:platform_owner seats:none` | `apps/web/components/BoardRoleGate.test.tsx:60,67,74` | BoardRoleGate |
| `Physical Injury Prevention` | `apps/web/components/boardSeatEvidence.test.tsx:58` | BoardSeatEvidence |
| `Gym closed Monday for the holiday.` | `apps/web/components/boardSeatEvidence.test.tsx:99` | BoardSeatEvidence — same announcement text also pinned on the Staff (`workspace/page`) and Public (`WallDisplay`) surfaces |

---

## Staff / Operations

Cross-role operational tooling that isn't gated to a single role: the staff/volunteer
workspace hub, the operations hub and its two league/competition sub-pages (gated
`['coach','admin']`), the shared chalkboard composer (gated
`['coach','admin','platform_owner','board']`), the notices board (gated
`['admin','coach','platform_owner','board']`), the research intake/chat tools, and the
scheduler. **Files:** 9. **Pins counted: 110.**

| Pinned string | Test file:line | Component |
|---|---|---|
| `SHADOW COMMAND NODE` / `SHADOW Monitoring` / `Notices & Motivation` / `Video Review Intelligence` / `AI Video Analysis` / `Closed-Loop Progression Intelligence` / `Sports Medicine` / `Performance Analytics` / `Wrestling League Management` / `External Competition Platform` / `Membership Tracking` / `Scholarship Tracking` / `Publication Workflow Automation` (role: heading, one per hub tile) | `apps/web/app/operations/page.test.tsx:74-208` | OperationsHubPage — **each of these tile labels duplicates the target page's own heading; renaming a coach/admin feature name means updating it here too** |
| `Session Script Delivery` / `Safety Compliance Center` / `Coach Coverage` / `Drill Library` | `apps/web/app/operations/page.test.tsx:220-223,230` | OperationsHubPage |
| `write on the board` (regex role name) — 3 occurrences | `apps/web/app/chalkboard/page.test.tsx:76,99,130` | ChalkboardPage |
| `Everywhere` / `The athletes' board` / `The coaches' board` / `The parents' board` | `apps/web/app/chalkboard/page.test.tsx:78-81` | ChalkboardPage — audience picker; each string names a different role surface's chalkboard |
| `put it up` (regex role name) — 2 occurrences | `apps/web/app/chalkboard/page.test.tsx:110,139` | ChalkboardPage |
| `Everything Posted` / `Live Right Now` (role: heading) | `apps/web/app/notices/page.test.tsx:93,108,184` | NoticesPage |
| `LIVE` / `SCHEDULED` / `EXPIRED` / `RETIRED` | `apps/web/app/notices/page.test.tsx:94-97` | NoticesPage |
| `Publish` (role: button) — 2 occurrences | `apps/web/app/notices/page.test.tsx:137,161` | NoticesPage — same string, much heavier reuse, in Coach surface |
| `Retire` / `Restore` (role: button) | `apps/web/app/notices/page.test.tsx:179,183` | NoticesPage |
| `What should this surface say?` / `Your name, as members will see it` (placeholders) | `apps/web/app/notices/page.test.tsx:127,130,155,156` | NoticesPage |
| `Add competition` / `Save competition` / `Open entries` / `Add entry` (role: button) | `apps/web/app/operations/external-competition/page.test.tsx:102,110,131,140,160,166` | ExternalCompetitionPlatformPage |
| `Add season` / `Save season` / `Open detail` / `Add to roster` (role: button) | `apps/web/app/operations/wrestling-league/page.test.tsx:112,119,135,142,145,165,171` | WrestlingLeagueManagementPage |
| `This athlete is already entered in this competition.` / `This athlete is already on the season roster.` | `apps/web/app/operations/external-competition/page.test.tsx:169`, `apps/web/app/operations/wrestling-league/page.test.tsx:174` | near-duplicate copy across sibling pages |
| `Answer this gap` / `Mark Resolved` / `Save Requirement` / `Submit source` / `Register general research` (role: button) | `apps/web/app/research/page.test.tsx:88,90,91,104,112,135,141,209` | ResearchIntakePage |
| `Add Note To Transcript` (role: button) — 3 occurrences | `apps/web/app/research/chat/page.test.tsx:48,65,78` | ResearchQAChatPage |
| `Write your findings...` (placeholder) — 4 occurrences | `apps/web/app/research/chat/page.test.tsx:43,60,69,75` | ResearchQAChatPage |
| `Class Schedule` — 3 occurrences | `apps/web/app/schedule/schedulerReload.test.tsx:109,120,137` | SchedulerPage |
| `Loading scheduler...` | `apps/web/app/schedule/schedulerReload.test.tsx:129` | SchedulerPage — the reload-identity string the whole test file exists to protect |
| `Gym notices are temporarily unavailable.` / `Open gym moves to 6pm on Thursday.` | `apps/web/app/workspace/page.test.tsx:105,118` | WorkspacePage (staff/volunteer hub, gated `['staff','volunteer']`) |

---

## Shadow

The SHADOW AI console and its chat/evidence rendering primitives. **Files:** 4
(`admin/shadow/page` — tested under `organization_admin`, i.e. reached through the
Admin console but is its own feature surface; `ShadowCommandFeed`;
`ShadowEvidenceDisplay`; `ShadowMessageRender`). **Pins counted: 13** — the smallest
surface in scope, and the one most worth double-checking by hand before any rename,
since a small pin count here is easy to miss in a bulk find-and-replace pass.

| Pinned string | Test file:line | Component |
|---|---|---|
| `VIEW` / `APPROVE` (role: button) | `apps/web/app/admin/shadow/page.test.tsx:125,139,147` | AdminShadowConsolePage |
| `upload pdf` / `approve for learning` / `document security review` (regex role names) | `apps/web/app/admin/shadow/page.test.tsx:122,130,131,137,140,141` | AdminShadowConsolePage |
| `observation_recorded` / `projection_read` / `event` / `telemetry` | `apps/web/components/shadowCommandFeed.test.tsx:72-75` | ShadowCommandFeed |
| `[E:1] SHADOW Canonical Authority Model — Authority Model` (regex match) | `apps/web/components/shadowEvidenceDisplay.test.tsx:66` | ShadowEvidenceDisplay |
| `[E:2] USA Boxing Safety Rules — Rulebook 2026` (regex match) | `apps/web/components/shadowEvidenceDisplay.test.tsx:67` | ShadowEvidenceDisplay |

---

## Public / Auth

The signed-out login screen, the public marketing page, and the unattended gym-wall
kiosk displays that run with no session at all. **Files:** 4 (`login/page`,
`public/photoSlots` [`PublicPortalPage`], `WallDisplay`, `WallOfNames`). **Pins
counted: 28.**

| Pinned string | Test file:line | Component |
|---|---|---|
| `Continue With Microsoft` (+ regex `/Microsoft/`) | `apps/web/app/login/page.test.tsx:92,104` | LoginPage |
| `Doors open at 4 on Saturday.` | `apps/web/app/login/page.test.tsx:73` | LoginPage (renders a live announcement even signed out) |
| `WHO WOULD BE COACHING YOUR KID` / `WHAT WE ACTUALLY RUN` / `QUESTIONS PEOPLE ACTUALLY ASK` | `apps/web/app/public/photoSlots.test.tsx:71,99,100` | PublicPortalPage |
| `Closed Monday for the holiday.` | `apps/web/components/wallDisplay.test.tsx:349` | WallDisplay — same announcement text pinned in Board (`boardSeatEvidence`) |
| `People on this wall` / `Nobody is on the wall yet` / `The wall did not load` | `apps/web/components/wallOfNames.test.tsx:94,105,124,125` | WallOfNames |
| `Training now` / `Came through` / `Not recorded` / `Year not recorded` | `apps/web/components/wallOfNames.test.tsx:76,77,107,143` | WallOfNames |

---

## Shared chrome (cross-role — not one surface)

These components render inside more than one role surface's shell, so a rename here
ripples across every surface listed, not just one. Grouped separately because the task's
per-role framing doesn't fit them cleanly — flagging that explicitly matters more than
forcing them into one bucket. **Files:** 15 (`GlobalRoleHeader`, `AnnouncementBanner`,
`CommandsOverlay`, `CardCatalog` [+ `CardCatalogActs`], `FeedbackBox`,
`RoleSession.snapshotStability`, `RoleStandaloneBreadcrumbs`, `RabbitHole` [+
`HelpPanel`], `Chalkboard` [component, distinct from the staff `ChalkboardPage`],
`GymWallModule`, `useGymSound`, `ProfilePortrait`, `PrintArtifacts`). **Pins counted: 95.**

| Pinned string | Test file:line | Component | Mounted in |
|---|---|---|---|
| `Gym closed Monday for the holiday.` | `apps/web/components/chalkboard.test.tsx` (item fixture, see also boardSeatEvidence/wallDisplay above) | Chalkboard | AthleteWorkspace, ParentHub, ChalkboardPage (staff), admin/customize |
| — (Chalkboard is mounted in 4 different surfaces' components: `AthleteWorkspace.tsx`, `ParentHub.tsx`, `app/chalkboard/page.tsx`, `app/admin/customize/page.tsx`) | n/a | Chalkboard | Athlete, Parent, Staff, Admin |
| — (GymWallModule is mounted in both `AthleteWorkspace.tsx` and `ParentHub.tsx`) | n/a | GymWallModule | Athlete, Parent |
| — (CardCatalog is mounted from `GlobalRoleHeader.tsx`, reachable from every signed-in role's chrome) | n/a | CardCatalog | all roles |
| The box a child might type a disclosure into (comment-derived; box text not hard-pinned) | `apps/web/components/feedbackBox.test.tsx` | FeedbackBox | mounted from GlobalRoleHeader — reachable from every role |
| the eight keyboard shortcuts registered in `SHORTCUTS` | `apps/web/components/commandsOverlay.test.tsx` | CommandsOverlay | reachable from every role via keyboard chord |
| `[value]` of `RABBIT_HOLE_ANCHOR_TYPES` (see `rabbitHole.test.tsx` describe blocks) | `apps/web/components/rabbitHole.test.tsx:78,134,223` | RabbitHole / HelpPanel | embedded in AthleteWorkspace and other role summary panels |

Because `AnnouncementBanner`'s rendered heading (`From the Gym`) and empty state
(`Nothing on the board.` / `Gym Notices`) are asserted directly inside `AthleteWorkspace`,
`CoachWorkspace`, and `ParentHub`'s own test files rather than only in
`announcementBanner.test.tsx`, those strings are listed under Athlete/Coach/Parent above
as well as here — see "Highest blast radius" for the combined count.

---

## Highest blast radius

The 10 strings whose rename would break the most tests, ranked by total assertion
occurrences found across the corpus (ties broken by number of distinct files/surfaces
touched — a string repeated across more files is more expensive to fix even at equal
occurrence count, since it can't be handled by one file's diff):

| # | String | Occurrences | Files | Surfaces | Why it's expensive |
|---|---|---|---|---|---|
| 1 | `Publish` | 17 | 3 | Coach, Staff | Action button name reused for the review/publish workflow on `coach/video-publications`, `notices`, and `rabbit-holes` — renaming the verb breaks all three independently-owned pages at once. |
| 2 | `Athlete` | 16 | 6 | Admin, Coach | A form-field label (`getByLabelText('Athlete')`) repeated on every admin/coach form that assigns work to an athlete — coach-coverage, consent, memberships, people, attempt-log, and CoachWorkspace's own review form. |
| 3 | `Sample Athlete One` | 16 | 4 | Admin | Test-fixture display name, not chrome copy — flagged so it isn't mistaken for a redesign target, but any change to how the fixture factory names athletes would still break 4 files at once. |
| 4 | `Approve` / `Reject` | 18 combined | 6 | Admin, Coach | The review-action button pair shared by `portrait-review`, `video-compliance`, and `CoachWorkspace`'s intervention/session review flows. |
| 5 | `Database unavailable` | 8 | 8 | Admin, Parent/Guardian | The widest file-spread of any real copy string in the corpus — the generic fetch-failure message reused verbatim across 6 admin pages and 2 parent pages. |
| 6 | `From the Gym` / `Gym Notices` | 11 combined | 3 | Athlete, Coach, Parent | `AnnouncementBanner`'s heading and section label, asserted directly from 3 different workspace shells (`AthleteWorkspace`, `CoachWorkspace`, `ParentHub`) in addition to its own component test. |
| 7 | `Acknowledge` | 9 | 2 | Admin, Coach | Shared escalation/compliance action button (`compliance-center`, `CoachWorkspace`). |
| 8 | `Submit for review` | 10 | 2 | Admin, Coach | Paired with `Publish` on the same video-compliance/video-publications review workflow. |
| 9 | `Pause session` / `End session...` / `Record as completed` | 20 combined | 2 | Coach | All three live inside `SessionScriptLiveDelivery`, asserted both in its own test file and through `coach/session-scripts/page.test.tsx` — one component rename, two test files break. |
| 10 | `Rear foot stays flat through the cross.` | 8 | 3 | Athlete, Coach, Parent | A single coaching-cue fixture string surfaced identically on the athlete workspace, the coach review screen, and the parent progression-visibility page — same content, three different renders to keep in sync. |

Honorable mention, not in the top 10 by raw count but worth flagging separately: the
**`GROUP_FOR_SURFACE` tab-group labels** in `athleteWorkspace.test.tsx`
(`Today`, `Development`, `Learn`, `Schedule`, `Messages`, `SHADOW`) — because of the
two-level `openTab` pattern, each one gates several *other* pinned strings' reachability
rather than being pinned once itself, so its real blast radius doesn't show up as a
simple occurrence count.
