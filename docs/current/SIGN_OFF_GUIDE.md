# Owner Sign-Off Walkthrough Guide

This guide is for manually verifying the 82 modules in
`docs/capabilities/expanded-200-backlog.csv` that are marked `Status: DONE`
but `ManualVerification: PENDING_SIGN_OFF`. "DONE" in the tracker means a
slice of code was written and passed automated tests — it does **not** mean
a human has confirmed it works in the running app. That confirmation is
what this guide walks you through, module by module: the page to open, what
to click, and what you should see if it's genuinely working.

Every route named below was checked against the actual files under
`apps/web/app/**` before being included. Where a module has **no reachable
route**, that line says so plainly and explains why — a missing UI is a
real finding, not a gap in this guide, and it means the module needs an
**owner decision** (build the missing screen, or leave it API-only and
correct the tracker) rather than a click. Several modules share one real
page because that is literally how they were built — the entry says so
where it applies.

**One honesty note before you start:** the training-attempts API
(`/api/pilot/training-attempts`) and the intervention-tracking API
(module 26, three routes below) have merged database migrations that are
**not yet deployed** to staging or production. If those surfaces show an
empty state, an error, or a 404 today, that is the **correct, passing**
result — it is not a bug to report. They'll be re-checked once the
migrations actually run.

---

## Core Athlete System

**1. Athlete Profile System** — Route: `/coach/passbook-gaps` (partial).
`/api/pilot/passbook/gaps` now has a page: open it as a coach and you should
see every open gap on your own athletes' books, worst attendance first, each
row carrying the day that athlete was last in the gym and how many recorded
absent days have gone by since. An organization admin sees the whole
organization. If you have no open gaps the honest empty state is the correct,
passing result. `/api/pilot/passbook` — one athlete's whole book — is still
API-only with no page; that half remains an owner decision.

**2. Raw Observation Intake System** — Route: `/coach/decision-loop`.
Select an athlete, type a note into the "Behavior Note" box, and submit.
You should see a "Note logged." confirmation. There's no readback list on
this screen — it's a one-way write, so you can't currently see the note
again without a database check.

**4. Performance Tracking System** — Route: `/coach/performance-analytics`.
Open the page and pick an athlete. You should see RPE, readiness, and
training-day rollups computed from stored session records.

**5. Progression Decision System** — Route: `/coach/progression-intelligence`.
Pick an athlete and click "Confirm" on a suggested gap, or use "+ Add Gap."
You should see the gap move into that athlete's confirmed list.

**6. Training Assignment System** — Route: `/coach/progression-intelligence`.
On a confirmed gap, click "Assign Drill" and fill in a drill name and
frequency. You should see the new assignment listed under that athlete
with status "assigned."

**7. Session Builder** — No route found. No page lets a coach author a new
draft session plan: `/coach/session-scripts` only *delivers* scripts that
already exist, and the only thing that creates a new session record is the
athlete's own check-in on `/athlete/dashboard` — a different feature. This
needs an owner decision, not a click.

**9. Athlete Update System** — Route: `/athlete/dashboard`. Click "Check
In," enter readiness and a note, and submit. You should see the check-in
saved as a session record, reflected if you reopen the dashboard.

**10. Development Route System** — Route: `/coach/progression-intelligence`.
The same "Assign Drill" action used for module 6 is the routing decision
here. You should see the athlete's development path update with the new
assignment.

**12. Roster / Participation System** — Route: `/admin/athletes`. Open the
roster and use the gym-status field/filter on an athlete record. You
should see the roster reflect the selected status (active/inactive/etc.).

---

## Physical Training System

**13. Physical Capacity Engine** — No route found. No field, tag, or API
anywhere stores a "physical capacity note" — checked directly against the
athlete and session data models. Nothing exists to click.

**14. Load Management Engine** — No route found. No weekly-session-count
cap or warning exists anywhere in the code.

**19. Recovery Engine** — Route: `/athlete/dashboard/sparring` (the
Deep-Track sparring log). Log a session and fill in "Recovery notes." You
should see a free-text notes field save successfully — this is thinner
than the register's "recovery status tag": it's a note, not a structured
status.

**20. Physical Readiness Engine** — Route: `/coach/performance-analytics`,
or the readiness feed inside the Coach Workspace at
`/coach/environment/intake-router`. You should see a readiness summary
(RPE/session-count based) per athlete, shown as colored bands on the
Workspace roster.

**26. Intervention Tracking Engine** — Routes: `/coach/intervention-protocols`,
`/coach/intervention-executions`, `/coach/intervention-review`. Create a
protocol, log an execution against it, then file an outcome review. **See
the migration note at the top of this guide: these routes' database
migrations are not yet deployed, so an absent or empty result today is the
honest, passing outcome, not a bug.**

**22. Injury-Risk Engine** — No route found. No coach-settable injury-risk
flag exists anywhere in the code.

**27. Testing / Retest Engine** — No route found. Only a server-side helper
module and a migration script exist; there is no API route and no page.

**28. Deload / Taper Engine** — No route found. No deload/taper flag exists
anywhere — the word only appears in an unrelated SHADOW chat keyword list.

**34. Return-to-Training Engine** — No route found. The
`pilot.return_to_training_plans`/`steps` tables and server logic exist,
but no API route or page exposes them — reachable only with direct
database access today.

---

## Combat / Boxing System

**37. Combat Athlete Engine** — No route found. No "sparring allowed"
field exists anywhere in the code despite the tracker's DONE mark.

**39. Punch Quality / Volume Engine** — Route: `/athlete/dashboard/sparring`.
Log punch type, attempted, landed, and absorbed counts, then submit. You
should see a save confirmation only — the computed accuracy/output/
efficiency numbers are calculated and tested, but no screen displays them
yet.

**42. Round Performance Engine** — Route: `/athlete/dashboard/sparring`
(same form, rounds-completed field). Same as above: logging works, but
the computed round-consistency numbers have no display screen.

**43. Contact / Sparring Restriction Engine** — Route:
`/athlete/dashboard/sparring`. Log a contact round for an athlete with no
current medical clearance on file. You should see the submission still
succeed, plus a "safety review raised" message naming what clearance is
missing — that message appearing is the passing result.

**45. Coach-Controlled Constraint Engine** — Route: `/coach/sports-medicine`
or `/coach/progression-intelligence` (read-only). Select an athlete. You
should see an active-hold badge if one exists. There is no button anywhere
to place or lift a hold — that action is API-only in this version, so this
route only lets you verify the *read* side.

---

## Learning / Skill Acquisition

**54. Skill Acquisition Engine** — Route: `/coach/progression-intelligence`.
Add a gap with type "skill," or assign a drill with a category. You should
see that tag save — a thinner match than the register's "skill tag
system": it's the existing gap-type/drill-category fields, not a dedicated
tagging feature.

**55. Retention Tracking Engine** — Route: `/coach/progression-intelligence`.
View a logged assignment completion. You should see a `completed_at`
timestamp — the closest real equivalent to a "last practiced" date; there
is no dedicated retention view.

**56. Mastery Verification Engine** — Route: `/coach/progression-intelligence`.
On a logged completion, click "Verify." You should see its status move
between pending/verified/disputed — a thin but real match for the
described learning → practiced → verified progression.

---

## Mental / Emotional / Behavioral

**64. Emotional Regulation Engine** — No route found. No emotion/regulation
note field exists anywhere in the code.

**65. Resilience Engine** — No route found. No 1–5 resilience check-in
exists anywhere in the code.

**70. Discipline / Accountability Engine** — No route found. No
accountability-item complete flag exists anywhere in the code.

---

## Safety / Recovery / Health

**82. Stop / Hold / Regress Engine** — Routes: `/athlete/dashboard` (the
training-hold banner) and `/admin/escalations` (hold-related escalations).
Open either as the matching role. You should see a non-punitive hold
banner on the athlete side if a hold is active, and a hold escalation
entry on the admin side. Note: placing or lifting a hold has no button
anywhere in the app — API-only in v1, so this only verifies the read side.

---

## At-Home / Parent / Guardian

**85. At-Home Parent / Guardian Task System** — Route: `/parent/dashboard`
loads, but the page itself states in plain text that the parent-task feed
"is not wired to the backend." Seeing that honest disclaimer — not a
working task checklist — is the correct, passing result today.

**90. Family Communication Engine** — Route: `/coach/decision-loop`
("Message Home" box) to send; the parent reads it back on
`/parent/dashboard`. Send a message as a coach. You should see "Sent to
the family," then confirm it appears in the parent's message feed.

**93. Parent / Guardian Dashboard** — Route: `/parent/dashboard`. Open as a
parent account. You should see only your own linked child/children listed,
nothing about anyone else's.

**95. Home Barrier Reporting System** — Route: `/parent/dashboard` (barrier
report form) to file; `/coach/environment/intake-router` (Coach Workspace
barrier inbox) to read. File a home barrier report as a parent. You should
see it appear in the coach's barrier inbox, scoped to that one athlete.

**96. Transportation / Attendance Barrier Tracker** — Same route and flow
as module 95 — the same form and inbox, with "transportation" selected as
the barrier type instead of "home."

---

## Body Composition

**104. Bodyweight Tracking** — Route: `/athlete/dashboard/sparring`. Enter
a body-weight value on a sparring log entry. You should see a save
confirmation — the 7-day weight-change calculation is computed and tested,
but has no display screen anywhere yet.

---

## Coach System

**111. Coach Intelligence Engine** — Route: `/coach/intelligence`. Open as
a coach. You should see "The Morning Read": five sections (stalled gaps,
readiness concerns, fading attendance, unreviewed sessions, expiring
holds) about your own roster only.

**113. Coach Dashboard** — Route: `/coach/environment/intake-router` (the
Coach Workspace). Open as a coach. You should see floor plans, open coach
reviews, tasks/goals, pain/barrier reports, and escalations for your
athletes.

**114. Coach Cue Library** — Route: `/coach/cue-library`. Search or filter
by focus type. You should see a read-only list of cues pulled from
existing drill records, grouped by cue family — or an honest empty state
if no cues exist yet.

**116. Coach Compliance / Integrity Engine** — Route:
`/admin/compliance-center`. Filter violations by status. You should see
compliance violations listed with severity and an escalation path.

**118. Coach Review Queue** — Route: `/coach/environment/intake-router`
(the Coach Workspace's review picker). Pick an athlete, pick one of their
sessions, and submit a review. You should see it save. Note: the separate,
dedicated `/coach/review-queue` page is a deliberate placeholder — the
owner ruled out its old mock UI on 2026-08-14 — so don't expect a queue
there.

**119. Coach Decision Audit** — Route: same Coach Workspace review picker
(`/coach/environment/intake-router`). Pick an athlete and session. You
should see the list of past reviews already submitted for that session —
that history list is the decision-audit trail; there is no separate audit
page for this module.

---

## Class / Program Management

**120. Class Control Engine** — Route: `/schedule`. Create a class (title,
location, capacity). You should see it appear on the schedule with its
stated capacity.

**122. Attendance Engine** — Route: `/admin/attendance`. Open the page. You
should see present/absent marks rolling up per athlete; an athlete never
marked renders as "Unavailable," never a fabricated 0%.

**124. Capacity Management Engine** — Route: `/schedule`. Register more
athletes into a class than its capacity allows. You should see the extra
registration go to "waitlisted" once the seat cap is hit — a narrow
per-class cap, not a broader capacity console.

**126. Recognition / Achievement Engine** — Route: `/coach/recognition`.
Award a milestone to an athlete. You should see it recorded and visible to
roles allowed to read it — with no ranking or comparison between
athletes, by design.

---

## Data Quality / Trust

**130. Evidence Quality Engine** — Route: `/research/chat`. Ask the
Library a question. You should see the answer graded "Backed by approved
Library evidence," "Limited Library evidence," or "No approved evidence
found" — that grade is the evidence-quality signal.

**131. Confidence Score Engine** — No route found. A HIGH/MODERATE/LOW/
INSUFFICIENT confidence tag is computed server-side on formula results,
but no page anywhere displays it.

**132. Missing Data Engine** — Route: `/admin/athletes` (the create-athlete
form). Submit the form with a required field left blank. You should see a
validation error naming the missing field, not a silent failure or a
fabricated save.

**133. Source Reliability Engine** — Route: `/research/chat` (read side
only). Ask a question. You should see each cited source display an
authority tier, e.g. "(tier 2)." Note: setting or changing a source's tier
is curator-only and API-only — no page has a control for it.

**134. Duplicate Detection Engine** — Route: `/admin/data-quality`. Open
the page as an admin. You should see guardian records sharing an email
flagged as possible duplicates, with the email masked — report-only;
merging remains a human decision made elsewhere.

**135. Uncertainty Tagging Engine** — No route found. The tagging
mechanism exists server-side (feeding a research-pattern promotion gate),
but no page anywhere shows it.

**136. Version / Source Status Engine** — Routes: `/evidence` and
`/research`. Open either as the matching role. You should see source/
document status values (pending_review/approved/rejected, active/archived/
quarantined) on each row.

**137. Audit Trail / Decision History** — Route: `/audit`. Open the page
and pick an entity. You should see its recorded audit-event history in
order, append-only.

**139. Approval Gate Engine** — Route: `/evidence`. Click "Approve +
verify" or "Reject" on a pending source/document. You should see its
status change and, once approved, become retrievable to the SHADOW
library.

---

## Governance / Admin / Nonprofit

**141. Human Approval System** — Route: `/evidence`. Same approve/reject
buttons as module 139. You should see the pending-review queue shrink by
one and the item's new status recorded.

**142. Role Permission System** — Route: `/admin/people`. Invite a new
person and assign them a role (e.g. coach). You should see that role
subsequently govern what they can reach — this page is the visible edge
of the `requireRole()`/`isOrganizationAdminRole()` checks used almost
everywhere else in the app.

**144. Change Log System** — Route: `/audit`. Open the page. You should see
a live list of audit events pulled from the database, not a mock.

**145. File Status / Promotion System** — Route: `/coach/video-publications`.
Create a publication, click "Submit for review," then (once approved)
"Publish." You should see the publication's status move draft →
pending_review → published.

**146. Grant / Nonprofit Impact Engine** — Route: `/admin/grants`. Open the
page as an admin. You should see grant obligations tracked against the
organization.

**147. Board Reporting Engine** — Route: `/board`. Open as a board member.
You should see one aggregated summary panel built entirely from existing
summary APIs (athletes, sessions, reviews, goals) — there is no separate
"board report" beyond this panel.

**148. Program Outcome Reporting** — Route: `/board` (same summary panel).
You should see tiles like "Training Sessions (30 Days)" and "Goals
Active/Completed/Other" — counts only, no per-athlete detail.

**149. Donor-Safe Reporting Engine** — Route: `/board` (same summary
panel). Read the tile text. You should see only counts and category
names, never an individual athlete's name — that absence is the entire
meaning of "donor-safe" here; there is no separate donor report to click
into.

**150. Privacy / Sensitive Data Boundary Engine** — No ordinary click
confirms this one. It sits on 1–2 existing write paths (e.g. the athlete
update form, or the coach behavior-note box on `/coach/decision-loop`).
Verifying it means deliberately submitting an oversized note or a
disallowed field on one of those forms and confirming you get a clear
rejection rather than a silent save.

**151. Consent / Waiver Tracker** — Route: `/admin/consent`. Record that a
guardian signed (who, capacity, date, version). You should see the record
listed and readable afterward — it does not gate anything else in the app
by design.

**152. Incident Report Engine** — Route: `/coach/decision-loop` ("Report
Incident" panel). File an incident with a severity and description. You
should see "Incident filed — it is now in the escalation queue," then
confirm it on `/admin/escalations`.

**153. Compliance Checklist Engine** — Route: `/board/compliance-monitoring`.
Open as a board member. You should see compliance-rule counts broken down
by severity and status (new/acknowledged/escalated/resolved/dismissed).

**201. Gear Vendor Records** — Route: `/admin/gear/vendors` (linked from
`/admin/gear`). Add a supplier (account number, terms, rep contact). You
should see the vendor saved and selectable on the gear catalog, while the
public store at `/store/[organizationId]` shows only the brand — never the
vendor account.

---

## AI / Automation Support

**154. AI Assistant Layer** — Route: `/shadow` (or any SHADOW chat entry
point across the app, e.g. the chat button in the header). Ask SHADOW a
question requiring a judgment call. You should see it return draft text or
a suggestion, never an auto-applied decision.

**164. No-Autonomous-Approval Guardrail** — Route: `/shadow` and `/evidence`.
Look for anywhere SHADOW could approve something on its own. You should
see every approval action require a human clicking a button — SHADOW's
own output is never wired to write an approval by itself.

---

## Dashboards / Reporting

**165. Athlete Dashboard** — Route: `/athlete/dashboard`. Sign in as an
athlete. You should see only your own session/goal counts, nothing about
other athletes.

**166. Coach Dashboard** — Route: `/coach/environment/intake-router` (same
page as module 113). You should see open reviews and your assigned
athlete count.

**167. Parent / Guardian Dashboard** — Route: `/parent/dashboard` (same as
module 93). Do not use `/guardian/dashboard` — it is a deliberate redirect
stub that points back to this same Parent Hub. You should see your linked
athletes and their open items only.

**168. Admin Dashboard** — Route: `/admin`. Open as an org admin. You
should see roster counts and open compliance counts on the hub's KPI row.

**169. Readiness Dashboard** — Route: `/coach/environment/intake-router`
(the Coach Workspace roster dots and "Readiness Alerts" tile). Open as a
coach. You should see green/yellow/red readiness bands from each athlete's
latest check-in within the last 24 hours; an athlete with no fresh reading
is omitted, never shown as a fabricated zero.

**170. Safety Dashboard** — Route: `/admin/safety-flags`. Open as
admin/coach and resolve a flag. You should see open flags listed
worst-severity-first, and resolving one requires you to enter a note.

**171. Progression Dashboard** — Route: `/coach/progression-intelligence`.
Open as a coach. You should see deterministic gap suggestions alongside
confirmed gaps and assignment-completion status.

**172. Performance Trend Dashboard** — Route: `/coach/performance-analytics`.
Open as a coach and pick a window. You should see RPE/readiness/
training-day rollups with an early-vs-late trend direction per athlete.

**173. Attendance Dashboard** — Route: `/admin/attendance`. Open as admin.
You should see an org-wide and coach-scoped attendance summary plus an
8-week trend strip.

---

## Strongest Additions Now

**194. Red Flag Escalation Protocol** — Route: `/admin/escalations`. Open
as admin/coach. You should see near-miss, pain-report, and safety-gate
escalations listed — this platform sends no notification of any kind, so
this page is the only place any of them surface.

**198. Athlete Voice Module** — Route: the feedback box in the global
header (reachable from any page, e.g. `/athlete/dashboard`), feeding
`/admin/escalations`. Submit feedback as an athlete using concerning
language. You should see it escalate automatically and appear on
`/admin/escalations` for staff to review.

**200. Privacy-Tier System** — No route found, by design. This is a
code-only registry (`privacyTiers.ts`) naming rules that are enforced
elsewhere in the codebase; it deliberately has no UI, table, or API of its
own, so there is nothing to click by design, not by omission.

---

## Summary

- **Modules documented:** 82 of 82 `PENDING_SIGN_OFF` rows in
  `docs/capabilities/expanded-200-backlog.csv`.
- **No reachable route:** 22 modules — 1, 7, 13, 14, 22, 27, 28, 34, 37,
  64, 65, 70, 85, 131, 135, 200 have no UI at all to click; 82 and 45 have
  a route for the *read* side only (placing/lifting a hold is API-only);
  150 sits on existing forms but needs a deliberately invalid submission,
  not an ordinary click; 133's write side is curator/API-only even though
  its read side is visible. Each of these needs an owner decision (build
  the missing screen, or formally accept API-only and correct the
  tracker) rather than a sign-off click.
- **Hardest three to verify:** (1) **Module 26, Intervention Tracking
  Engine** — three real pages, but gated behind migrations that are not
  yet deployed, so today's honest result (empty/absent) looks identical
  to a broken one unless you already know to expect it. (2) **Modules 39/42/104
  (Punch Quality, Round Performance, Bodyweight Tracking)** — all three
  let you log real data on the same sparring form, but none of the three
  computed results have anywhere to display, so "working" can only be
  confirmed by someone willing to check the database, not by looking at a
  screen. (3) **Module 150, Privacy/Sensitive Data Boundary Engine** — the
  only way to see it do anything is to deliberately try to break an
  existing form (an oversized note or a disallowed field) and check that
  the rejection is clean, which is a very different exercise from
  everything else in this guide.
