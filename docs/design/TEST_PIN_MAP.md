# Test Pin Map — User-Visible Strings vs. Test Assertions

## Purpose

A UI redesign is about to rename user-visible labels across role surfaces (athlete,
parent/family, coach, admin, board, staff, shared). Renaming a label in a component
without updating the tests that pin the old wording does not fail loudly in every
case — some assertions regex-match a substring that still happens to be present,
some go through `queryByText` and silently start returning `null` where the test
expected `null` already (a false negative that reads as a pass), and some pin an
*assembled* string that only partially changes. This document is the cross-reference
that makes that failure mode visible ahead of time: **for every string a test pins,
which component renders it, and which role surface owns that component.**

The working rule this map exists to support: **a rename in a component with pinned
strings must migrate its test pins in the same PR.** Treat this document as the
checklist for that PR, not as a spec of the new copy.

## How this was generated

1. Every `*.test.ts` / `*.test.tsx` file in the repo was located (535 files total,
   `apps/web` plus `apps/research-bridge` and `packages/governance`).
2. Files whose name matches `*.pg.test.ts` were set aside — these only run under
   `npm run test:migrations:*`, not the ordinary `jest` gate. There are **83** of
   them, all under `apps/web/src/server/pilot/` or `apps/web/scripts/`, and all are
   database/migration-shape tests with no `@testing-library/react` import and no
   rendered UI — confirmed by grepping all 83 for the assertion APis below, which
   returned zero hits. They are listed separately and require no test-pin migration
   for a copy-only rename.
3. Of the remaining ~452 files, **106** import `@testing-library/react` — these are
   the UI tests actually capable of pinning rendered text. The rest are pure
   server/business-logic tests (route handlers, SQL, formulas) that do not render
   anything and so cannot pin user-visible copy in the sense this map cares about.
4. Each of the 106 UI test files was grepped for: `getByText`, `findByText`,
   `queryByText`, `getAllByText`, `findAllByText`, `queryAllByText`,
   `toHaveTextContent`, `getByRole(...)` / `findByRole` / `queryByRole` /
   `getAllByRole` with a `name:` option, `getByLabelText` / `findByLabelText` /
   `queryByLabelText`, `getByPlaceholderText`, `getByTitle`, and
   `toHaveAccessibleName`. No `*.snap` snapshot files exist anywhere in the repo
   (confirmed by a repo-wide glob) and no test calls `toMatchSnapshot` /
   `toMatchInlineSnapshot` — snapshot drift is not a risk vector here, unlike in
   most React codebases.
5. Each hit's literal string (or regex/constant) was recorded against the component
   under test (from the file's own `import ... from './Page'` / `'./Component'`)
   and the role surface that component is gated to, read from `RoleSessionGate
   allowedRoles={...}` or `requirePageRole([...])` in the page/component itself.

## Known limits

- **Duplicate occurrences are collapsed.** Where the same literal string is pinned
  more than once in the same test file (e.g. a happy-path test and an error-path
  test both check for `'Not submitted yet'`), the row below lists the string once
  with every matching line number, not one row per assertion. The count of *distinct
  strings* in the Summary table reflects this collapse; the count of *assertions* is
  higher.
- **Regex and constant matchers are recorded as written**, not resolved to a literal.
  Where a test does `getByText(/rounds must be a positive number/)` the table shows
  that regex; where it does `getByText(DISCLOSURE)` the table shows `DISCLOSURE` and
  points at where that constant lives. Both cases are called out again in
  **Fragile Patterns** because a find-and-replace over literal strings will not
  touch either.
- **Role attribution is by route gate or component owner, not by rendering context.**
  A handful of components (`AnnouncementBanner`, `RabbitHole`, `GymWallModule`,
  `WallOfNames`, etc.) are gated to no single role — they render inside the athlete
  workspace, the parent hub, *and* stand-alone kiosk pages. These are grouped under
  **Shared/Common** with an explicit note on every surface that embeds them, because
  the athlete/parent redesign will touch their rendered copy even though their own
  test file is not itself an "athlete" or "parent" file.
- **This map does not run the test suite.** It is a static read of assertion call
  sites. A string that is computed at runtime and only coincidentally matches a
  literal today (or a test that is currently skipped) will still show up here if the
  source line matches the grep; treat every row as "needs a human look during the
  rename," not as a guaranteed live assertion.
- **Business-logic tests that encode copy fragments without using the listed
  RTL APIs are not in the main tables.** `milestoneCeremony.test.ts` and
  `achievementCeremony.test.ts` pin fragments of the ceremony/boxing-number copy
  (e.g. `'amateur bout'`, `'championship'`) via plain `.toContain()` on a returned
  string, not via `screen.getByText`. They are real blast radius for the athlete
  surface and are called out in that section and in Fragile Patterns, but were not
  exhaustively inventoried the way the `screen.*` call sites were.

## Summary

| Role surface | Test files | Distinct pinned strings | Risk |
|---|---|---|---|
| **Athlete workspace** | 9 | ~150 | **High** — first redesign target, largest single-surface volume of literal copy pins (dashboard mount guard, workspace check-in/goals/pain flow, achievements, training-card ceremony, sparring telemetry, progression intelligence) |
| **Parent / family workspace** | 8 | ~90 | **High** — second redesign target; consent, safety, progression-visibility and the guardian hub/digest all pin exact copy, several assembled from athlete names at render time |
| **Shared / common** (kiosk wall, login, notices, chalkboard, feedback, nav header, rabbit hole viewer, print room) | ~20 | ~130 | **High** — not a redesign target on its own, but these components render *inside* the athlete dashboard and parent hub (`AnnouncementBanner`, `RabbitHole`, `GymWallModule`, `WallOfNames`, `GlobalRoleHeader`, `CommandsOverlay`), so the athlete/parent redesign will touch their copy without their tests living in an "athlete" or "parent" folder |
| **Coach workspace** | 20 | ~260 | **Medium** — not slated first, but by far the largest surface; if it is touched later this is the most expensive migration in the codebase |
| **Admin console** | 28 | ~230 | **Medium** — not slated first; high volume, much of it operational/compliance copy less likely to be touched by a purely cosmetic rename |
| **Board** | 7 | ~75 | **Low** — small surface, small population, not slated for redesign |
| **Staff / operations** (director, ops hub, workspace, research, scheduler) | 7 | ~55 | **Low** — hub/index pages mostly pin section headings, not deep copy |
| **Migration-only (`*.pg.test.ts`)** | 83 | 0 UI strings | N/A — no rendered UI, see dedicated section below |

Approximate totals: **106 UI test files** scanned in full detail, **83** migration-only
suites confirmed to carry no UI text pins, **~990 distinct pinned strings** across the
UI surfaces above (before collapsing near-duplicates across similar list/detail
patterns, the true assertion count is several times higher).

---

## Athlete Workspace

### AthleteDashboardPage — `apps/web/app/athlete/dashboard/page.test.tsx`

This file exists purely to guard against the workspace being swapped for a stub
(commit `d7899044` regression); it does not pin copy, only a `data-testid` mount
marker. No rows.

### AthleteWorkspace — `apps/web/components/athleteWorkspace.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Unavailable - not yet tracked` | athleteWorkspace.test.tsx:186 | getByText |
| `/Youth Class 4:00 PM/`, `/Mon-Thu 4:00 PM Youth Class/` (absence checks) | athleteWorkspace.test.tsx:185,194 | queryByText |
| `Open Unified Scheduler` | athleteWorkspace.test.tsx:195 | getByRole link name |
| `Book` (absence check) | athleteWorkspace.test.tsx:193 | queryByRole button name |
| `Start Assessment` | athleteWorkspace.test.tsx:202 | getByRole button name |
| `+ New SMART Goal` | athleteWorkspace.test.tsx:209,236,650,678 | getByRole button name |
| `Goal title` (placeholder) | athleteWorkspace.test.tsx:211,238,652 | getByPlaceholderText |
| `Success metric` (placeholder) | athleteWorkspace.test.tsx:212,239,653 | getByPlaceholderText |
| `Goal target date` (label) | athleteWorkspace.test.tsx:217,244,656 | getByLabelText |
| `Create Goal` | athleteWorkspace.test.tsx:220,247,659 | getByRole button name |
| `/That goal did not save/` | athleteWorkspace.test.tsx:251 | findByText regex |
| `/saved locally/i` (absence check) | athleteWorkspace.test.tsx:252,285 | queryByText regex |
| `Body location` (label) | athleteWorkspace.test.tsx:264 | getByLabelText |
| `Report Pain` | athleteWorkspace.test.tsx:265 | getByRole button name |
| `Save` | athleteWorkspace.test.tsx:266 | getByRole button name |
| `/flagged for a coach to look at/` | athleteWorkspace.test.tsx:273 | findByText regex |
| `/was not saved and no coach was told/` | athleteWorkspace.test.tsx:284 | findByText regex |
| `Check In` | athleteWorkspace.test.tsx:291,319,320,405,488 | getByRole/findByRole/queryByRole button name |
| `Check Out` | athleteWorkspace.test.tsx:299,319,334,335,345,366,392,395,404,416,417 | getByRole/findByRole/queryByRole button name |
| `/not signed in as an athlete/i` | athleteWorkspace.test.tsx:318 | findByText regex |
| `Session notes for your coach` (placeholder, regex) | athleteWorkspace.test.tsx:337,367,396 | getByPlaceholderText |
| `/What you wrote stays put/` | athleteWorkspace.test.tsx:384 | findByText regex |
| `/still checked in/i` | athleteWorkspace.test.tsx:394 | findByText regex |
| `/You are not checked in right now/` | athleteWorkspace.test.tsx:403,417 | findByText/queryByText regex |
| `/Your sessions could not be read/` | athleteWorkspace.test.tsx:415 | findByText regex |
| `Try Again` | athleteWorkspace.test.tsx:418 | getByRole button name |
| `Hands up, chin down.` | athleteWorkspace.test.tsx:451 | findByText |
| `From the Gym`, `Gym Notices`, `Coaches only.` (absence checks) | athleteWorkspace.test.tsx:454,464,471,472 | queryByText |
| `Nothing on the board.` | athleteWorkspace.test.tsx:476,486 | getByText |
| `Current Readiness` | athleteWorkspace.test.tsx:487 | getByText |
| `Biomechanics of Kinetic Force Transfer` | athleteWorkspace.test.tsx:531,543,554,564 | findByText/getByText/queryByText |
| `/Power does not generate in the shoulders/`, `/30 slow shadowboxing crosses/`, `/Written by Coach Jason/` | athleteWorkspace.test.tsx:532,533,534 | getByText regex |
| `Progression gap type: Technique` / `Progression gap type: Strength` (absence) | athleteWorkspace.test.tsx:537,556 | getByText/queryByText |
| `Gap severity: Critical` (absence) | athleteWorkspace.test.tsx:557 | queryByText |
| `/is not research and it is not SHADOW evidence/`, evidence-tier labels (absence loop) | athleteWorkspace.test.tsx:545,547 | getByText/queryByText |
| `/have not published a rabbit hole yet/` | athleteWorkspace.test.tsx:563,572 | findByText/queryByText regex |
| `/could not be loaded right now/` | athleteWorkspace.test.tsx:571 | findByText regex |
| `No category` (absence: `Boxing`) | athleteWorkspace.test.tsx:611,612 | findByText/queryByText |
| `Academics` | athleteWorkspace.test.tsx:642,657 | findByText / goal-category select value |
| `Goal category` (label) | athleteWorkspace.test.tsx:657,681 | getByLabelText |
| `/plan you build with your coach/` | athleteWorkspace.test.tsx:684 | getByText regex |
| `Report progress for Land 100 clean jabs` (assembled label — goal title interpolated) | athleteWorkspace.test.tsx:693,718,733 | findByLabelText |

### AthleteAchievements — `apps/web/components/athleteAchievements.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/nothing here ever comes off/i` | athleteAchievements.test.tsx:85 | getByText regex |
| Track names (`Competition`, others via loop variable `track`) | athleteAchievements.test.tsx:95,101,121 | getByRole `region` name (loop) / queryByRole absence |

### PersonalGoalBoard — `apps/web/components/personalGoalBoard.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/what do you want to be able to do/i` (label) | personalGoalBoard.test.tsx:89,117,267 | getByLabelText / queryByLabelText (absence) |
| `combobox` role (absence) | personalGoalBoard.test.tsx:95 | queryByRole |
| `/success metric/i` (label, absence) | personalGoalBoard.test.tsx:96 | queryByLabelText |
| `/put it on the board/i` | personalGoalBoard.test.tsx:99,125,137 | getByRole button name |
| `/why it matters/i` (label) | personalGoalBoard.test.tsx:120 | getByLabelText |
| status region containing `your own words` | personalGoalBoard.test.tsx:141 | getByRole('status').textContent — assembled |
| `/i did it/i` | personalGoalBoard.test.tsx:172,209,216,240,245,268 | getByRole/queryByRole button name (present + absence) |

### TrainingCard — `apps/web/components/trainingCard.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/no sessions on the card yet/i`, `/never resets/i` | trainingCard.test.tsx:31,32 | getByText regex |
| `2`, `/sessions logged/i`, `session logged` (singular/plural) | trainingCard.test.tsx:46,47,53 | getByText |
| `listitem` role count | trainingCard.test.tsx:48,66,166 | getAllByRole |
| `/since Feb 3 2026/` | trainingCard.test.tsx:80 | getByText regex |
| `Session Jul 4 2026, effort 8 of 10` (assembled from date+effort) | trainingCard.test.tsx:88 | getByText |
| `title` attribute on listitem (not asserted via getByTitle but read directly) | trainingCard.test.tsx:98 | getAttribute('title') |
| `Session Jul 4 2026, booked, not completed` (assembled) | trainingCard.test.tsx:100 | getByText |
| `${m} session milestone` (assembled, per-milestone loop) | trainingCard.test.tsx:145 | getByLabelText(RegExp) |
| `5 session milestone, earned`, `13 session milestone, not yet earned` (assembled aria-labels) | trainingCard.test.tsx:153,154 | getByLabelText |
| `/4 more to 5/` (assembled) | trainingCard.test.tsx:159 | getByText regex |
| `70`, `/60 earlier sessions are still counted/i` | trainingCard.test.tsx:167,168 | getByText |
| `/Session unknown, effort/` (assembled fallback) | trainingCard.test.tsx:183 | getByText regex |

### TrainingCard ceremony wiring — `apps/web/components/trainingCardCeremony.test.tsx`

Not caught by the standard RTL-matcher grep — this file reads rendered aria-labels
and text content via `querySelector` + `.getAttribute('aria-label')` /
`.textContent`, not `screen.getByText`. Flagged fully in **Fragile Patterns**; the
strings themselves duplicate the assembled milestone aria-labels above
(`'13 session milestone, earned'`, `.tcard-earned` node containing `'13 sessions'`).

### Cross-references into other surfaces

- **CoachMilestoneMarker** and **CoachRecognitionPad** (`apps/web/components/coachMilestoneMarker.test.tsx`,
  `coachRecognitionPad.test.tsx`) are coach-gated components (see Coach Workspace
  section) but render athlete milestone/achievement vocabulary directly onto a
  coach's screen — a milestone/achievement copy rename must check these two files
  even though they are not "athlete" test files.
- `milestoneCeremony.test.ts` and `achievementCeremony.test.ts` (business-logic
  tests, no RTL) assert on ceremony-record shape, not copy — except
  `boxingNumberNote`'s two remarks, pinned via `.toContain('amateur bout')` and
  `.toContain('championship')` (case-insensitive) at
  `apps/web/components/wordsOnTheWall.test.tsx` is a separate file that also renders
  `BoxingNumberNote`; the *source* of the "amateur bout" / "championship" copy
  fragments is `achievementCeremony.test.ts` lines 196–204.

### AthleteProgressionIntelligencePage — `apps/web/app/athlete/progression-intelligence/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/Loading your progression data/` | progression-intelligence (athlete) page.test.tsx:49,59 | findByText/queryByText regex |
| `No progression gaps assigned` | same file:50,58 | queryByText/findByText |
| `/GO DEEPER \(1 LESSON\)/` (assembled count) | same file:132 | findByRole button name regex |
| `Biomechanics of Kinetic Force Transfer` | same file:135 | getByText |
| `/Power does not generate in the shoulders/`, `/Thirty slow crosses/`, `/Gym coaching/`, `/Written by Coach Jason/` | same file:136-139 | getByText regex |
| evidence-tier labels (absence loop) | same file:143 | queryByText |
| `/GO DEEPER/` (absence) | same file:155,181 | queryByText regex |
| `Rear foot stays flat through the cross.` | same file:158,180 | getByText |

### SparringTelemetryPage — `apps/web/app/athlete/dashboard/sparring/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Log Combat Session` | sparring page.test.tsx:45,89,122 | findByRole button name |
| `/Nothing was saved/`, `/partially saved/`, `/Telemetry saved and sent to the SHADOW formula engine/` | same file:59,69,76 | findByText/queryByText regex |
| `Not submitted yet` | same file:63,70,77 | getByText/queryByText |
| `Contact Level` (label) | same file:92 | getByLabelText |
| `Body Weight (kg, optional)`, `Recovery Notes` (labels) | same file:125,126 | getByLabelText |

---

## Parent / Family Workspace

### GuardianMediaConsentPage — `apps/web/app/parent/consent/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Consent needed` | consent page.test.tsx:61,96 | findByText |
| `Grant Consent` | same file:62,71(absence),98 | getByRole button name / queryByRole absence |
| `Consent on file` | same file:70,109,130 | findByText |
| `Withdraw Consent` | same file:71,111,132,164 | getByRole button name |
| `/This child has 2 guardians/` (assembled count) | same file:81 | findByText regex |
| `Consent granted.` | same file:100 | getByText (in waitFor) |
| `Consent withdrawn.` | same file:134 | getByText (in waitFor) |
| `No linked children found` | same file:142 | findByText |
| `Database unavailable` | same file:150 | findByText |
| `Mia Cortez` | same file:161 | findByText |
| `ath-1` (absence, then present) | same file:162,177 | queryByText/findByText |

### ParentProgressionVisibilityPage — `apps/web/app/parent/progression-visibility/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/Loading progression data/` | progression-visibility page.test.tsx:90,115 | findByText/queryByText regex |
| `No progression gaps on record`, `No linked athletes` | same file:91,92,102,103,114 | queryByText/findByText |
| `Rear foot stays flat through the cross.` | same file:123,142 | findByText |
| `Jordan Doe's Progression` (assembled from athlete name) | same file:124 | getByText |
| `Rear-Foot Pivot Drill`, `40%`, `20 reps`, `verified` | same file:125-128 | getByText |
| `/log/i` (absence) | same file:131 | queryByRole button name |
| `Riley Doe` | same file:144 | getByRole button name (child switch) |

### GuardianSafetyPage — `apps/web/app/parent/safety/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Training is paused right now` | safety page.test.tsx:67,77(absence) | findByText/queryByText |
| `You need a doctor note before training resumes.` | same file:68 | getByText |
| `/Bring a signed clearance note\./` | same file:69 | getByText regex |
| `No training pause on file right now.` | same file:77 | findByText |
| `Contact Requires Medical Clearance` | same file:86 | findByText |
| `Clear`, `passed` (absence) | same file:87,88 | getByText/queryByText |
| `Jordan T.`, `Sam R.` (assembled athlete names) | same file:96,97 | findByText/getByText |
| `No linked children found` | same file:105,114 | findByText |
| `Photo & Video Consent` (link, href assertion) | same file:106 | getByRole link name + toHaveAttribute |
| `Database unavailable` | same file:122 | findByText |

### GuardianPortalPage — `apps/web/app/guardian/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Open your Family Dashboard` | guardian/page.test.tsx:35 | getByRole link name |
| `/The place you actually see your child/` | same file:39 | getByText regex |
| `link` role count via `getAllByRole` | same file:46 | getAllByRole |
| `What the Family Dashboard Covers` | same file:54 | getByText |
| `What You Can See Here` (absence — old copy) | same file:55 | queryByText |

### GuardianDashboardPage — `apps/web/app/guardian/dashboard/page.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `/nothing you enter here\s+would be saved/i` | guardian/dashboard/page.test.tsx:31 | getByText regex |

### ParentDigest — `apps/web/components/parentDigest.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Worked the whole round without dropping her hands.` | parentDigest.test.tsx:74 | findByText |
| `/Coach Neale/`, `/13 sessions on the card/i` | same file:75,76 | getByText regex |
| `sessions 13` | same file:77 | getByText |
| `/Alex.s corner/` (apostrophe-tolerant regex) | same file:78 | getByText regex |
| `/Nothing written up yet/` | same file:93 | findByText regex |
| `/No milestones sealed yet/` | same file:94 | getByText regex |
| `alert` role | same file:104 | findByRole |
| `/could not be read/` | same file:105 | getByText regex |

### ParentHub (child switch) — `apps/web/components/parentHubChildSwitch.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `First Child` / `Second Child` (fixture names, some with `{ selector: 'p' }`) | parentHubChildSwitch.test.tsx:91,97,98,107,110,113,114,175,237,373 | getByRole button name / queryByText with selector |
| `/Loading your children/i` | same file:97 | queryByText regex |
| `Gym closed Monday for the holiday.` | same file:153 | queryByText |
| `Gym Notices`, `From the Gym` (absence) | same file:162,163,174 | queryByText |
| `View Safety Status` (link + href) | same file:189,236 | getByRole link name + toHaveAttribute |
| `Manage Consent` (link + href) | same file:190 | getByRole link name + toHaveAttribute |
| `/Check your child.s active training-hold and safety-gate status/` | same file:199 | getByText regex |
| `/active training hold/` (absence) | same file:200 | queryByText |
| `/1 active training hold\(s\) and 1 gate\(s\) awaiting clearance/` (assembled count) | same file:222 | getByText regex |
| `/This is not a punishment/` | same file:223 | getByText regex |
| `Taking a short break.` (absence) | same file:225 | queryByText |
| `Parent Floor` | same file:250 | getByRole button name |
| `What's going on` (label) | same file:258,277,295,315 | getByLabelText |
| `Send to Coach` | same file:259,279,297,306,316 | getByRole button name |
| `Sent to your child's coach.` | same file:270,319(absence) | findByText/queryByText |
| `Type` (label) | same file:277 | getByLabelText |
| `Forbidden` | same file:318 | findByText |
| `Messages` | same file:332 | getByRole button name |
| `No messages yet.` | same file:340,372 | getByText |
| `Great effort at practice this week!` | same file:361 | findByText |
| `First Child` (with `{ selector: 'h4' }`) | same file:362 | getByText |
| `From Coach` | same file:363 | getByText |
| `Send Message (unavailable)` (disabled state) | same file:380 | getByRole button name + toBeDisabled |
| `label` variable via `getAllByText(label).find(...)` (selector-filtered) | same file:391 | getAllByText |

### PaymentSetupBubble — `apps/web/components/paymentSetupBubble.test.tsx`

| Pinned string | Test file:line | Assertion type |
|---|---|---|
| `Finish connecting payments` | paymentSetupBubble.test.tsx:45 | findByText |
| `Connect the Program account.` | same file:46 | getByText |

Note: `PaymentSetupBubble` is not currently imported by any `page.tsx` in the repo
(grep across `apps/web/app` for `PaymentSetupBubble` returns only the component and
its own test) — it is dead code today. Kept here because renaming its copy is
zero-risk to ship, but the component should be confirmed live/dead before deciding
whether it belongs in the parent/family redesign scope at all.

---

## Coach Workspace

Fifteen page suites plus five component suites. Given the volume, pinned strings
are grouped by component with representative rows; every row below is a distinct
literal/regex actually asserted (duplicates within a file collapsed to one row).

### AttemptLogPage — `apps/web/app/coach/attempt-log/page.test.tsx`
`Athlete` (label) L59,76,100 · `missed` L62 · `/92s \/ target 90s/` L63 · `gassed at 300m` L64 · `/the misses are the point/i` L65 · `/Achieved/` (label) L79 · `Record attempt` L82,103 · `/Achieved must be a non-negative number/` L107

### CueLibraryPage — `apps/web/app/coach/cue-library/page.test.tsx`
`ground-force` L55 · `/Push the floor away/` L56 · `/from/` (assembled: `.textContent).toContain('Heavy Bag Drive')`) L57 · `/External focus beats internal/` L58 · `/add|edit|delete|save/i` (absence) L60 · `Focus type`, `Search` (labels) L71,74 · `/nobody has written any yet/` L89 · `/Cues may exist that are not shown here/` L99

### DecisionLoopReviewPage — `apps/web/app/coach/decision-loop/page.test.tsx`
`Behavior & Habit Note` L56 · `Note` (label) L70,93,113 · `Log Note` L71,95,104,114 · `Note logged.` L86,117(absence) · `Forbidden` L116,175,260 · `Message` (label) L129,152,172 · `Send to Family` L130,154,163,173 · `Sent to the family.` L145,176(absence) · `What happened` (label) L188,213,237,257,277,298 · `File Incident Report` L189,216,239,248,258,278,299 · `Incident filed -- it is now in the escalation queue.` L205,261(absence),300,304(absence) · `Report Incident` (section heading, used via `.closest('section')`) L212 · `Severity` (label, scoped `within`) L214 · `When it happened (optional, if not today)` (label) L215 · `athlete-id` (placeholder) L302

### CoachProgressionIntelligencePage — `apps/web/app/coach/progression-intelligence/page.test.tsx`
`/Enter athlete ID/` (placeholder) L83 · `/GO DEEPER \(1 LESSON\)/` L103 · `Why the elbow finishes down` L106 · `/Rotation ends before impact/`, `/Gym coaching/`, `/Written by Coach Danielle/` L107-109 · `/Homework:/` (absence) L113 · evidence-tier absence loop L116 · `/GO DEEPER/` (absence) L124 · `Rear foot stays flat through the cross.` L125 · `Write a Rabbit Hole` (link) L131 · `Active Training Hold` L143,152(absence),160,180(absence) · `/CONTACT WORK is currently paused/` L144 · `Waiting on a doctor note before contact resumes.` L145 · `Suggested Gaps` L224,240(absence),251,256(absence),269(absence) · `Readiness falling` L225 · `/fell from an average of 7.0 to 5.5/` (assembled numbers) L226 · `Confirm as gap`, `Dismiss` L229,253 · `/Progression Gaps → Drills → Verification/` L268

### InterventionProtocolsPage — `apps/web/app/coach/intervention-protocols/page.test.tsx`
`Round-3 endurance block` L68 · `/aerobic capacity limits round-3 output/` L69 · `/v2 · Jordan P\./` L70 · `/output collapses identically at low RPE/` L71 · `/rounds: 6 · sessions: 2/` (assembled) L72 · `Title`, `/Target problem/`, `/Hypothesis/`, `/Intervention —/`, `/Expected outcome/`, `/What would contradict/`, `Rounds`, `Sessions` (labels) L83-90 · `File protocol` L93,120 · `/rounds must be a positive number/` L124

### CoachIntelligencePage — `apps/web/app/coach/intelligence/page.test.tsx`
`Holds expiring within 14 days`, `3+ RED readiness days this week`, `Attendance fading`, `Gaps waiting 14+ days for a drill`, `Sessions unreviewed for 7+ days` L47-51 · `Clearance board`, `Assign a drill` (links + href) L53,54 · `/no scores, no predictions/i` L56 · `Nothing needs your eyes` L68,80(absence) · `/not a guarantee the floor is fine/` L69 · `/Items may exist that are not shown here/` L79

### CoachVideoPublicationsPage — `apps/web/app/coach/video-publications/page.test.tsx`
`Waiting on an organization admin to record a compliance check.` L68,129 · `Publish`, `Submit for review` (present/absent across states) L69,70,81,82,93,127,130,134,160,174,182,194,209,242,245,259-261 · `A draft. Submit it for compliance review when it is ready.` L80 · `/Another coach created this draft/` L92 · `Only a draft can be submitted for review.` L162 · `Failed to submit for review` (absence) L163 · `/A compliance check failed/` L173 · `Compliance checks passed. Ready for you to publish.` L183 · `/Another coach submitted this one/` L193 · `This publication is not cleared for the research library yet.` L211 · `Failed to publish` (absence) L212 · `Published to the research library.` L244 · `/Retracted from distribution/` L259

### CoachSessionScriptsPage — `apps/web/app/coach/session-scripts/page.test.tsx`
`Friday sparring`, `Tuesday technical` L163,164 · `/No session scripts yet/i` L174 · `/could not be loaded/i`, `/not an empty set of scripts/i` L182,183 · `/open plan/i` (button, repeated) many lines · `10-25 min`, `0-10 min` L194,195,457 · time-format absence regex `/\d:\d\d\s*(am|pm)/i` L198 · `/Eyes on the chest/` L227,251 · `Fix:` (absence) L229 · `/Hands down, feet still/` L238 · `/This script has no blocks yet/i` L259 · `alert` role L276,281(absence) · `Delivering now` L290,323,365,386(absence) · `/already in progress was restored/` L291 · `/could not be checked/` L304 · `/start live delivery/i` (disabled, then clicked) L306,320,321,341(absence) · `/cannot be delivered live until it has blocks/i` L340 · `/restored, not restarted/` L366 · `End session...` L379 · `Record as completed` L380 · `/recorded as completed/i`, `/can no longer be changed/` L382,383 · `Pause session` (absence) L387 · `Completed`, `Abandoned`, `Recorded before live delivery tracking`, `2026-08-12` L420-423 · `/6 blocks completed\. 9 athletes present\. Reset protocol used\./` (assembled) L424 · `Slip line clicked.`, `Storm cleared the room.` L425,426 · `/Did not:/`, `/0 athletes present/` (absence) L428,429 · `/No deliveries recorded for this plan yet/` L441 · `/Deliveries may exist that are not shown/` L442,454(present)

### CoachCohortsPage — `apps/web/app/coach/cohorts/page.test.tsx`
`Open Floor`, `Pressure Group`, `Exploring` L99-101 · `/No cohorts defined yet/i` L109 · `/could not be loaded/i`, `/not an empty set of rooms/i` L117,118 · `/Regulatory age bound/` L128,138(absence) · `Can hold the stance for one round.` L146 · `/athlete id/i` (label) L160,238,262 · `/look up/i` L162,225,239,263 · `Fits`, `Not yet` L171,172 · `No assessed level in composure.` L180,226,232(absence) · `/needs a coach to sign off/i` L189 · `/No logged training yet/i` L200 · `alert` role with `/No athlete with that id/i` content L211 · `/No assessed competence levels yet/i` L231

### SportsMedicinePage — `apps/web/app/coach/sports-medicine/page.test.tsx`
`/Loading clearance board/` L74,127(absence) · `No athletes on your roster` (absence) L75 · `Jordan Doe` L83 · `cleared` L84,113(absence) · `/since/` L85 · `/no_sparring/`, `/physician-note-123/` (absence — PII/internal code leak checks) L89,90 · `no record` L100 · `/medical gate blocks recommendations/` L101 · `unavailable` L111 · `/Unknown is not cleared/` L112 · `/Active Training Hold — sparring/` L123 · `HOLD.athlete_explanation` (fixture-value assertion, assembled) L124 · `/A symptom-free week and a coach check-in/` L125

### InterventionReviewPage — `apps/web/app/coach/intervention-review/page.test.tsx`
`Decision` L71 · `run the endurance block twice weekly` L72 · `/rounds: 6/`, `/rounds: 3 — adherence under delivered/` L73,74 · `counterevidence` L75 · `/round-3 output fell again/` L76 · `Not yet reviewed by a human.` L77 · `Review outcome`, `Record review` L88,99 · `What happened`, `The belief we tested`, `What it revealed`, `What happened, in your words (required)` (labels) L91-94 · `Link evidence`, `Evidence role`, `Source kind`, `Source record id`, `Link it` L125,128-130,133

### CoachVideoAnalysisPage — `apps/web/app/coach/video-analysis/page.test.tsx`
`Release`, `Not released`, `Play` (state-dependent button names) L111,112,135,143,144,165,167,168,183 · `Held for review by the coach who uploaded it.` L123 · `Sparring round 3` L152,207 · `This video has already been released.` L185 · `Request Film Study` L199,208(absence),232,266,272 · `Film Study: Film Study queued.`, `Film Study: Video analysis job completed.` L238,246 · `Film Study: Film Study is not enabled in this environment. No analysis job was created.` L268 · `Athlete kept guard low in round 2.` L294,300(absence),317(absence),333(absence),358 · `No Film Study observations awaiting review.` L302 · `Accept`, `Reject` L315,331 · `This proposal was already accepted by another reviewer. A recorded verdict cannot be replaced.` L355

### PerformanceAnalyticsPage — `apps/web/app/coach/performance-analytics/page.test.tsx`
`/Loading performance rollup/`, `No athletes on your roster` L54,55,63,64 · `Jordan Doe` L72,84,98 · `3/4`, `8`, `rising`, `55%` L73-76 · `rising`, `falling`, `steady` (absence loop) L85-87 · `90 days` L100

### InterventionExecutionsPage — `apps/web/app/coach/intervention-executions/page.test.tsx`
`/Planned:/`, `/rounds: 6 · sessions: 2/`, `/^Actual:/`, `/rounds: 3$/` L77-80 · `under delivered` L81 · `/cut to 3 rounds -- athlete gassed/` L82 · `Close out`, `Record close-out` L93,103,128,134 · `Adherence`, `Deviations (required if you claimed any)`, `Rounds` (labels) L96,97,100,131 · `/rounds must be a positive number/` L138

### CoachDisciplinesPage — `apps/web/app/coach/disciplines/page.test.tsx`
`/athlete id/i` L79,254,361 · `/look up/i` L81,255 · `Boxing`, `Grappling` L95,96,129,251 · `/No disciplines defined yet/i`, `/could not be loaded/i`, `/not an empty list of disciplines/i` L104,112,113 · `/IBJJF Youth Rules 2026 s.2/` L121 · `/Age policy:/` (absence) L130 · `head contact`, `neck and joint` L138,139 · `/No grappling exposure recorded/i` L155,223 · `/Neck: positional pressure/`, `/Partner held position after the tap/`, `/Athlete reported neck discomfort/`, `/presented unsteady/i` L163,176,184,192 · `/Segment 1/`, `/presented/i` (absence) L200,201 · `First athlete note.` L219,224(absence) · `alert` role L239,244(absence) · `/grappling: technique only/i` L271

### CoachWorkspace — `apps/web/components/coachWorkspaceHonesty.test.tsx`

This is the largest single UI test file in the repo (~1050 lines). Representative
pins: `Injury Prevention Basics`, `Session Workout Plan`, `Not Started`/`In
Progress`/`Completed` progress states (absence-checked) L164-191 · error/empty
copy for athlete floor plans (`/No athlete floor plans received yet/i`,
`/Error loading athlete floor plans/i`, `Retry loading athlete floor plans` button)
L202-209 · SHADOW review-queue copy (`/Unable to load the SHADOW review queue/i`,
`/No open tasks\. Items appear here/i`) L223-233 · Coach Review flow (`Session`
label, `Save Coach Review` / `Saving…` buttons, `Coach review persisted`) L251-274 ·
Safety Escalations block (`Safety Escalations`, `Jordan P.`, `/Pain score 8
reported after sparring round/`, `/Pain report/`, `/Near miss/`, `Athlete ID
ath_unknown`, `Acknowledge` button ×2, `/Closing it out is an admin decision/`,
`Missing escalation record`) L314-398 · session-review sub-block (`Reviews already
on this session`, `Clean angles all night.`, `another coach (acct_coach_2)`, `No
reviews on this session yet.`, `Stored by the server.`) L451-514 · intake queue
pagination (`New athlete intake case_9`/`case_6`/`case_1`/`case_0`, `/Showing 20 of
34/` and `/14 more cases are in the queue/` — both **assembled from a live count**,
`/undefined/` absence guard) L850-903 · notices block shared with athlete/parent
surfaces (`Lock the room in before the first bell.`, `From the Gym`, `Gym
Notices`, `Live Session Management`) L931-953 · readiness-board copy (`/1 RED, 0
YELLOW, 1 unknown — unknown is not clear/` — **assembled from three counts**, `No
signal`, `/do not read this as .zero flags./`) L984-1001 · barrier-report block
(`Rosa Delgado`, `/Getting to the gym/`, `/reported by a guardian/`, `We lost our
ride on Tuesdays.`, `/Do not read this as .no family asked for/`,
`/No guardian on your roster has reported a barrier/`) L1027-1045.

### CoachMilestoneMarker — `apps/web/components/coachMilestoneMarker.test.tsx`
`Session notes for today` L103 · `HELP:` (button, regex) L237,257,270 · `Advanced research into biomechanics, neurology, and boxing theory.` L239 · `Reading but not doing homework` L240,275

### CoachRecognitionPad — `apps/web/components/coachRecognitionPad.test.tsx`
`Marcus Ruiz` L132,197 · `/The Engine/` L133 · `Youth Mentorship Programme` L134 · `Jason Neale` L135 · `Blue corner` L142 · `img` role name `Marcus Ruiz` (assembled initials `MR` via `.textContent`) L149 · `No coach of record yet`, `Start date not recorded` L175,176 · `""` (absence — empty-string leak guard) L178 · `Helped a newer kid settle in`, `/Helped somebody new find their feet/` L195,196 · `/Marked by a coach who watched it happen/` L198 · `Certificate` L249 · `Wraps their own hands properly` L250 · `No certificate to print`, `/Nothing is missing and nothing is late/` L257,258,295 · `Came in for the first time` L265 · `alert` role content matching `/ask a coach/i` L274

### SessionScriptLiveDelivery — `apps/web/components/sessionScriptLiveDelivery.test.tsx`
`Friday sparring` L144 · `Elapsed delivery time` (label, assembled `mm:ss` values via `toHaveTextContent`) L146,187,191,205,209,224,455 · `RUNNING`, `PAUSED` L147,204,240,259,273 · `/Pinned at version 3/` L148 · `Current block` L151 · `Add slip and visual response` L152 · `/Eyes on the chest/` L153 · `Fix:` (absence) L155 · `/The plan below is version 3; this session pinned version 2/` L166 · `/The plan for this session could not be loaded/` L172 · `Pause session`, `End session...`, `Next block` (disabled), `Resume session`, `Previous block`, `Go to this block`, `Record as completed`, `Record as abandoned`, `Keep delivering` — full button vocabulary L174-403 · `alert` content: `not part of this session's script`, `SESSION_RUN_BLOCK_NOT_IN_SCRIPT` L326,327 · `Blocks completed`, `Athletes present`, `Reset protocol was used`, `Deviation from the plan`, `What worked`, `What did not` (labels) L355-360 · `alert` content `whole number` L418 · `alert` content `out of date` L456

### FloorOperationsDesk — `apps/web/src/components/coach/floorOperationsDeskHonesty.test.tsx`
`/Reading the operational record/` L45 · `/nothing has been recorded/i` L46,54 · `/not that the floor is clear/i` L55 · `alert` role L63 · `/blind right now, not that the floor is clear/i` L64 · `observation_recorded`, `projection_read`, `event`, `telemetry` L72-75

### RabbitHolesPage (coach authoring) — `apps/web/app/rabbit-holes/page.test.tsx`
Gated `RoleSessionGate allowedRoles={['coach','admin']}`. `Term`, `Kind of term` (labels/selects) L121,126,134,137,174,175 · `Already Written For Progression gap type: Technique` (assembled heading) L147,156 · `Biomechanics of Kinetic Force Transfer`, `/by Coach Jason, for Athletes/` L149,150 · `Nothing is published against this term yet.` L158,311(absence) · `Title of the lesson`, `/Concept - why this works/`, `/Homework \(optional\)/`, `Who reads it`, `Your name, as readers will see it` (placeholders/labels) L176-186,239-241 · `Publish` (disabled progressively enabled) L191,210,213,216,221,246 · `Everything This Gym Has Written` (heading) L261 · `article` role, `Mine`/`Theirs` filter text L263-265 · `Retire` L267,270(absence),279,296 · `/no longer renders anywhere, and nothing was deleted/` L299 · `Restore`, `Retired` (counts) L300,301 · `/Thirty slow crosses/` L303 · `/Nothing below is the full list/` L309 · `No rabbit holes have been written for this gym yet.` (absence) L310 · `/gym's own coaching, published under your name/`, `/carries no SHADOW evidence tier/` L317,318 · evidence-tier absence loop L320

---

## Admin Console

### AdminCapabilitiesPage — `apps/web/app/admin/bulkCapabilities.test.tsx` (also `apps/web/app/admin/page.test.tsx`)

The bulk-capabilities suite is the densest admin file and pins a large number of
**assembled, count-bearing** button names and status lines — flagged again in
Fragile Patterns. Representative pins: `/^Capability Library$/i` L88 ·
`/Showing 5 of 5 on file\./` (and `2 of 5`, `1 of 5`, `4 of 4` as the count
changes) L89,136,152,165,168,191,195,256,288,309,321,373 · `select all .* shown`
(assembled checkbox name) L95 · status-cell text via `{ selector: 'span' }` L114 ·
`search` placeholder L119 · `/^DELETE 1 CAPABILITY$/`, `/^DELETE 5
CAPABILITIES$/` (count-assembled) L157,224,251,262,272,279,294,297,305,317,318 ·
`/No capability matches those filters/` L181,467(admin/page.test.tsx) · `/^SET
BLOCKED$/`, `/^SET ARCHIVED$/`, `/^SET DRAFT$/`, `/^SET ACTIVE$/` L193,334,345,354,
385,396,409 · `alertdialog` role, `Delete 5 capabilities from the registry?`
(assembled) L253,254 · `/does not come back/i` L265 · `Safety Gate` (fixture name,
also absence after delete) L273,322,376 · `/^UNDO$/` L337,357,372,386,390 ·
`/^GIVE TO ADMIN$/`, `/^TAKE FROM ADMIN$/`, `/Admin, Admin/` (absence),
`Unassigned` L417,420,421,427,430 · from `admin/page.test.tsx`: `Overview`,
`Assignment Board` (tab buttons with `aria-current` assembled state) L194-200 ·
`CLEAR ALL FILTERS` L180 · `/compliance/i` (link, present/absent by capability)
L207,211

### PeopleConsolePage — `apps/web/app/admin/people/page.test.tsx`
`/Linked to no athlete/i`, `/1 guardian linked to no athlete/i` (assembled count),
`/would see nothing/i` L115-118 · `Signs in with Microsoft`, `Signs in with an
email link` (absence/presence pairs) L116,142,143,293,295 · `Alex Johnson` L138,
209,271 · `/Guardian links could not be read/i` L154 · `Add Coach, Staff Or
Guardian` L164 · `/^Email address$/i`, `Guardian's full name`, `Athlete`, `Full
name`, `Athlete record ID` (labels) L170,178,181,199,200,267,268,394,406,419,428,
448,450,461,463 · `Parent / Guardian` (radio) L173,198,236,266 · `Add To My Gym`
L175,201,225,269 · `/is now a guardian of Alex Johnson/i` (assembled) L209,271 ·
`/roster could not be read/i`, `/no athlete records in your gym yet/i` L237,244 ·
`/sign in with an emailed link/i`, `/No Entra ID guest invite is involved/i`,
`/Two steps, not one/i` (absence), `/their sign-in will be rejected/i` (absence)
L254-257 · `Confirm Remove` L337,357 · `/only athlete this guardian is linked
to/i` L359 · `/^Add Athlete$/i` L374 · `/Still needed before this can be saved/i`
L382,392,396,436 · `/Alex Johnson is already on your roster as ath-1/i`
(assembled) L453 · `/is already on your roster as/i` (absence) L465

### PortraitReviewPage — `apps/web/app/admin/portrait-review/page.test.tsx`
`Sample Athlete One`, `Sample Athlete Two` L46,47,80,97,119,145,173 · `Nothing
pending` L55,65(absence) · `Database unavailable`, `The queue could not be
loaded` L63,64 · `Approve`, `Reject` (per-row, `getAllByRole` indexed) L82,99,121,
147,155,175 · `Portrait approved.`, `Portrait rejected.` L84,123,155 ·
`Unsupported: portrait was already decided by another reviewer` L177

### VideoCompliancePage — `apps/web/app/admin/video-compliance/page.test.tsx`
`Sparring Round 1`, `Sparring Round 1 (fresher)`, `Footwork Drill`, `Orphaned
Draft`, `Live On Shelf`, `Pulled From Shelf` (fixture titles) throughout · `Session
footage.`, `Sample Athlete One`, `Coach Alice`, `ath-1`, `acct-coach` L70-92 ·
`Changes were previously requested on this video`, `/Trim the last 10 seconds\./`
L104,105,114(absence) · `Video not playable` L123 · `Nothing pending`, `Database
unavailable`, `The queue could not be loaded` L131,139,140,141 · `Approve`,
`Reject`, `Request Changes` (per-row) throughout · `Video approved for
publication.`, `Video rejected.`, `/needs a stated reason/`, `Changes requested.`
L161,182,195,231 · `Unsupported: publication was already decided by another
reviewer` L334 · `Drafts not yet submitted`, `Coach Departed`, `Submit for
review`, `Draft submitted into the review queue.`, `Only a draft can be submitted
for review.` L355-410 · `Retract from distribution`, `Publication retracted from
distribution.` L458,460 · `/Nothing here can restore a guardian/`, `Reopen for
review`, `Publication reopened into the review queue.` L498,500,502

### ComplianceCenterPage — `apps/web/app/admin/compliance-center/page.test.tsx`
`Acknowledge`, `Escalate`, `Dismiss`, `Resolve` (state-dependent visibility)
L67-79,86,94,107,118,144 · `This violation cannot be resolved from its current
state.` L148

### VideoReviewManagementPage — `apps/web/app/admin/video-review/page.test.tsx`
`Video review escalation is managed per gym`, `Platform console` (link + href)
L48,49 · `Quarantined Video Review Escalation` L88 · `Sparring Drill 1`, `ID:
vid-101` L89,90 · `Inspect / Watch Video`, `Temporary Inspection Link Active
(15m TTL)` L131,134 · `Automated Scanner Detail: Sensitive content scan flagged
for review` L136 · `Approve Video (Set Ready)`, `✓ Video "vid-101" approved —
status updated to ready.` (assembled ID + status) L178,182 · `Block Video (Keep
Quarantined)`, `✓ Video "vid-102" blocked — status remains quarantined.`
(assembled) L224,228

### ActivationCodesManagementPage — `apps/web/app/admin/activation-codes/page.test.tsx`
`Activation codes are managed per gym`, `Platform console` link L49,50 · `Issue
Athlete Activation Codes`, `Account: ath-001` (assembled ID) L78,79 · `Pending
Redemption` L80 · `Athlete Account ID` (label), `Issue Activation Code` L108,111 ·
`ABCD-1234-EFGH` (fixture code) L114 · `▲ Write down or print this code now. It
is shown ONCE and cannot be recovered later.` L116 · `alert` role, `Failed to
load codes` L133,134

### WaiverComplianceAuditPage — `apps/web/app/admin/waiver-status/page.test.tsx`
`Jordan T.`, `Sam R.`, `Retired R.` L57,78,90,102 · `Missing` L58 · `Nothing in
this view` L66,74,98,119,128(absence) · `All signed`, `All athletes`, `Active
athletes only` (checkbox) L76,87,100 · `Declined` L111 · `Database unavailable`
L127

### ConsentPage (admin) — `apps/web/app/admin/consent/page.test.tsx`
`Sample Athlete One`, `Sample Athlete Two (inactive)` L78,92,93 · `Athlete`
(label) L79 · `Who signed`, `Date signed`, `What was signed` (labels) L100-102,
127,128,202 · `/record consent/i` L103,129,150(disabled),203 · `/A Guardian/`
L171,215 · `Paper in the blue folder`, `Jul 4, 2026` L172,174 · `/Database
unavailable/i` L187 · `/Nothing recorded for this athlete yet/i` L188(absence),
195 · `/Forbidden: role not allowed/i` L205 · `Recorded.` (absence) L206

### PaymentsSettingsPage — `apps/web/app/admin/payments/page.test.tsx`
`Connect Stripe account` (link, count-asserted) L57,76 · `/Account
acct_g_1/` L73 · `Swap Stripe account` L74 · `disconnected`, `/revoked from the
Stripe dashboard/` L88,89 · `Stripe account connected.` L100 · `/Record
compliance sign-off/`, `/Nothing charges until\s+compliance sign-off/` L110,111

### RosterImportPage — `apps/web/app/admin/import/page.test.tsx`
`Roster CSV` (label) L61 · `/check this file/i`, `/add athletes/i` (disabled
states) L71,72,81,96,107,123,129,141,144,160,164,171,185 · `What this would do`
L83,108,124(absence),143,161,186 · `Row 1`, `Row 3`, `No athlete id.` L87-89 ·
`/add 1 athlete$/i`, `/add 1 athlete/i`, `/add 0 athletes/i` (assembled counts)
L98,109,144,187 · `What was loaded` L111 · `/needs at least an athlete id
column/i` L169 · `/The rest of the file was loaded/i`, `/reported as already on
the roster rather than duplicated/i` L189,190

### GrantObligationsPage — `apps/web/app/admin/grants/page.test.tsx`
`/Loading obligations/` L65 · `No obligations on record` (absence) L66 ·
`Community Youth Grant`, `Equipment Grant` L74,76,85 · `overdue` (count) L75 ·
`Mark submitted` L87

### CoachCoveragePage — `apps/web/app/admin/coach-coverage/page.test.tsx`
`Sample Athlete One`, `sub@example.org`, `admin@example.org` L98-100 · `No active
coverage grants` L108,175(absence) · `Database unavailable`, `The list could not
be loaded` L116,117 · `Athlete`, `Covering coach`, `Hours (default 24, max 336)`
(labels) L127,137,157-159,177,178,182 · `Grant` L160,179,193(disabled) ·
`Coverage granted.` L162 · `/Coverage already exists: grant cov-9/` (assembled)
L181 · `/The coach list could not be loaded/`, `/Granting is disabled until the
lists load/` L191,192 · `textbox` role (absence) L196 · `/No active coach
accounts exist in this organization/` L205 · `Revoke`, `Coverage revoked.` L215,
235,237

### MembershipsPage — `apps/web/app/admin/memberships/page.test.tsx`
`Jordan Little` L70,111 · `100% scholarship` L71 · `/No billing happens here/`
L72 · `Enroll athlete`, `Athlete`, `Program`, `Start date`, `Scholarship` (labels,
scoped by `selector` for two different selects), `Save membership` L83-93,113,
130-138 · `/already has an active membership/` L141

### RosterExportPage — `apps/web/app/admin/export/page.test.tsx`
`/download roster/i` L71 · `Athlete ID`, `Date of birth`, `Guardians`, `Emergency
contact phone` (column headers) L90-93 · `/ppbf-roster-org-ppbf-2026-08-01\.csv/`
(assembled filename) L105 · `/with 41 athletes/`, `/with 0 athletes/` (assembled
count) L106,161(absence),173 · `/Nothing was downloaded\. Forbidden: role not
allowed/`, `Saved` (absence) L131,132 · `/The export failed \(HTTP 503\)\./` L149
· `/did not report how many athletes it holds/` L160

### FeedbackTriagePage — `apps/web/app/admin/feedback/page.test.tsx`
`DISCLOSURE`, `BUG` (imported constants) L84,99,199,230,556 · `1 submission
needs a person today` (assembled count) L85 · `/a person must read this/i`
L86,102(absence) · `/needs a person today/i`, `/need a person today/i` (absence)
L100,101 · `Nobody has sent anything yet.` L108,245(absence) ·
`/bugs, frustrations and ideas/i` (absence) L110 · `Maya Alvarez`,
`coach@punxsyprominence.org` L116,117 · `Northside Boxing` (count-asserted twice)
L147,176 · `athlete` L148 · `/save triage/i` (absence, then scoped `within`)
L149,208,233 · `combobox` role (absence) L150 · `/withheld/i` L173 · status/note
labels assembled from submission id: `/^status for submission
sub-safeguarding$/i`, `/^note for submission sub-safeguarding$/i` L202,205 ·
`Marked triaged.` L210 · `Spoke with her and her guardian the same afternoon.`
L211 · `/no longer in this gym/i`, `/^Marked /` (absence) L235,236 · `Internal
server error` L244

### SafetyFlagsBoardPage — `apps/web/app/admin/safety-flags/page.test.tsx`
`no_contact_hold`/`minor_note` (codes, via `.map((el) => el.textContent)`) L70 ·
`blocking` (count) L73 · `Resolve…`, `Resolve flag` L84,87,97,115 ·
`/A note is required on every resolution/` L91 · `Note (required)` (label) L94 ·
`Outcome` (label, options read) L118 · `/Flags may exist that are not shown
here/` L129 · `No open safety flags` L130(absence),140 · `/A raised flag would
appear here/` L141

### DataQualityPage — `apps/web/app/admin/data-quality/page.test.tsx`
`Children hidden from their guardian`, `1 hidden` (assembled count),
`/Hidden athlete ids: ath-2/`, `/par-a, par-b/` L58-61 · `Split but currently
harmless` L62 · `/merge|fix|delete/i` (absence) L64 · `No split guardian
records` L74,85(absence) · `/Duplicates may exist that are not shown here/` L84

### AttendanceDashboardPage — `apps/web/app/admin/attendance/page.test.tsx`
`Weekly trend (last 8 weeks)` L52,73,85(absence) · `img` role name assembled
from date + percentage: `/Week of Jul 27: 83%/`, `/Week of Jul 13: 100%/`,
`/Week of Jul 20: no attendance data/` L53,74-76 · `No active athletes in scope
yet` L84 · `Jordan T.` L98

### SafetyReviewPage — `apps/web/app/admin/safety-review/page.test.tsx`
`Nothing open right now` L40,100(absence) · `Active Training Holds (1)`
(assembled count) L56 · `Jordan T.` L57 · `Failing Safety Gates (1)` L73 ·
`Open Escalations (1)` L89 · `critical` L90 · `Open the full escalation queue`
(link + href) L91 · `Database unavailable` L99

### AdminShadowConsolePage — `apps/web/app/admin/shadow/page.test.tsx`
`/Board packet intake/` L115 · `/upload pdf/i` (absent then present) L122,137 ·
`/read-only in a platform-owner session/i` L123,138(absence) · `VIEW`,
`APPROVE` L125,139,147 · action-name-driven disabled loop L127 · `/approve for
learning/i`, `/document security review/i` L130,131,140,141 · `/STATUS:
Blocked/` L150

### AthleteConsentAuditPage — `apps/web/app/admin/athlete-consent/page.test.tsx`
`Missing Consent Athlete`, `Partial Athlete`, `Cleared Athlete` (present/absent
across filters) L45-90 · `No guardians on file` L56 · `1/2 consented` L65 ·
`Consent on file`, `All athletes` (buttons) L74,86 · `Nothing in this view` L98 ·
`Database unavailable`, `The audit could not be loaded` L106,107

### AthleteRecordsPage — `apps/web/app/admin/athletes/page.test.tsx`
`/correct record/i`, `/date of birth/i`, `/save correction/i` L126-133,160,167,
251,258,275,277 · `/deactivate athlete/i`, `/yes, save it/i` L161,167 · `/could
not be read/i`, `/no athlete records in your gym yet/i` (absence) L187,188 ·
`/attendance 86%/i` (assembled) L201 · `Dawn Kellerman` / `Dawn Kellermann`
(typo-correction fixture) L213,230,276,282 · `/attendance \d/i` (absence) L214,
231 · `Attendance` (link + href) L241 · `/^coach$/i`, `/weight class/i`,
`/full name/i` (labels) L253,257,276,282 · `alert` role, `/is saved\./i`
(absence) L279,280 · `/athlete records are managed per gym/i` L292

### VolunteerManagementPage — `apps/web/app/admin/volunteer-management/page.test.tsx`
`Full name` (placeholder) L62,84 · `/create/i` L64,86 · `Volunteer created.`
L75 · `Dana Ruiz` L116 · `active` L117 · `/no longer on this roster/i` L119 ·
`Volunteer status updated to active.` (absence) L120 · `pending` (count) L121

### BoardSeatsPage (admin-side of board seats) — `apps/web/app/admin/board-seats/page.test.tsx`
`Board Chair`, `Director-at-Large` L114,121 · `dana@example.org`,
`Holds the seat`, `rosa@example.org`, `Additional holder`, `Unfilled` (counts)
L115-118,122 · `Seat`, `Member` (labels) L130,131,149,150,196,197 ·
`/Board Chair is held by dana@example\.org/` (assembled) L133,151 ·
`/assign seat/i` (disabled/enabled/absence) L134,199,233,241,251 ·
`/hand the seat over/i`, `/hand seat over/i` L153,180 · `Additional holder`
(checkbox) L198 · `/^remove$/i` (absence) L215,242 · `/You can see the roster
but not change it/` L234(absence),240 · `Forbidden: role not allowed` L250

### CompliancePage (see Board section for board-side variant) / DirectorDashboardPage — `apps/web/app/director/dashboard/page.test.tsx`
Gated `requirePageRole(['organization_admin'])` — an admin-role page despite the
route name. `/ESC-/` (absence) L31 · `/demonstration escalation queue with
invented incidents/` L32

---

## Board

### BoardSummaryPanel — `apps/web/app/board/BoardSummaryPanel.test.tsx`
`label` variable (heading, generic across tiles) L73 · `Active Athletes`, `12`
L93,126(absence) · `Coach Reviews (30 Days)`, `Approved 75% (6 of 8)` (assembled
fraction+percent) L94 · `Suppressed` (scoped `within`) L101 · `/Fewer than 5
athletes contributed/` L102 · `No records`, `/No completed goals recorded in
this period/` L110,111 · `Measured 2026-07-24 12:00 UTC` (assembled timestamp)
L119 · `Unable to load the organization aggregate.` L125

### BoardHubPage — `apps/web/app/board/page.test.tsx`
`12` L64 · `Measured 2026-07-24 12:00 UTC` L65 · `Suppressed` (count via
`.length`) L66

### BoardEscalationMonitoringPage — `apps/web/app/board/escalation-monitoring/page.test.tsx`
`label` (heading) L56 · `Read this zero correctly` L75,95(absence),121(absence)
· `None open` (count of 4) L76 · `0` (absence) L77 · `Unable to load the
escalation summary.` L120

### BoardComplianceMonitoringPage — `apps/web/app/board/compliance-monitoring/page.test.tsx`
`label` (heading) L71 · `None filed`, `/Nobody has filed one/` (scoped `within`)
L83,84 · `/No compliance violation has ever been filed/`, `/no one has filed
one, not that nothing has happened/` L87,88,160(absence) · `Suppressed`,
`/Fewer than 5 athletes are involved/` (scoped) L103,104 · `13` (scoped `within`
tile) L107 · `new (suppressed)`, `acknowledged (9)`, `escalated (none filed)`,
`All (14)` (assembled counts, button names) L122-125,146,157 ·
`/platform runs no violation detector/` L133 · `Read 2026-07-24 12:00 UTC`
(assembled timestamp) L139 · `/No violation with the selected status has been
filed/`, `/Nothing with this status has been filed/` (scoped) L161,162

### BoardMemberDashboard — `apps/web/components/BoardMemberDashboard.test.tsx`
`Treasurer Workspace`, `Program & Safety Director Workspace`, `Secretary
Workspace`, `President Workspace` (per-seat headings, present/absent) L64,72,82,
91,97,106 · `You hold this seat.` L65 · `/governance oversight of every seat/i`
L73 · `Board hub` (link + href) L84 · `/Read-only, and no board seat is held/`
L98 · `BOARD_AGGREGATE_BOUNDARY_STATEMENT` (imported constant, assembled) L112 ·
`/Access is decided by the server on every request/` L113 · `Unavailable`
(absence, all) L121 · `Not stored by this platform` L122 · `/Financial
reserves, grants, and budgets/` L123 · `Veteran-Owned` (absence), `Veteran-
Founded` L129,130 · `Hand-Filed Compliance Register` (link) L136 · `/Compliance
Monitoring \(Planned\)/` (absence) L138 · `Organization Aggregate` L144 ·
`Available now` (count), `PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED`
(count) L145,146

### BoardRoleGate — `apps/web/components/BoardRoleGate.test.tsx`
`role:board seats:treasurer,at-large`, `role:board seats:none`,
`role:platform_owner seats:none` (assembled probe strings) L60,67,74 ·
`/^role:/` (absence) L82 · `Retry` L111 · retry-button/status-text race L47

### BoardSeatEvidence — `apps/web/components/boardSeatEvidence.test.tsx`
`Physical Injury Prevention`, `Code of Conduct` (via `getAllByText` regex +
`.map`) L58,59 · `/Nothing evaluates them automatically/` L64 · `/no active
compliance rules/i` L72 · `Gym closed Monday for the holiday.` L99 ·
`/Coach Jason/`, `/it is notices, not minutes/i` L100,101 · `/No notices have
been published/i` L115 · `/could not be read/i`, `/not an empty register/i`
L125,126,134

---

## Staff / Operations

### DirectorDashboardPage — see Board/Admin section above (gated `organization_admin`).

### OperationsHubPage — `apps/web/app/operations/page.test.tsx`
Gated to `operationsRoles` (every route role plus `platform_owner` — effectively
an all-roles index). `/readiness flags are below safe threshold/i`,
`/governance deadline enters risk window/i`, `/capture rate remains at 100%/i`
(absence) L61-63 · `SHADOW COMMAND NODE` (heading, scoped to parent) L74 ·
`/nothing has been recorded/i` L75 · `SHADOW Monitoring`, `Video Review
Intelligence`, `AI Video Analysis`, `Closed-Loop Progression Intelligence`,
`Sports Medicine`, `Performance Analytics`, `Wrestling League Management`,
`External Competition Platform`, `Membership Tracking`, `Scholarship Tracking`,
`Publication Workflow Automation` (section headings, each read via `getByRole`
and then scoped with `.closest()`/`.parentElement`) L83-208 · `Notices &
Motivation` (link + href) L92 · `Session Script Delivery`, `Safety Compliance
Center`, `Coach Coverage`, `Drill Library` L220-223 · `/backed by pilot.
session_script_runs/` L224 · `/BREAK MY 40% RULE/`, `/GRIND STATE ENGAGED/`
(absence — banned-vocabulary guard) L231,232

### ExternalCompetitionPlatformPage — `apps/web/app/operations/external-competition/page.test.tsx`
`/Minimal skeleton by owner decision/`, `/stay unbuilt until real competitions
define/` L80,81 · `Regional Open 2026`, `State Finals` L91,105 · `Add
competition`, `Competition name`, `Date`, `Sanctioning body (optional)`, `Save
competition` L102,105-110 · `Open entries` L131,160 · `/Jordan Little/` L134 ·
`Enter athlete`, `Add entry` L137,140,163,166 · `This athlete is already
entered in this competition.` L169

### WrestlingLeagueManagementPage — `apps/web/app/operations/wrestling-league/page.test.tsx`
`/Minimal skeleton by owner decision/`, `/stay unbuilt until a real\s+league
defines/` L90,91 · `Winter League 2026`, `Spring League` L101,115 · `Add
season`, `Season name`, `Starts`, `Save season` L112,115,116,119 · `Open
detail`, `/Opening Duals/`, `/Jordan Little/`, `Add athlete`, `Add to roster`
L135-171 · `This athlete is already on the season roster.` L174

### WorkspacePage — `apps/web/app/workspace/page.test.tsx`
Gated `['staff', 'volunteer']`. `vol@example.com` (session identity) L87,125 ·
`ppbf-default-org` L88 · `Volunteer` (count) L89 · `Open gym moves to 6pm on
Thursday.` L105 · `Gym notices are temporarily unavailable.` L118

### ResearchQAChatPage — `apps/web/app/research/chat/page.test.tsx`
`Write your findings...` (placeholder) L43,60,75,69(value check) · `Add Note To
Transcript` L48,65,78 · `/stays in this browser session only/i`, `/It is not
stored anywhere/i` L51,52 · `/Research note captured/i`, `/characters
logged/i` (absence) L53,54 · `/Note: Southpaw drill worked better after the
footwork block\./` (assembled) L68

### ResearchIntakePage — `apps/web/app/research/page.test.tsx`
`Is RPE reliable at age 12?` L76,87,102 · `Sources Submitted` L77 · `Answer this
gap` (absence then click, incl. `getAllByRole` indexed) L88,104,135 · `Mark
Resolved`, `Save Requirement` L90,91 · `Library source` (label) L107,138,230(assembled) ·
`Submit source` L112,141 · `/answers nothing until evidence review says so/i`
(single + count) L120,144 · `Does footwork drill order matter?` L133 ·
`General Research Intake` (absence then present) L190,201 · `Title`,
`Classification domain`, `DOI / PMID`, `Provider` (labels) L203-206 · `Register
general research` L209 · `/Evidence review still decides what becomes
citable/` L217 · `Nonprofit board best practices` L228 · `Correct classification
for Nonprofit board best practices` (assembled label from title) L230

### SchedulerPage — `apps/web/app/schedule/schedulerReload.test.tsx`
Gated `['athlete','coach','parent','admin']` — genuinely multi-role. `combobox`
role (count) L90 · `Class Schedule` L109,120,137 · `Loading scheduler...`
(absence) L129

---

## Shared / Common

These components are not gated to one role — several are embedded directly in the
athlete dashboard and/or the parent hub, so a rename that touches them is in scope
for the athlete/parent redesign even though the test lives outside those folders.

### AnnouncementBanner — `apps/web/components/announcementBanner.test.tsx`
*Embedded in: athlete workspace, parent hub, coach workspace, chalkboard page.*
`Nothing on the board.` L133,142 · `/no announcements/i` (absence) L135 ·
`alert` role (absence) L136,142 · `Gloves on at five. Bring water.` L149 ·
`/Coach Jason/` L150 · `/write on the board/i` (absence/present across auth
states) L158,164,169,174,183,189 · `/Microsoft sign-in/i` L159(absence),184 ·
`/rub it out and write/i` L194

### GymWallModule / PhotoSlot — `apps/web/components/gymWallModule.test.tsx`
*Embedded in: kiosk wall display, referenced from public portal photo slots.*
`The ring`, `/never step in it/` L37,38 · `/Nobody has taken these yet/`,
`/no pictures of anybody.s kid on a shared screen/i` L108,109 · `next`/`previous`
(button regex, absence/present) L114,132,151,165 · `1 of 2`, `2 of 2` L129,136

### WallOfNames — `apps/web/components/wallOfNames.test.tsx`
`2019`, `2024`, `A.D.`, `B.K.` L57-60 · `/needs a signed release naming that
screen/i` L68 · `Training now`, `Came through` L76,77 · `People on this wall`
L94 · `Nobody is on the wall yet` L105,125(absence) · `/it never comes down/i`
L106 · `Not recorded` L107 · `/Names are switched off/i` L115 · `2019–2024`
L117 · `alert` role, `The wall did not load` L123,124 · `Year not recorded`
L143 · `/plenty of people trained here long before any of this existed/i` L148

### WordsOnTheWall / BoxingNumberNote / AnniversaryNote — `apps/web/components/wordsOnTheWall.test.tsx`
`/^TEST LINE (ONE|THREE)$/`, `Test Fixture` L76,77 · `complementary` role named
`/words on the wall/i` L106 · `status` role L129 · `A year, this week. Same
gym, same door.` L138 — plus the `boxingNumberNote` copy fragments sourced from
`achievementCeremony.test.ts` (see Athlete section cross-reference).

### ThenAndNow — `apps/web/components/thenAndNow.test.tsx`
`/January 12, 2026/`, `first week`, `3`, `sessions 13`, `/Kept her guard
up/`, `/Coach Neale/` L64-70 · `/This frame fills itself/` L83

### CardCatalog / Corridor — `apps/web/components/cardCatalog.test.tsx`, `cardCatalogActs.test.tsx`
`dialog` role (open/close cycles) throughout · `open the card catalog` L69 ·
`Gym Floor`, `Board Room` (present/absent by nav depth) L115,116,224,225 ·
`combobox`/`option` roles, including `aria-selected` state L122-172,206 ·
`/nothing filed under that/i` L173 · `People` (absence) L208 ·
`expanded: false` button state, `navigation` role (present/absent) L216-248 ·
`/you are here/i` L232 · `Review Queue` (link) L239 · `Treasurer` (link,
present), `Capability Console` (link, absent) L256,257 · from `cardCatalogActs`:
banned-verb regex sweep `new RegExp(`\\b${verb}`, 'i')` L142 · `Things you can
do here`, `Print this page` L164,165,172 · `Copy a link to this page` L207 ·
`status` content matching `/copied|clipboard/i` L213 · `Sign out` (present,
then absent after click) L221,238 · `/dashboard` (door target text) L246 ·
`Ring the bell` (present/absent by permission) L260,268,276,288,301 · `status`
content matching `/rung/i` and `/sound is off/i` L290,291 · `Turn the gym sound
on` L310 · `/you know where the drawer is/i` L323,330,336 · `/before six/i`
(and a companion check that its text does **not** contain `!`) L344,346,357

### Chalkboard (component) — `apps/web/components/chalkboard.test.tsx`
`Everywhere`, `The athletes' board`, `The coaches' board`, `The parents' board`
(role-scoped chalkboard targets) L78-81 · `/write on the board/i` (indexed,
count of 4) L76,99,130 · `/what the board should say/i`, `/your name/i`
(labels) L103,106,133 · `/put it up/i` (disabled state) L110,139

### GlobalRoleHeader — `apps/web/components/globalRoleHeader.test.tsx`
No literal-copy rows matched the listed selectors in this file beyond structural
checks already captured via `roleSession.snapshotStability.test.tsx` (no text
pins there either) — flagged here only because `CommandsOverlay` and
`RoleStandaloneView`, which *do* pin copy, are rendered from inside it.

### CommandsOverlay — `apps/web/components/commandsOverlay.test.tsx`
`dialog` role named `/keyboard shortcuts/i` L88 · shortcut label list via loop
variable `s.label` L125 · `listitem` count L127 · `Anywhere` L134 ·
`/show this list of shortcuts/i` L154

### RoleStandaloneView (breadcrumbs) — `apps/web/components/roleStandaloneBreadcrumbs.test.tsx`
`Breadcrumb` (label, present/absent) L49,50,62 · `Coach` L61 · `body` L203

### FeedbackBox — `apps/web/components/feedbackBox.test.tsx`
`/tell us/i` L26,69,76(absence) · `/type it however it comes out/i`
(placeholder) L30,119 · `Send` L52,73,94,115,130 · `acknowledgement` (variable)
L75 · `Thank you.` L105 · `Internal server error` L117

### ProfilePortrait — `apps/web/components/profilePortrait.test.tsx`
`SA` (initials, assembled) L32,71 · `img` role named `Sofia Alvarez`
(single and `getAllByRole` count of 1) L47,55,135 · `button` role named
`Sofia Alvarez` L148

### PrintRoom / PrintableCertificate / PrintableFightCard — `apps/web/components/printArtifacts.test.tsx`
`Marcus Ruiz`, `/The Engine/`, `Youth Mentorship Programme`, `Jason Neale`,
`Blue corner` L132-142 · `img` role, initials assembled via `.textContent`
L149 · `No coach of record yet`, `Start date not recorded`, `""` (absence)
L175-178 · `Helped a newer kid settle in`, `/Helped somebody new find their
feet/`, `/Marked by a coach who watched it happen/` L195-198 · `Certificate`,
`Wraps their own hands properly` L249,250 · `No certificate to print`,
`/Nothing is missing and nothing is late/` L257,258,295 · `Came in for the
first time` L265 · `alert` content matching `/ask a coach/i` L274

### ShadowCommandFeed — `apps/web/components/shadowCommandFeed.test.tsx`
`/Reading the operational record/`, `/nothing has been recorded/i` L45,46,81
(absence) · `observation_recorded`, `projection_read`, `event`, `telemetry`
L72-75 · `listitem` count L77

### ShadowEvidenceDisplay — `apps/web/components/shadowEvidenceDisplay.test.tsx`
`/\[E:1\] SHADOW Canonical Authority Model — Authority Model/`,
`/\[E:2\] USA Boxing Safety Rules — Rulebook 2026/` (assembled citation labels)
L66,67

### ShadowMessageRender — `apps/web/components/shadowMessageRender.test.tsx`
`handoff` (variable holding assembled text) L84

### SoundToggle / useGymSound — `apps/web/components/useGymSound.test.tsx`
`button` role only (no literal label asserted in this file) L96,103

### WallDisplay (kiosk board) — `apps/web/components/wallDisplay.test.tsx`
`/Punxsy Prominence/i`, `/coming up/i` L144,145,224(absence check pairs at 155,
214) · `/On the floor/i`, `/^As of /` L169,170 · `M.R.` (present then absent
after reconnect) L203,213 · `/Nobody checked in yet today/i` L301 · `/Nothing
on the schedule/i` L306 · `/7 people training/i` L311 · `+23 more`, `24`
(assembled overflow count) L334,335 · `/Nothing posted today/i` L342 ·
`Closed Monday for the holiday.`, `/Coach Dan/` L349,350 · `5 · 13 · 34 · 89 ·
233` (assembled milestone ladder) L358 · `Marcus`, `34` (count) L365,366

### LoginPage — `apps/web/app/login/page.test.tsx`
`Continue With Microsoft` L92 · `/Microsoft/` (button, count) L104

### NoticesPage — `apps/web/app/notices/page.test.tsx`
Gated `['admin','coach','platform_owner','board']`. `Everything Posted`
(heading, scoped) L93 · `LIVE`, `SCHEDULED`, `EXPIRED`, `RETIRED` (scoped
within) L94-97 · `Live Right Now` (heading, scoped) L108 · `/Gloves on at
5\./`, `/Tournament sign-ups open Monday\./` (absence, scoped) L109,110 ·
`/Nothing live\./` (count, scoped) L111 · `What should this surface say?`,
`Your name, as members will see it` (placeholders) L127,130,155,156 ·
`/Placement/`, `/Kind/` (labels) L133,134 · `Publish` (disabled) L137,161 ·
`/Starts \(optional\)/`, `/Ends \(optional\)/` (labels) L157,158 · `The end
time must be after the start time.` L160 · `Retire`, `Restore` L179,183 ·
`Retired. It no longer renders anywhere.` L182 · `/Nothing below is the full
list/i`, `Nothing has been posted for this gym yet.` (absence) L191,192

### ChalkboardPage — `apps/web/app/chalkboard/page.test.tsx`
Gated `['coach','admin','platform_owner','board']`. `ann-1`, `coach-1` L72,73 ·
`/Coach Ramos/`, `/Southpaw Footwork Progression Concept/`, `/Governance
Review/` (absence) L76-78 · `/No audit events have been recorded/i`
(present/absent) L84,91,108 · `/could not be loaded/i` (absence) L85 ·
`/nothing being read/i` L92,109 · `Retry loading the audit trail` L96

### AuditTracePage — `apps/web/app/audit/page.test.tsx`
Gated `['admin','coach']`. See ChalkboardPage above — same file
(`apps/web/app/audit/page.test.tsx`) actually backs both routes' shared audit
copy.

### PublicPortalPage — `apps/web/app/public/photoSlots.test.tsx`
`slot.title` (loop variable) L28 · `/drawn stand-ins of our own room/i`,
`/come and look at the real thing/i` L53,54 · `WHO WOULD BE COACHING YOUR KID`
L71 · `person.name`, `person.role` (loop) L73,74 · `/a gap on this page, not a
gap in the gym/i` L88 · `/A boxing gym for kids, for adults, and for anyone who
just wants to get in shape\./` L97 · `WHAT WE ACTUALLY RUN`, `QUESTIONS PEOPLE
ACTUALLY ASK` L99,100

### RabbitHole / HelpPanel — `apps/web/components/rabbitHole.test.tsx`
*Embedded in: athlete progression-intelligence page, coach progression-
intelligence page.* `Session notes for today` L103 · `HELP:` (button regex)
L237,257,270 · `Advanced research into biomechanics, neurology, and boxing
theory.` L239 · `Reading but not doing homework` L240,275

### Design-token tests with no text pins
`apps/web/src/design/kioskTapFloor.test.tsx` and `apps/web/src/design/
wallSurface.test.tsx` import `@testing-library/react` but assert on computed
style/DOM structure, not on any of the listed text/role/label APIs — zero rows.
`apps/web/components/roleSession.snapshotStability.test.tsx` similarly renders
only a `data-testid` probe (`session ? session.role : 'none'`), not user-facing
copy.

---

## Migration-only suites (`*.pg.test.ts`)

These 83 files only run under `npm run test:migrations:*`, not the ordinary
`jest` gate, and none of them render UI or import `@testing-library/react` — a
copy-only rename requires **no changes here**. Listed for completeness per the
audit brief:

```
apps/web/scripts/import-shadow-research.pg.test.ts
apps/web/src/server/pilot/activationPinExposure.pg.test.ts
apps/web/src/server/pilot/activityLog.pg.test.ts
apps/web/src/server/pilot/announcementParentHubPlacement.pg.test.ts
apps/web/src/server/pilot/announcementPlacements.pg.test.ts
apps/web/src/server/pilot/announcementsPersistence.pg.test.ts
apps/web/src/server/pilot/assessmentProtocols.pg.test.ts
apps/web/src/server/pilot/assistantMessageIdempotency.pg.test.ts
apps/web/src/server/pilot/attendanceParentMethod.pg.test.ts
apps/web/src/server/pilot/attendanceReporting.pg.test.ts
apps/web/src/server/pilot/boardSeats.pg.test.ts
apps/web/src/server/pilot/clearanceRegister.pg.test.ts
apps/web/src/server/pilot/coachCoverage.pg.test.ts
apps/web/src/server/pilot/coachRosterFieldScope.pg.test.ts
apps/web/src/server/pilot/competenceCohorts.pg.test.ts
apps/web/src/server/pilot/competenceCohortsModule.pg.test.ts
apps/web/src/server/pilot/complianceMigration.pg.test.ts
apps/web/src/server/pilot/complianceRuleSeeds.pg.test.ts
apps/web/src/server/pilot/dataRetentionDeletion.pg.test.ts
apps/web/src/server/pilot/deadSchemaRemoval.pg.test.ts
apps/web/src/server/pilot/drillLibraryV3.pg.test.ts
apps/web/src/server/pilot/drillVersioning.pg.test.ts
apps/web/src/server/pilot/drillVocabularyWidening.pg.test.ts
apps/web/src/server/pilot/drills.pg.test.ts
apps/web/src/server/pilot/drillsPersistence.pg.test.ts
apps/web/src/server/pilot/duplicateGuardianCheck.pg.test.ts
apps/web/src/server/pilot/durableRateLimit.pg.test.ts
apps/web/src/server/pilot/escalationLadder.pg.test.ts
apps/web/src/server/pilot/externalCompetition.pg.test.ts
apps/web/src/server/pilot/feedback.pg.test.ts
apps/web/src/server/pilot/feedbackReviewExit.pg.test.ts
apps/web/src/server/pilot/filmStudyProposals.pg.test.ts
apps/web/src/server/pilot/floorHours.pg.test.ts
apps/web/src/server/pilot/gateFixtureProvisioning.pg.test.ts
apps/web/src/server/pilot/gateSession.pg.test.ts
apps/web/src/server/pilot/gearCatalog.pg.test.ts
apps/web/src/server/pilot/gearVendors.pg.test.ts
apps/web/src/server/pilot/goalCategoryProgress.pg.test.ts
apps/web/src/server/pilot/grantObligations.pg.test.ts
apps/web/src/server/pilot/guardianClaimOnInvite.pg.test.ts
apps/web/src/server/pilot/guardianInviteLink.pg.test.ts
apps/web/src/server/pilot/guardianMediaConsentMigration.pg.test.ts
apps/web/src/server/pilot/intakeDocumentReview.pg.test.ts
apps/web/src/server/pilot/interventionEvidence.pg.test.ts
apps/web/src/server/pilot/interventionExecutions.pg.test.ts
apps/web/src/server/pilot/interventionProtocols.pg.test.ts
apps/web/src/server/pilot/libraryReviewFlags.pg.test.ts
apps/web/src/server/pilot/libraryScopeCheck.pg.test.ts
apps/web/src/server/pilot/localFindings.pg.test.ts
apps/web/src/server/pilot/magicLinkRedemption.pg.test.ts
apps/web/src/server/pilot/multidiscipline.pg.test.ts
apps/web/src/server/pilot/multiorgOrphanCheck.pg.test.ts
apps/web/src/server/pilot/nearMissContext.pg.test.ts
apps/web/src/server/pilot/paymentLedger.pg.test.ts
apps/web/src/server/pilot/platformLibraryScope.pg.test.ts
apps/web/src/server/pilot/programMemberships.pg.test.ts
apps/web/src/server/pilot/progressionMigration.pg.test.ts
apps/web/src/server/pilot/publicationRetraction.pg.test.ts
apps/web/src/server/pilot/publicationsMigration.pg.test.ts
apps/web/src/server/pilot/rabbitHoles.pg.test.ts
apps/web/src/server/pilot/safetyFlags.pg.test.ts
apps/web/src/server/pilot/safetyGateMatrix.pg.test.ts
apps/web/src/server/pilot/schemaVerification.pg.test.ts
apps/web/src/server/pilot/sessionExpiry.migration.pg.test.ts
apps/web/src/server/pilot/sessionScriptRuns.pg.test.ts
apps/web/src/server/pilot/sessionScripts.pg.test.ts
apps/web/src/server/pilot/sessionScriptsTransfer.pg.test.ts
apps/web/src/server/pilot/shadowJobQueue.pg.test.ts
apps/web/src/server/pilot/shadowLibraryPipeline.pg.test.ts
apps/web/src/server/pilot/shadowResearchSubmissions.pg.test.ts
apps/web/src/server/pilot/sourceCitationChecks.pg.test.ts
apps/web/src/server/pilot/sourceRetractionChecks.pg.test.ts
apps/web/src/server/pilot/sparringExposure.pg.test.ts
apps/web/src/server/pilot/strandedGuardianCheck.pg.test.ts
apps/web/src/server/pilot/strandedGuardianRepair.pg.test.ts
apps/web/src/server/pilot/trainingAttempts.pg.test.ts
apps/web/src/server/pilot/trainingHolds.pg.test.ts
apps/web/src/server/pilot/videoScanPromotion.pg.test.ts
apps/web/src/server/pilot/videoSessionsMigration.pg.test.ts
apps/web/src/server/pilot/volunteerProgram.pg.test.ts
apps/web/src/server/pilot/waiverCompliance.pg.test.ts
apps/web/src/server/pilot/workoutTemplates.pg.test.ts
apps/web/src/server/pilot/wrestlingLeague.pg.test.ts
```

(83 files. Note: the audit brief estimated "~36" — the actual count on `origin/main`
today is 83; treat the brief's number as stale, not this count.)

---

## Fragile Patterns

Things a naive find-and-replace over literal strings will miss, in rough order of
how often they appear above:

1. **Regex matchers over copy** — by far the most common pattern in this codebase.
   Hundreds of assertions use `getByText(/some partial phrase/)` instead of an exact
   string. A rename that changes wording *inside* the matched span (not just outside
   it) breaks these; a rename that only changes wording *outside* the matched span
   leaves them silently passing against copy that no longer matches the full
   sentence a screen reader announces. Every regex row above needs a human read of
   the surrounding sentence, not a regex-replace.

2. **Strings assembled from live data at render time**, so no static string exists
   to search-and-replace at all:
   - Counts: `1 active training hold(s) and 1 gate(s) awaiting clearance`
     (parentHubChildSwitch), `Showing 5 of 5 on file.` / `DELETE 5 CAPABILITIES`
     (bulkCapabilities), `Approved 75% (6 of 8)` (BoardSummaryPanel), `1 RED, 0
     YELLOW, 1 unknown` (CoachWorkspace), `+23 more` (WallDisplay), `Week of Jul
     27: 83%` (AttendanceDashboardPage, via an accessible `img` name).
   - IDs/names: `Jordan Doe's Progression`, `Account: ath-001`, `✓ Video "vid-101"
     approved…`, `Coverage already exists: grant cov-9`, `Alex Johnson is already
     on your roster as ath-1`.
   - Aria-labels built from a template: `${count} session milestone, earned/not
     yet earned` (TrainingCard/trainingCardCeremony — read via raw
     `querySelector` + `getAttribute('aria-label')`, which the grep for
     `getByLabelText` does **not** catch), `Report progress for <goal title>`
     (AthleteWorkspace), `Correct classification for <research title>`
     (ResearchIntakePage), `Select CAP-003` (bulkCapabilities checkboxes).
   - A rename of the surrounding template text (e.g. "session milestone" →
     "training milestone") must be applied to the *template*, and every test
     asserting the assembled result must be updated in the same PR — grepping for
     the literal old string will only find the ones that happen to hold still.

3. **Imported constants used as the expected value**, so the test file itself
   contains no literal copy to find: `DISCLOSURE` / `BUG` (admin/feedback),
   `BOARD_AGGREGATE_BOUNDARY_STATEMENT` (BoardMemberDashboard),
   `HOLD.athlete_explanation` (coach/sports-medicine, pulled from a fixture, not
   from the UI copy source at all — this one asserts the fixture's own text is
   echoed back verbatim, so it will not notice a *wrapper* copy rename around it,
   but will break if the rendering path re-formats the string). Renaming the
   underlying copy source updates these automatically **only if** the constant
   lives where the component also sources it; where the test recomputes an
   expected value locally instead of importing the same constant, they drift.

4. **Snapshot-free, but assert-on-raw-DOM patterns that bypass RTL's own text
   matchers**: `trainingCardCeremony.test.tsx` (`container.querySelector(...)
   .getAttribute('aria-label')`, `.textContent`), `CoachRecognitionPad.test.tsx`
   and `ProfilePortrait.test.tsx` (initials assembled via `.textContent`),
   `TrainingCard.test.tsx` line 98 (`getAttribute('title')` read directly rather
   than via `getByTitle`). These will not show up if someone later greps the repo
   for `getByText`/`getByRole` to scope a rename — they were only found here
   because this audit also grepped raw `querySelector`/`getAttribute` in the
   files under review.

5. **Negative-space / banned-vocabulary assertions**: `cardCatalogActs.test.tsx`
   sweeps a list of verbs and asserts *none* of them appear
   (`queryByText(new RegExp('\\b' + verb, 'i'))`); `OperationsHubPage` asserts
   `/BREAK MY 40% RULE/` and `/GRIND STATE ENGAGED/` never render;
   `boxingNumberNote`'s tests assert the copy never contains `streak`,
   `consecutive`, `in a row`, `don't break`, `keep it up`, `missed`, `lapsed`, or
   `expired`. A rename that introduces any of these words as *new* copy will fail
   a test that has nothing to do with the renamed label, in a file the redesign
   PR is unlikely to think to open.

6. **Selector-scoped duplicate-text assertions**: `parentHubChildSwitch.test.tsx`
   distinguishes two identically-named children via `{ selector: 'p' }` /
   `{ selector: 'h4' }`, and `bulkCapabilities.test.tsx` distinguishes a status
   badge from other same-text nodes via `{ selector: 'span' }`. Renaming the
   *tag* a label renders in (e.g. promoting a `<p>` to a `<h4>` as part of a
   visual redesign) breaks these even if the text itself is untouched.

7. **No snapshot tests exist in this repository** (`*.snap` glob returns zero
   files repo-wide; `toMatchSnapshot`/`toMatchInlineSnapshot` grep returns zero
   hits). This is good news for a rename — there is no snapshot-diff noise to
   wade through — but it also means there is no automatic net catching *any*
   incidental markup/copy change that the explicit assertions above don't
   already cover. Every rename's blast radius is exactly the rows in this
   document, no more and no less.
