# Placeholder Map: role-surface stale copy vs. real backend

## Purpose

Backend domains (`infra/azure/*.sql`, `apps/web/app/api/pilot/**`) have matured
faster than the role-facing UI (`apps/web/app/**`, `apps/web/components/**`).
This document is a read-only audit joining the two: every user-visible
placeholder signal found in the role surfaces, checked against whether a real
table and a real route now exist to fill it.

## Method

**Half 1** — grepped `apps/web/app/**` and `apps/web/components/**` (excluding
`*.test.ts(x)`) for placeholder signals: "Coming soon", "Placeholder",
"Future Integration", "TBD", "Not yet", "Under construction", "Stay tuned",
"In development", "Sample"/"Example"/"Lorem"/"Demo"/"Mock", hardcoded fake
names/numbers rendered as real data, empty-state copy that promises a feature,
and disabled buttons with no handler.

**Half 2** — for each hit, checked `infra/azure/*.sql` for a backing table,
`apps/web/app/api/pilot/**` for a serving route (read only, not modified),
and `docs/capabilities/modules/NNN-*.md` for what shipped. Cross-checked
`docs/current/ACTIVE_WORK.md`'s PARKED/BLOCKED tables for deliberate holds.

## Classifications

- **DISHONEST** — the surface shows invented, sample, or hardcoded data as
  though it were real. Most serious category on a platform holding minors'
  records; listed first.
- **FILLABLE NOW** — a real table *and* a real API route both exist; the UI
  simply hasn't been wired to them. The valuable, actionable category.
- **BACKEND ONLY** — the table exists but no API route serves it yet.
  Backend work belongs to the primary session, not this audit — recorded only.
- **HONESTLY EMPTY** — the placeholder correctly reflects that nothing exists,
  or the feature is a deliberate owner-approved park. Not to be "fixed."

**Note on undeployed migrations**: the `training_attempts` and
`intervention_protocols`/`intervention_executions`/`intervention_evidence`
migrations are merged but **not yet deployed**. Surfaces built against them
(`/coach/attempt-log`, `/coach/intervention-executions`, `/coach/intervention-protocols`,
`/coach/intervention-review`, `/api/pilot/training-attempts`,
`/api/pilot/training-holds`, `/api/pilot/coach/intervention-*`) are already
fully wired in code — a 404 from them today is the honest, expected state of
an undeployed migration, not a UI gap, and none of those pages needed an entry
below.

Also worth noting up front: this codebase has already been through at least
one prior remediation pass that *deleted* dishonest fixtures rather than
merely labeling them (see code-comment history in `ParentHub.tsx`,
`AthleteWorkspace.tsx`, `CoachWorkspace.tsx`, `director/dashboard/page.tsx`,
`coach/review-queue/page.tsx`). That is why most remaining placeholders below
are honestly labeled "PLANNED | NOT YET IMPLEMENTED" rather than fabricated —
the one surviving live, persisted feature still wired to fake identities is
flagged loudly below.

---

## Findings by severity

### DISHONEST

| Role surface | File:line | Copy / data shown to user | Backing table | Backing route | Recommended action |
|---|---|---|---|---|---|
| Admin — "Who Trains On What" track assignment panel | `apps/web/components/trackAssignments.ts:21-25` (fixture) and `apps/web/app/admin/page.tsx:453, 775, 942, 947, 1566-1587` | The "Active athlete profile" dropdown offers exactly three fixed, fictional athletes — `athlete-001 "Athlete 001 - Youth Foundation"`, `athlete-002 "Athlete 002 - Competition Prep"`, `athlete-003 "Athlete 003 - Collegiate Candidate"` — as if they were the gym's real roster. The panel copy reads "Put an athlete on a track and it saves as you click," and the save **is real**: it round-trips through `GET`/`POST /api/pilot/admin/track-assignments` (confirmed at `admin/page.tsx:527-558`) into `pilot.admin_track_assignments`. So this is not an inert mock — an admin can click through a fully-persisting, audited-feeling workflow while it is structurally impossible to assign a track to any athlete who actually exists at the gym. Nothing in the panel discloses that the athlete list is fixture data. | `pilot.admin_track_assignments` (exists, `infra/azure/pilot_slice_postgres.sql:845`) | `/api/pilot/admin/track-assignments` (exists, admin-only) — the real roster is one call away at `/api/pilot/athletes/list` (exists) | Replace the `athleteProfiles` fixture import with a fetch to `/api/pilot/athletes/list` for the dropdown. This is a one-line data-source swap, not new backend work — the persistence path is already correct and already live. |

**Why this is the loud one**: everything else in the codebase that shows
"Placeholder" data labels itself as such (see `RevenueFundingCenter.tsx`
below — every fake row is prefixed literally with the word "Placeholder").
This panel does the opposite: real save semantics, undisclosed fake subjects.
On a platform that assigns training tracks (including contact/non-contact
distinctions with safety implications) to minors, a control that *looks* like
it is managing real athletes while actually being wired to none is the
highest-value fix in this report.

### FILLABLE NOW

| Role surface | File:line | Copy shown to user | Backing table | Backing route | Recommended action |
|---|---|---|---|---|---|
| Parent — Attendance tab | `apps/web/components/ParentHub.tsx:1032-1063` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for attendance history or upcoming sessions yet, so these lists are always empty." Both `attendanceEntries` and `upcomingSessions` render from hardcoded empty arrays (`ParentHub.tsx:192`, `368`). | `pilot.attendance`, `pilot.scheduler_classes`, `pilot.scheduler_attendance` (all exist) | `GET /api/pilot/scheduler` — **already implements a `parent` role branch** (`apps/web/app/api/pilot/scheduler/route.ts:106,124,146-224,245-272`) that filters `classes`/`registrations`/`attendance` down to the parent's linked athletes via `guardianAthleteIds`. It is not a stub for this role — it's live and used elsewhere (`parent_review_registration` action). | Call the existing parent-scoped `GET /api/pilot/scheduler` from `ParentHub.tsx` and drop the "not yet implemented" label. No new route needed. |
| Coach — "Today's Session" dashboard panel | `apps/web/components/CoachWorkspace.tsx:1677-1710` | "Planned — Not Yet Implemented"; "There is no scheduling backend feed yet -- session name, time, and status below are not real. Check your actual schedule directly." Fields render "Unavailable - not yet tracked". | `pilot.scheduler_classes`, `pilot.scheduler_registrations`, `pilot.scheduler_attendance` (all exist) | `/api/pilot/scheduler` (exists, coach-role supported; same route backs the fully-functional `/schedule` page in this same app) | The claim is stale — a real, live scheduler already exists and is used elsewhere in the app (`apps/web/app/schedule/page.tsx`). Wire this panel to the same `/api/pilot/scheduler` GET, scoped to today's date, instead of showing "not real." |
| Coach — Film Study tab, video upload | `apps/web/components/CoachWorkspace.tsx:2283-2303` | "Coming soon: Video upload, timestamp annotations, technical analysis tools." / "Video Upload: FRONT-END PLACEHOLDER \| Skill Recognition: BACKEND REQUIRED \| Technique Scoring: ML REQUIRED" | `pilot.video_sessions` (exists, via `pilot_slice_postgres_video_sessions_migration.sql`) | `/api/pilot/video/upload`, `/api/pilot/video/list`, `/api/pilot/video/[videoId]`, `/api/pilot/video/[videoId]/release`, `/api/pilot/video/review-link` (all exist and are fully wired into `apps/web/app/coach/video-analysis/page.tsx`, which this same panel links to via "Open Video Analysis Surface") | This tab's own "Coming soon" claim for video upload is inaccurate — the linked page one click away already does it. Correct the copy to only flag what's actually unbuilt (Skill Recognition/Technique Scoring — parked, see `BACKLOG-video-skill-scoring` below), not upload itself. |
| Athlete — Track Management tab | `apps/web/components/AthleteWorkspace.tsx:2080-2101` | "Current Track / Program Membership / Participation Status / Support Status / Community Service Credits: Unavailable - not yet tracked." Code comment claims "`pilot.admin_track_assignments`... does not exist in staging or prod." | `pilot.admin_track_assignments` (exists — same table as the DISHONEST finding above) | `/api/pilot/admin/track-assignments` (exists, currently `admin`/`organization_admin`/`platform_owner`-only) | The table claim in the code comment is out of date — the table and an admin route both exist now. Filling this tab for the athlete's own view needs either a self-scoped read added to the existing route, or a new thin `athlete`-role read of the same table (small, not a new domain) — flagged here as FILLABLE because the exact backing table and a route reading it already exist; the remaining gap is a role check, not new infrastructure. |
| Admin — Revenue & Funding Center, Grants tab | `apps/web/components/RevenueFundingCenter.tsx:354-357, 776-788` | Renders `grantRows`: `['Grant Placeholder', 'Funder Placeholder', 'Youth Development', '$0.00', 'Drafting', 'Due Date Placeholder', 'Restricted Purpose Placeholder', 'Reporting Required Placeholder', ...]` under "Grant Pipeline Tracking." | `pilot.grant_obligations` (exists, shipped in the 2026-08-15 release per `ACTIVE_WORK.md`) | `/api/pilot/admin/grant-obligations` (exists, admin-only) — and there is already a **fully wired real page** at `apps/web/app/admin/grants/page.tsx` reading this exact route | The real grants ledger already shipped elsewhere in the app. This tab is a stale duplicate showing fake rows instead of either linking to `/admin/grants` or pulling the same route. Replace the hardcoded `grantRows` with a link/embed of the real ledger. |
| Admin — Revenue & Funding Center, Products/Equipment tab | `apps/web/components/RevenueFundingCenter.tsx:362-366, 810-820` | Renders `productRows`: `['Product Placeholder', 'Gloves', '$0.00', '$0.00', 'Inventory Placeholder', 'Needs Pricing', ...]` under "Products / Equipment Placeholder Catalog." | `pilot.gear_products`, `pilot.gear_vendors` (both exist) | `/api/pilot/admin/gear/route.ts`, `/api/pilot/admin/gear-vendors/route.ts` (exist) — and real pages already exist at `apps/web/app/admin/gear/page.tsx` and `apps/web/app/admin/gear/vendors/page.tsx` | Same pattern as Grants: the real gear catalog already shipped. Point this tab at the real gear/vendor routes (or just link to `/admin/gear`) instead of showing fake inventory rows. |

### BACKEND ONLY

| Role surface | File:line | Copy shown to user | Backing table | Route that would be needed | Recommended action |
|---|---|---|---|---|---|
| Coach — physical/skill test scheduling (no single dedicated UI surface found; relevant to module 027 Testing/Retest engine) | n/a (no placeholder copy currently references this table by name; flagged from the backend side per the audit's evidence list) | — | `pilot.assessment_protocols`, `pilot.data_collection_requests` (exist, `infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql`) | No route currently reads or writes `pilot.assessment_protocols` or `pilot.data_collection_requests` anywhere under `apps/web/app/api/pilot/**` (confirmed by full-repo grep). Would need e.g. `GET/POST /api/pilot/coach/assessment-protocols` and a due-for-retest queue endpoint. | Record only — backend work for the primary session. Do not build the route from this audit. |
| Coach/athlete — sparring load exposure (module 043/081, referenced in the audit's evidence list) | n/a (no user-facing placeholder copy found naming this domain directly) | — | `pilot.sparring_exposure`, `pilot.session_load` (exist, `infra/azure/pilot_slice_postgres_sparring_exposure_and_load_migration.sql`) | Data currently flows only into the internal SHADOW formula engine (`apps/web/src/server/pilot/sparringExposure.ts`, `formulas/engine.ts`) — there is no direct read route for a coach-facing "sparring load" view. Would need e.g. `GET /api/pilot/coach/sparring-load`. | Record only — no placeholder currently promises this to a user, so nothing to fix in the UI; flagged so the next redesign pass knows the raw data already exists if a load-management view is ever built. |

### HONESTLY EMPTY

| Role surface | File:line | Copy shown to user | Why it is honest |
|---|---|---|---|
| Parent — Home Assignments tab | `ParentHub.tsx:832-872` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for home assignments yet, so this list is always empty." `homeAssignments` renders from an empty array. | No `pilot.*` table for home/movement homework assignments exists anywhere in `infra/azure/*.sql`. Correctly empty. |
| Parent — Observations tab | `ParentHub.tsx:874-918` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed or entry form for parent observations yet." | No guardian-observation table exists. Correctly empty. |
| Parent — Family Goals tab | `ParentHub.tsx:920-965` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for family goals yet." | No family-goal table exists (distinct from `pilot.goals`, which is athlete-scoped and already used elsewhere). Correctly empty. |
| Parent — Reply to Coach (messages tab) | `ParentHub.tsx:1003-1027` | "Messages... appear above, but replying isn't available yet. This field is disabled so a message can't be typed and silently discarded." Textarea and Send button both `disabled`. | Code comment on the read route (`apps/web/app/api/pilot/parent/messages/route.ts:10-17`) documents this as a **deliberate one-directional-messaging product decision** (module 90), not an unbuilt gap — reply/threading is explicitly out of scope pending a real moderation decision. |
| Parent — Progress Milestones | `ParentHub.tsx:1066-1130` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for progress milestones yet." | `pilot.athlete_milestones` exists but the milestone *concept* rendered here (family-facing "progress milestone" cards with % complete) has no route; array is empty, not fabricated. Genuinely unbuilt, correctly labeled. |
| Parent — Support Resources tab | `ParentHub.tsx:1132-1150` | "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for parent resources yet." | No parent-resource-library table exists. Correctly empty. |
| Athlete — Assessments tab (MBTI/personality test) | `AthleteWorkspace.tsx:2104-2128` | "NOT BUILT YET -- there is nothing behind this tab, so nothing here can start or score anything." "Start Assessment" button `disabled`. | No personality/psych-assessment domain exists (distinct from `pilot.assessment_protocols`, which is physical/skill-test scheduling, not personality surveys). Correctly empty and correctly disabled. |
| Athlete — Expanded Bio Check-In (HRV, resting HR, blood pressure) | `AthleteWorkspace.tsx:2182-2193` | "None of this is built yet. Here is what is coming: Resting Heart Rate, HRV, Blood Pressure..." | Covered by `BACKLOG-wearables` — see Explicitly Not Recommended below. |
| Athlete/Coach — AI Video Skill Recognition & Technique Scoring | `apps/web/app/athlete/video-analysis/page.tsx:10,22,185`; `apps/web/app/coach/video-analysis/page.tsx:10,58-62`; `CoachWorkspace.tsx:2292` | `ML_PLACEHOLDER = 'PLANNED \| ML REQUIRED \| NOT YET AUTOMATED'` shown against Skill Recognition, Punch Detection, Footwork Analysis, Technique Scoring, Movement Analysis. | Covered by `BACKLOG-video-skill-scoring` — see below. (Upload/storage itself is *not* parked — see FILLABLE NOW above; only the ML scoring is.) |
| Admin — Revenue & Funding Center, Payment Settings / Integrations tab | `RevenueFundingCenter.tsx:93-190, 827-873` | `paymentIntegrations` list: "Stripe Placeholder / Square Placeholder / PayPal Placeholder / Donorbox / Givebutter Placeholder / **QuickBooks Placeholder** / Microsoft / Power Platform Placeholder" — status "Not Connected", notes "Future Integration \| Requires Backend \| Requires Compliance Review." | Covered by the payments `BLOCKED` item and `BACKLOG-quickbooks-sync` — see below. Every fake row here is explicitly labeled "Placeholder" in its own name field, so this is disclosed roadmap content, not fabricated real data — hence Honestly Empty rather than Dishonest. |
| Admin — Revenue & Funding Center, Memberships/Donations/Sponsors/B2B/Wholesale/Scholarships tabs (remaining, non-Grants/Products rows) | `RevenueFundingCenter.tsx:338-373` | Rows like `['Member Name Placeholder', 'Family / Guardian Placeholder', ...]`, `['Sponsor Name Placeholder', ...]` etc. | Same as above — payments/monetary intake is `BLOCKED`/parked pending Stripe platform account registration; every value is self-labeled "Placeholder." Not a fill target until CAP-012 flips. |
| Board — Governance/Strategy/Meetings/Tasks/Policies/Resolutions/Committees/Compliance/Documents tabs (dozens of cards) | `apps/web/app/board/boardWorkspaceConfig.ts:166-230+` (e.g. "Mission Alignment," "Bylaws," "Resolution register," "Meeting Calendar," "Agenda Packets," ...) | Each card is tagged `status: 'planned'` and rendered with `BOARD_PLANNED_STAMP = 'PLANNED \| FRONT-END PLACEHOLDER \| BACKEND REQUIRED'` per the file's own header comment ("Two cards are backed by a route a board session can actually call... Everything else is a description of intended work and says so.") | No bylaws/resolution/governance-calendar/meeting/task table exists anywhere in `infra/azure/*.sql`. Correctly and consistently labeled `planned`; only `Organization Aggregate` and `Hand-Filed Compliance Register` are marked `built` and are backed by real routes (`/api/pilot/board/summary`, `/api/pilot/board/compliance-summary`). |
| Coach — Coach Assessments tab (leadership/communication/teaching-impact evaluation) | `CoachWorkspace.tsx:2273-2281` | "Planned — Not Yet Implemented." "Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation." | No coach-effectiveness/leadership-assessment table exists in `infra/azure/*.sql`. Genuinely unbuilt (module 073/112 backend not shipped), correctly labeled. |
| Coach/Admin — Publication Workflow Automation | `apps/web/app/source-control/page.tsx:5,61-62`; `apps/web/app/source-control/publication-workflow/page.tsx:9,20-21`; `apps/web/app/operations/page.tsx:109` | `capabilityStatus = 'PLANNED \| FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED'`; "Approved Build Input Placeholder," "Publish to Ecosystem Placeholder" | Covered by `BACKLOG-publication-automation` — see below. |

---

## By role surface

| Role | Dishonest | Fillable now | Backend only | Honestly empty |
|---|---:|---:|---:|---:|
| Athlete | 0 | 1 (track management) | 0 | 3 (assessments tab, expanded bio check-in/wearables, video ML scoring) |
| Parent / Family | 0 | 1 (attendance tab) | 0 | 6 (home assignments, observations, family goals, reply-to-coach, progress milestones, resources) |
| Coach | 0 | 2 (today's session panel, film study video upload) | 2 (assessment protocols, sparring load — no dedicated UI yet, recorded for awareness) | 2 (coach assessments/leadership eval, video ML scoring — shared with athlete) |
| Admin | 1 (track-assignment fixture athletes — the DISHONEST finding) | 2 (grants tab, products/equipment tab, both inside Revenue & Funding Center) | 0 | 2 (payment integrations tab + remaining Revenue Center tabs, publication workflow automation) |
| Board | 0 | 0 | 0 | 1 rollup covering dozens of `planned` governance/strategy/meetings/tasks cards |
| Staff | 0 | 0 | 0 | 0 (no staff-specific placeholder copy found distinct from admin surfaces above) |

**Totals**: 27 individual findings recorded across the tables above (1 Dishonest,
7 Fillable Now, 2 Backend Only, 17 Honestly Empty — several of the Honestly
Empty rows are themselves rollups of many identically-patterned "planned"
cards, e.g. the Board table and the Revenue & Funding Center's non-Grants/
Products tabs, so the true count of individual placeholder *strings* in the
repo is in the low hundreds; grouping was necessary to keep this document
usable).

---

## Explicitly not recommended

These surfaces are deliberately parked or blocked per
`docs/current/ACTIVE_WORK.md`. Do not "fix" them without a new owner decision.

| Surface | ACTIVE_WORK.md item that parks it |
|---|---|
| Revenue & Funding Center — all payment integration rows (Stripe/Square/PayPal/Donorbox/Microsoft Placeholder), memberships/donations/sponsors/B2B/wholesale/scholarship fake rows | `BLOCKED`: "Stripe onboarding round-trip test + checkout slice (item 8, remaining half)" — blocked on the owner registering PPBF's Stripe platform account and Connect OAuth client; CAP-012 stays blocked until compliance sign-off. |
| Revenue & Funding Center — "QuickBooks Placeholder" row specifically | `PARKED`: `BACKLOG-quickbooks-sync` — stays parked until the payment lanes are live and real transactions exist in `pilot.payment_transactions`. |
| Athlete Bio Check-In — HRV, resting heart rate, blood pressure fields | `PARKED`: `BACKLOG-wearables` — owner's 2026-08-16 "add all" decision deliberately excluded wearables/HR streams pending a consent/privacy/device-ownership decision. |
| Athlete/Coach Video Analysis — Skill Recognition, Punch Detection, Footwork Analysis, Technique Scoring, Movement Analysis (`ML_PLACEHOLDER`) | `PARKED`: `BACKLOG-video-skill-scoring` — per-skill AI video scoring parked for Phase 2+; Human Film Study is the analysis pathway until an accuracy-proven scoring approach is selected. |
| Source Control / Publication Workflow — "Publish to Ecosystem Placeholder," automation stamps | `PARKED`: `BACKLOG-publication-automation` — the internal publication machinery is human-gated on purpose; automating outward disclosure has no defined destination/content set yet. |
| (Not found as a distinct UI placeholder in this pass, but relevant if one appears later) grant packet export / offline write queue / activity-log backfill | `PARKED`: `BACKLOG-grant-packet`, `BACKLOG-offline-write-queue`, `BACKLOG-activity-log-backfill` — listed here so a future reader does not build UI against them without the disclosure/identity/provenance decisions those items require first. |
