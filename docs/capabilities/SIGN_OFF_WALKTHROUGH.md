# Sign-off walkthrough: DONE modules not yet tried by a person

Checked against the code on 2026-09-29 (branch `local/housekeeping-round3`:
`origin/main` `91de82ca` plus `10dd3efd`).

**What this is.** Jason's answer "9a. B" (OD-2026-09-29-002): every DONE
capability module with no ManualVerification record is labelled "built, not
yet tried by a person" (`ManualVerification | PENDING_SIGN_OFF` in its module
file) and listed here with one way to try it on the tablet.

**Tests prove the code runs. They do not prove a screen works for a coach.** A
passing test says the code does what the test asks. It does not say the page
loads on the gym tablet, reads well, or does the job. Only a signed-in person
can check that.

**A row moves to SIGNED_OFF only on Jason's word.** Write what happened in the
Result column. Claude changes a module file's ManualVerification to
`SIGNED_OFF` only when Jason says so for that module.

**How many: 48.** The 47 DONE modules that had no ManualVerification row on
2026-09-29, plus module 084, marked DONE the same day (Jason's "11A"). The
earlier figure, 36, is the count in `docs/current/SIGN_OFF_GUIDE.md`, which
only covers modules the 2026-08-03 CSV marked `PENDING_SIGN_OFF`. The other 11:
003, 011, 075 and 076 (the CSV said `PASSED`, with no record of who checked),
and 053, 121, 123, 125, 127, 128 and 129 (promoted 2026-08-16; their audit
logs name `PENDING_SIGN_OFF` but no row was written).

**Accounts.** Coach = a coach account. Org admin = `ppbf@punxsyprominence.org`
(not `Admin@`, the platform account, which cannot open athlete records).
Athlete and Guardian = a test athlete and that athlete's linked parent. The
account named is one the page lets in (the `allowedRoles` on the page's
`RoleSessionGate`); any other role is sent back to its own start page.

**These steps write real records.** Use a test athlete. Milestones (126) and
1% Club votes (127) cannot be undone. Approving a source (139, 141) changes the
real SHADOW library. A Tell Us test (198) sits in the safeguarding queue until
an org admin closes it.

**Nothing to try yet (Jason's call: build a screen, or accept API-only).** 027,
042 and 135 have no screen. 128's page loads but nothing can add an entry.
Parts of 001, 116, 133 and 170 are API-only; the row says which part.

**The older guide.** `docs/current/SIGN_OFF_GUIDE.md` (2026-08-18) covers 36 of
these. Some of its lines are out of date: holds are now placed and lifted on
`/coach/sports-medicine` (045, 082), and punch, weight and confidence results
now show on `/coach/athlete-intelligence` (039, 104, 131). Where the two
disagree, this file is the later check.

| # | Module | Where to try it | Sign in as | Try this, expect that | Result |
|---|--------|-----------------|------------|-----------------------|--------|
| 001 | Athlete Profile System | `/coach/passbook-gaps` | Coach | Open it. Expect open progression gaps for your own athletes only, each with the last day in the gym; an empty list passes if none are open. The single-athlete Passbook has no screen (API only). | |
| 002 | Raw Observation Intake System | `/coach/decision-loop`, "Behavior & Habit Note" | Coach | Pick an athlete, type a note, press Log Note. Expect "Note logged." | |
| 003 | Safety Gate System | `/coach/sports-medicine`, then `/schedule`, then `/admin/safety-review` | Coach, then Org admin | Place an "All training" hold on a test athlete, then try to register that athlete for a class. Expect the registration refused with the hold's own explanation and, where the gym has the training-hold gate set up, a blocked row under "Failing Safety Gates". The module file names no screen; this is the participation path the code blocks. | |
| 006 | Training Assignment System | `/coach/progression-intelligence` | Coach | Pick an athlete, open a gap, press "Assign drill", fill it in. Expect it under "Assigned Drills"; the athlete then sees it on `/athlete/dashboard`. The module file names no screen; this is the only assignment write path found. | |
| 011 | Goal Management System | `/athlete/dashboard`, "SMART Goals" | Athlete | Press "+ New SMART Goal", pick a category, save, then set its progress. Expect the category and progress still there after a reload. The module file names no screen. | |
| 026 | Intervention Tracking Engine | `/coach/intervention-protocols`, `/coach/intervention-executions`, `/coach/intervention-review` | Coach | File a protocol, start an execution from it and close it with what actually happened, then review the outcome. Expect planned and actual side by side and no score or percentage field. If a page cannot load, its tables may not be in production yet (module file, 2026-08-16; not re-checked). | |
| 027 | Testing / Retest Engine | No screen | - | Nothing to try: no page calls the retest queue (`/api/pilot/data-collection-requests`). | |
| 039 | Punch Quality / Volume Engine | `/athlete/dashboard/sparring`, then `/coach/athlete-intelligence` | Athlete, then Coach | Log a session with punches thrown, landed and absorbed. Expect "Saved to your training record." Then, as coach, pick that athlete and expect accuracy and connect-differential results. | |
| 042 | Round Performance Engine | No screen | - | Nothing to try: the round formulas need round-by-round output and no form in the app records it. | |
| 043 | Contact / Sparring Restriction Engine | `/athlete/dashboard/sparring`, then `/coach/decision-loop` | Athlete (no medical clearance on file), then Coach | Log a session with contact above None. Expect "Saved. There is no current medical clearance on file for this athlete, so your coach has been asked to look at it." Then expect it under "Near-Misses" for that athlete. | |
| 045 | Coach-Controlled Constraint Engine | `/coach/sports-medicine` | Coach | Pick your own athlete, choose a scope, write the athlete's explanation, press "Place hold", then "Lift this hold". Expect the hold shown with its scope and explanation, then gone. | |
| 053 | False Progress Detection Engine | `/coach/transfer-check` | Coach | Pick an athlete. Expect each skill marked transferring, not transferring, untested live or insufficient evidence, with the raw counts. Nothing is saved. | |
| 075 | Safety Review Engine | `/admin/safety-review` | Org admin | Open it while a test hold is on. Expect the hold under "Active Training Holds", with failing gates, open escalations and open compliance violations below. Lift the hold on `/coach/sports-medicine` and expect it gone from this list. | |
| 076 | Pain / Symptom Flag Engine | `/athlete/dashboard`, "Pain/Soreness Report", then `/coach/environment/intake-router` | Athlete, then Coach | File a pain report. Expect it under "Athlete Pain Reports" in the coach's workspace, and no hold placed by itself. | |
| 082 | Stop / Hold / Regress Engine | `/coach/sports-medicine`, then `/athlete/dashboard` and `/schedule` | Coach, then Athlete | Place an "All training" hold on a test athlete. As that athlete, expect a hold banner on the dashboard and "Register" on `/schedule` refused with the hold's explanation. Only "All training" and "No contact" can be placed. | |
| 084 | Guardian Safety Report Engine | `/parent/safety` | Guardian | Open it as the parent of a test athlete who has a hold. Expect "Safety Status" for each linked child: the hold and gate standing in the words the child sees; no coach reason text; and a "Waivers" list (General, Medical release, Photo & media, Travel), each marked Signed, Declined, Withdrawn or Missing, or Unknown for a value the page does not recognise. Photo & media should match the "Photo & Video Consent" page: Signed only when that page says "Consent on file". Production's waiver rows are all of type `program_consent` (OD-2026-09-29-002 item 8a), which the route does not read, so expect Missing on all four unless the test athlete has waivers of these types. | |
| 090 | Family Communication Engine | `/coach/decision-loop`, "Message Home", then `/parent/dashboard` | Coach, then Guardian | Send a message home. Expect "Sent to the family." Then expect it on the guardian's dashboard. One-way: no replies. | |
| 095 | Home Barrier Reporting System | `/parent/dashboard`, "Report a Barrier", then `/coach/environment/intake-router` | Guardian, then Coach | Choose Home, describe it, press "Send to Coach". Expect it under "Family Barrier Reports" for that athlete's coach only. | |
| 096 | Transportation / Attendance Barrier Tracker | Same as 095 | Guardian, then Coach | As 095 with Type "Transportation". Expect it in the same list. | |
| 104 | Bodyweight Tracking | `/athlete/dashboard/sparring`, then `/coach/athlete-intelligence` | Athlete, then Coach | Enter "Your weight (kg, if you want)" on two logs about seven days apart. After the second, expect a seven-day weight change for that athlete on the coach page. | |
| 111 | Coach Intelligence Engine | `/coach/intelligence` | Coach | Open it. Expect "The Morning Read" (holds expiring within 14 days, 3+ RED readiness days this week, attendance fading, and more) about your own athletes only, with no scores. | |
| 113 | Coach Dashboard | `/coach/environment/intake-router` (where a coach lands after sign-in) | Coach | Open it. Expect the coach workspace: Readiness Alerts, Open Reviews, Athlete Roster, Athlete Pain Reports, Safety Escalations and Family Barrier Reports. | |
| 114 | Coach Cue Library | `/coach/cue-library` | Coach | Search for a cue. Expect cues from active drills, grouped by cue family, each naming its drill, with no edit controls. | |
| 116 | Coach Compliance / Integrity Engine | `/admin/compliance-center` | Org admin | Filter "Violations" by status; open one and Resolve or Escalate it. Expect the change saved. No screen files a new violation (API only), so the list may be empty. | |
| 121 | Group Assignment Engine | `/coach/floor-groups` | Coach | "Start plan" for today, add a group, place two athletes. Expect each athlete in one group only, and nothing carried to the next day. | |
| 123 | Station Rotation Engine | `/coach/floor-groups` | Coach | Add a group with a station name. Expect the day to read "Circuit day (stations set)"; with no station names it reads "Small-group day (no stations)". | |
| 124 | Capacity Management Engine | `/schedule` | Coach | Create a class with capacity 1 and register two athletes. Expect "Seats: 1/1" and the second registration's status "waitlisted". | |
| 125 | Behavior Standard Engine | `/coach/behavior-standards` | Org admin, then Coach | As org admin, post a standard. As coach, record that an athlete met it, then use "Raise a concern". Expect the recognition on the athlete's record and the concern in the escalation queue (`/admin/escalations`), with no conduct record kept on the athlete. | |
| 126 | Recognition / Achievement Engine | `/coach/recognition` | Coach | Mark a milestone for a test athlete. Expect "Marked. It is on their record and it stays there." and the athlete sees it on their dashboard. Cannot be undone. | |
| 127 | 1% Club / Leadership Pathway Tracker | `/coach/one-percent-club` | Coach (other coaches and admins vote) | "File nomination" for a test athlete, then vote. Expect it confirmed only once a strict majority of active coaches and admins vote yes. Votes cannot be changed; membership is permanent. | |
| 128 | Community Service Tracker | `/admin/community-service` | Coach or Org admin | Open it. Expect the page to load, probably empty: no screen or route records community-service entries. | |
| 129 | Program Phase Engine | `/admin/program-phases` | Org admin (coaches read only) | "Start phase" for a program, then start a second. Expect the first closed the day before the second began, both still listed. | |
| 131 | Confidence Score Engine | `/coach/athlete-intelligence` | Coach | After row 039, open that athlete. Expect each result line to show "Validation ... · confidence ...". | |
| 133 | Source Reliability Engine | `/research/chat` | Coach | Ask SHADOW a question. Expect each cited source to show "(tier N)". Setting a tier has no screen (API only). | |
| 134 | Duplicate Detection Engine | `/admin/data-quality` | Org admin | Open it. Expect "Duplicate Guardians": guardian records sharing an email, with the email masked and children hidden from a guardian listed first. Report only; there is no merge button. | |
| 135 | Uncertainty Tagging Engine | No screen | - | Nothing to try: no route or page uses it. | |
| 136 | Version / Source Status Engine | `/evidence` | Org admin | Open it. Expect each pending source to show its status beside its publisher and type. | |
| 139 | Approval Gate Engine | `/evidence` | Org admin | Press "Approve + verify" on a pending source you want in the library, or "Reject" on one you do not. Expect its status to change. | |
| 141 | Human Approval System | `/evidence` | Org admin | Same action as 139. Expect the pending list one shorter. | |
| 142 | Role Permission System | `/admin/people` | Org admin, then Coach | As org admin, expect the staff list. As coach, open `/admin/people` and expect to be sent back to the coach's own page. | |
| 144 | Change Log System | `/audit` | Org admin | After placing a test hold, open it. Expect recent events from the database, including that hold. | |
| 145 | File Status / Promotion System | `/coach/video-publications`, then `/admin/video-compliance` | Coach, then Org admin | Create a publication from a released video and submit it; as org admin, Approve it; as coach, publish it. Expect draft, then pending review, then published. | |
| 169 | Readiness Dashboard | `/coach/environment/intake-router` | Coach | Open it. Expect roster dots coloured only for athletes with a readiness score entered by staff in the last 24 hours; the rest stay unknown, never red or zero. Scores come from staff intake review, not an athlete check-in (`READINESS_PROVENANCE_FACTS.md`). | |
| 170 | Safety Dashboard | `/admin/safety-flags` | Coach or Org admin | Open it. Expect open flags worst first with severity counts, or an empty list; resolving one refuses an empty note. No screen raises a flag (API only), so the list may be empty. | |
| 171 | Progression Dashboard | `/coach/progression-intelligence` | Coach | Pick an athlete. Expect "Suggested Gaps", "Progression Gaps" and "Assigned Drills" with completions, for your own athletes only. | |
| 172 | Performance Trend Dashboard | `/coach/performance-analytics` | Coach | Open it. Expect "Who to see first" and per-athlete RPE, readiness and training-day rollups with a trend direction. | |
| 173 | Attendance Dashboard | `/admin/attendance` | Org admin or Coach | Open it. Expect an attendance summary and an 8-week trend strip; a coach sees their own athletes. | |
| 198 | Athlete Voice Module | "Tell Us" in the header, then `/admin/escalations` | Athlete, then Org admin, then Coach | As a test athlete, send a Tell Us message marked TEST that names a safety worry. Expect the usual reply; the org admin sees an "Athlete Voice" row on `/admin/escalations`; a coach does not. Close it afterwards. | |
