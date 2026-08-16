# Placeholder Map

Inventory of role surfaces that still show stale "coming soon" / "not built yet" /
"planned" copy even though a real backend domain (tables in `infra/azure/*.sql`
plus a working route under `apps/web/app/api/pilot/**`) already exists behind
them.

Scope note: this document only lists cases where **both** halves are true --
the UI is stale **and** the backend is real. Surfaces that honestly say
"Unavailable - not yet tracked" / "No backend feed for X yet" / "PLANNED |
FRONT-END PLACEHOLDER | BACKEND REQUIRED" **and where that claim checks out**
(no matching table, no matching route) are correct behavior and are not
listed as findings -- they are named in the "Rejected as honest" note under
each section instead, so the negative check is visible.

Method: grepped `apps/web/components/**/*.tsx` and `apps/web/app/**/page.tsx`
for placeholder signals, then checked each hit against `infra/azure/*.sql` and
`apps/web/app/api/pilot/**` for a real table + working route. Verified
against the current file contents (not memory of past audits) in every case
below.

---

## Athlete

| Surface | File:line | What it shows now | What already exists behind it | Fix size |
|---|---|---|---|---|
| Athlete Workspace -> Schedule tab | `apps/web/components/AthleteWorkspace.tsx:2542,2556` | "Booking happens in the unified scheduler; this tab is a placeholder until it can read the gym's classes" / "NOT BUILT YET -- this tab cannot see the gym's classes or sign you up for one." | `pilot.scheduler_*` tables (`pilot_slice_postgres_scheduler_tables_migration.sql`) and a real, working `apps/web/app/api/pilot/scheduler/**` route set (class list, registration, attendance-summary). This is the known reference example carried over from the ticket, re-verified current. | S |
| Athlete Workspace -> "What's Coming" -> Video Analysis card | `apps/web/components/AthleteWorkspace.tsx:2700` | "Video Analysis - Not Built Yet" / "The screens are drawn. Nothing behind them works yet." linking to `/athlete/video-analysis`. | `pilot.video_sessions` (real table, indexed, with a scan-state machine) and `pilot.shadow_film_study_proposals`, both backed by working routes (`api/pilot/video/upload`, `/list`, `/[videoId]`, `/[videoId]/release`, `/review-link`, `/scan-review`). `/athlete/video-analysis/page.tsx` (200 lines) is itself a real, data-fetching film library that lists real videos, streams them, and shows real SHADOW observations -- only the ML scoring sub-panel is honestly labeled "PLANNED \| ML REQUIRED". The card's own claim ("nothing behind them works yet") is simply false now. | S |
| Athlete Workspace -> "What's Coming" -> Automatic Progress Tracking card | `apps/web/components/AthleteWorkspace.tsx:2707` | "Automatic Progress Tracking - Not Built Yet" linking to `/athlete/progression-intelligence`. | `pilot.progression_gaps`, `pilot.drill_assignments`, `pilot.assignment_completions` (`pilot_slice_postgres_progression_migration.sql`) plus working `api/pilot/progression/gaps`, `/assignments`, `/completions` routes. `/athlete/progression-intelligence/page.tsx` (489 lines) is a real, working surface that fetches and logs against these routes. | S |

Rejected as honest (verified, not reported): `athlete-reviews`/coach-review data flowing to the athlete, and the ML sub-panels inside both video-analysis pages, correctly say "PLANNED \| ML REQUIRED \| NOT YET AUTOMATED" -- no ML pipeline exists, so this is a correct absent state.

---

## Coach

| Surface | File:line | What it shows now | What already exists behind it | Fix size |
|---|---|---|---|---|
| Coach Workspace -> Film Study tab | `apps/web/components/CoachWorkspace.tsx:2287-2300` | Stamp "Planned — Not Yet Implemented"; body copy "Coming soon: Video upload, timestamp annotations, technical analysis tools" and "Video Upload: FRONT-END PLACEHOLDER \| Skill Recognition: BACKEND REQUIRED \| Technique Scoring: ML REQUIRED", with links out to `/coach/video-analysis` and `/athlete/video-analysis`. | Same video domain as the athlete finding above: `pilot.video_sessions` + full upload/list/review/release/scan-review route set. `/coach/video-analysis/page.tsx` (577 lines) is a fully working upload form, film library, and film-study review queue (accept/reject proposals against `pilot.shadow_film_study_proposals`) with real polling against `api/pilot/shadow/video-analysis`. Only the five ML panels (Skill Recognition, Punch Detection, etc.) are honestly marked `PLANNED \| ML REQUIRED \| NOT YET AUTOMATED`. The embedded tab's claim that "Video Upload" itself is a "FRONT-END PLACEHOLDER" is stale -- upload has been real and working since the linked surface shipped. | S |

Rejected as honest (verified, not reported): the Coach Workspace **Assessments** tab (`CoachWorkspace.tsx:2274-2280`, "Coming soon: Leadership assessment, communication effectiveness survey, teaching impact evaluation") has no matching table anywhere in `infra/azure/*.sql` (`assessment_protocols` is athlete physical-test protocol data, not coach evaluation) and no route -- correctly labeled planned. `sessionStatus = 'Live session tracking is not built yet.'` (`CoachWorkspace.tsx:542`) and the coach task list/coach goals sections are deliberately-emptied honest states per their own inline comments (fabricated data was removed, not replaced with a feed) -- correct.

---

## Parent / Guardian

| Surface | File:line | What it shows now | What already exists behind it | Fix size |
|---|---|---|---|---|
| Parent Hub -> Progress & Achievements tab -> "Parent-Support Visibility Placeholder" | `apps/web/components/ParentHub.tsx:1093-1099` | Collapsed `<details>` labeled "Parent-Support Visibility Placeholder" containing "CLOSED-LOOP PROGRESSION INTELLIGENCE - PLANNED \| FRONT-END PLACEHOLDER \| BACKEND REQUIRED", linking to `/parent/progression-visibility`. | The linked page (`apps/web/app/parent/progression-visibility/page.tsx`, 372 lines) is fully real: it loads the guardian's linked children from `/api/pilot/athletes/list`, then reads the same `pilot.progression_gaps` / `pilot.drill_assignments` / `pilot.assignment_completions` records the athlete and coach surfaces use via `/api/pilot/progression/gaps`, `/assignments`, `/completions` -- server-side guardian-link enforcement included. This is a mature, shipped, read-only guardian view; the tile calling it a "front-end placeholder" needing backend is simply outdated copy. | S |

Rejected as honest (verified, not reported): Reply-to-coach messaging, Attendance Tracking, family goals, home assignments, parent observations, and parent resources all say "PLANNED \| NOT YET IMPLEMENTED -- there is no backend feed for X yet," and that is accurate -- no `home_assignments`, `family_goals`, `parent_observations`, or `parent_resources` tables exist anywhere in `infra/azure/*.sql`, and the one adjacent real table (`pilot.attendance` / `pilot.scheduler_attendance`) is fed by a route (`api/pilot/scheduler/attendance-summary`) whose own code comment explicitly scopes the parent role out and calls a parent-facing attendance view "real future work" not yet built. Correct absent states, not defects.

---

## Admin

| Surface | File:line | What it shows now | What already exists behind it | Fix size |
|---|---|---|---|---|
| Admin -> Revenue tab -> Payment Settings panel | `apps/web/components/RevenueFundingCenter.tsx:182-189` (`paymentIntegrations` array, rendered ~line 829) | Six rows -- "Stripe Placeholder", "Square Placeholder", "PayPal Placeholder", "Donorbox / Givebutter Placeholder", "QuickBooks Placeholder", "Microsoft / Power Platform Placeholder" -- every one hardcoded `status: 'Not Connected'`, `connected: false`, `notes: 'Future Integration \| Requires Backend \| Requires Compliance Review'`. No fetch call anywhere in this 885-line component. | A real Stripe Connect onboarding backend already exists and is switched on: `pilot.payment_accounts` / `pilot.payment_transactions` / `pilot.payment_subscriptions` (`pilot_slice_postgres_payments_migration.sql`, landed 2026-08-15 per owner decision), plus working routes `api/pilot/payments/connect/start`, `/connect/callback`, `/webhook`, `/accounts`, `/setup-status`. `apps/web/app/admin/payments/page.tsx` (253 lines) is a real, shipped "Connect Stripe account" flow for two lanes (giving/program) with live connect/disconnect status. (Charging itself is still correctly blocked pending compliance sign-off -- CAP-012 -- so "Stripe" specifically saying nothing is connected yet can be momentarily true, but the row's framing that the capability itself needs a backend, and the total disconnection from the real onboarding flow, is stale.) | M (swap hardcoded array for a real connection-status read, or delete panel and link to `/admin/payments`) |
| Admin -> Revenue tab -> Memberships / Grants / Sponsors / B2B panels | `apps/web/components/RevenueFundingCenter.tsx:101-220` (`revenueAccounts`, `revenueItems`, `revenueCapabilities` arrays) | Three hardcoded fake accounts ("Placeholder Youth Family Account", "Placeholder Community Sponsor", "Placeholder District Account") and three hardcoded fake line items, plus a `revenueCapabilities` table that self-rates Membership Tracking and Grant Tracking as `'PARTIAL'`/planning-only. The whole component has zero links to any of the real admin pages below -- it is a dead-end island under the `revenue` tab in `apps/web/app/admin/page.tsx:2591`. | Real, dedicated, working admin surfaces already exist for two of these domains: `/admin/memberships/page.tsx` + `api/pilot/admin/memberships` (backed by `pilot_slice_postgres_program_memberships_migration.sql`), and `/admin/grants/page.tsx` + `api/pilot/admin/grant-obligations` (backed by `pilot_slice_postgres_grant_obligations_migration.sql`). The Revenue Center panel neither reads from nor links to either. | M (delete the fake data + PARTIAL self-rating, replace with links to `/admin/memberships` and `/admin/grants`, or wire the panel to those same routes) |

Rejected as honest (verified, not reported): the component's own top-of-file comment ("No donation is recorded here... a seeded donor with a real amount would be read by a treasurer or a board member as money the gym actually received") and the universal `"Placeholder"` naming on every row are a deliberate, heavily-disclosed non-functional planning tool per `docs/PAYMENT_SERVICE_SLOT.md` -- the *disclosure* is honest. What makes the two rows above findings is narrower: real, working, linked backend and pages now exist for exactly the domains (Stripe connect, memberships, grants) this panel still describes as needing one, and the panel was never updated to point at them.

---

## Board

No stale placeholders found. `apps/web/app/board/boardWorkspaceConfig.ts` is unusually disciplined about this exact failure mode: every card in `boardWorkspaceCards` is explicitly tagged `'built'` or `'planned'` (`BoardCardStatus`), with an inline comment stating "Two cards are backed by a route a board session can actually call... Everything else is a description of intended work and says so." Spot-checked the two 'built' claims (`Organization Aggregate`, `Hand-Filed Compliance Register`) against `api/pilot/board/summary` and `api/pilot/board/compliance-summary` -- both real. Spot-checked several 'planned' claims (Compliance Watchlist, Board Action Register, Annual Filing) against `infra/azure/*.sql` -- no matching tables exist. `BoardMemberDashboard.tsx` also correctly links out to the two real standalone pages that do exist (`/board/compliance-monitoring`, real 307-line page reading `api/pilot/board/compliance-summary`; `/board/escalation-monitoring`, real 180-line page reading `api/pilot/board/escalation-summary`) rather than duplicating fake data for them.

One adjacent item flagged for awareness only (not counted as a placeholder finding, since it isn't "coming soon" copy -- it's a factual claim of non-existence): `BoardMemberDashboard.tsx:305` lists "Financial reserves, grants, and budgets" under a section titled "Not stored by this platform... There is no figure to load and none is being withheld." Grant obligations are now in fact stored (`pilot.grant_obligations`, see Admin section above), so this specific bullet is out of date. Worth a one-line correction, but it is a different defect shape than the ticket's target pattern and is not tallied in the counts below.

---

## Staff

No dedicated staff-role UI surface exists in `apps/web/app` or `apps/web/components` (searched for a `'staff'` role branch across `.tsx` files; the only staff-adjacent domain, volunteer/staff coverage, is served through the admin role). The one candidate checked -- `apps/web/app/admin/volunteer-management/page.tsx` -- already carries its own note that it was fixed: "Volunteer roster, status, and availability are now backed by persistent records instead of placeholders" (line 203), and reads/writes real form fields against a real backend. No staff-surface finding to report.

---

## Safe to fix first

Entries below need **no new schema and no new API route** -- the backend and, in every case, a working dedicated page already exist. The only work is updating or deleting stale copy in the surface that hasn't caught up:

1. **Athlete Workspace -- "What's Coming" panel** (`AthleteWorkspace.tsx:2700,2707`): delete the two "Not Built Yet" cards, or replace with a real status pulled from the same routes `/athlete/video-analysis` and `/athlete/progression-intelligence` already call.
2. **Coach Workspace -- Film Study tab** (`CoachWorkspace.tsx:2287-2300`): replace "Coming soon: Video upload..." and "Video Upload: FRONT-END PLACEHOLDER" with the real upload/review flow, or trim the tab down to just the still-true ML-panel disclosure and a link to `/coach/video-analysis`.
3. **Parent Hub -- "Parent-Support Visibility Placeholder"** (`ParentHub.tsx:1093-1099`): drop the placeholder framing; the linked page is real and guardian-safe today.
4. **Board -- "Financial reserves, grants, and budgets" bullet** (`BoardMemberDashboard.tsx:305`): update wording now that grant obligations are stored (even if board-level surfacing of them is a separate, deliberate scope decision).

The two Admin/Revenue Center findings are **not** on this safe list: fixing them well means either wiring the panel to the real routes or replacing it with links to `/admin/payments`, `/admin/memberships`, and `/admin/grants` -- a real (if small) integration change, not a copy edit, which is why they're rated M above rather than S.
