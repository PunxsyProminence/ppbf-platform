# Functional Baseline Map — Controlled Backpedal to Production Core

Owner request (2026-08-21): scope PPBF production down to a minimal, reliable
core — **Platform → Organization → Coach → Adult Athlete → basic workout
tracking + Coach Cards** — without deleting anything. This document is that
scoping pass: current `main` inspected via eight parallel read-only research
passes (code + schema + docs), not a design proposal and not code changes.

**Instrument note, per the kernel's evidence rules:** everything below is
*static-code-and-schema-verified* (file:line citations from direct reads of
`main`), not runtime-verified — no page was loaded, no query was run against a
live database. Where a finding depends on deployed state rather than source,
that is called out explicitly rather than implied.

**Branch-state anomaly, disclosed rather than fixed:** the designated working
branch (`claude/ppbf-production-baseline-sbffj5`) already carries ~288 files
of unmerged history diverging from current `origin/main` (SHADOW-UI docs,
visual-inventory docs, CI/package-integrity scripts) with no open, closed, or
merged PR against it. This document does not touch, reconcile, or build on
that content — it is added as a single new file on top of the branch as
found. Whether that prior content is active work-in-progress or a stale
artifact is an owner/repo-maintainer question, not one this pass answers.

---

## 1. KEEP ACTIVE

### Platform
- Auth: PIN login (`auth.ts:loginWithAccountIdAndPin` L99-182), Microsoft
  login (`loginWithMicrosoftEmail` L184-251), session resolution
  (`resolvePrincipal` L253-332). Entry pages: `app/login`, `app/auth/link`,
  `app/activate`, `app/change-pin`. API: `app/api/pilot/auth/{login,session,logout}`.
- Org lifecycle: `admin/organizations/page.tsx` SetupWizard (create gym →
  provision org admin → configure features), `auth.ts:createOrganization`
  (L919-950), `setOrganizationStatus` (L1013-1041), admin-transfer
  (L1132-1283).
- Platform Owner console: `admin/platform/page.tsx` (aggregate metrics,
  promote/transfer admin), gated `platform_owner`-only.
- Role/tenant enforcement core: `src/server/pilot/access.ts`
  (`requireRole`, `assertActorCanAccessAthlete`), `src/server/pilot/http.ts`
  (`requirePrincipal`).
- Org-scoped admin consoles needed for daily ops: `admin/athletes`,
  `admin/people`, `admin/attendance`, `admin/pin`, `admin/credentials`,
  `admin/activation-codes`.
- Structural entry points every role passes through: `app/dashboard` (generic
  post-login redirect), `app/public` (pre-auth landing/sign-in), `app/profile`
  (personal settings, every role).
- **Tenant isolation is already strong and should not be touched**: every
  request's `organizationId` is derived server-side from an active
  `organization_memberships` row at session-resolution time (`auth.ts`
  L287-290), and `organizationScope.convention.test.ts` statically fails the
  build if any API route reads `organization_id` without a recognized guard —
  isolation is a repo-wide, test-enforced invariant, not just a runtime check.

### Organization
- `pilot.organizations`, `pilot.organization_memberships` (base schema).
- `admin/coach-coverage` — **not just an admin nicety**: `access.ts`'s
  `assertCoachAssignedToAthlete` and `accessibleAthleteIds` read
  `pilot.coach_coverage` on every coach-scoped athlete access; it backs core
  authorization, not only a console.
- Basic org admin: `admin/attendance`, `admin/people`, `admin/pin`.

### Coach
- `CoachWorkspace` hub (`app/coach/environment/intake-router`) — roster,
  readiness, floor plans, goals, tasks.
- `pilot.drills` basic library + `app/coach/drills` + `app/api/pilot/drills`.
- `app/coach/floor-groups` + `floorGroups.ts` — per-session group placement
  (today's groups; no persistent roster — see §3, Coach Cards gap).
- **The real basic-workout loop** (already working, in
  `src/server/pilot/progression.ts`):
  1. `createProgressionGap` — coach opens a gap for one athlete.
  2. `assignDrill` — assigns a drill, flips gap to `assigned`.
  3. `recordCompletion` — athlete/coach logs a completion.
  4. `verifyCompletion` — coach marks it `verified`/`disputed`.
  This is genuine working functionality, not a mock — see §2 for why it
  still needs a small UI carve-out.
- `app/api/pilot/training-attempts` + `trainingAttempts.ts` (per-athlete
  attempt log) and `app/coach/attempt-log`.
- `app/api/pilot/coach-reviews` (`upsertCoachReview`).
- `coach/credentials`, `coach/sports-medicine` — see §1 Safeguarding below;
  this is foundational, not "advanced safeguarding."
- `coach/disciplines` — read-only safety-exposure view (no write path), keep
  as a low-risk safety reference.

### Adult Athlete
- `pilot.athletes` (org + coach FKs), `app/athlete/sign-in` (PIN),
  `app/athlete/dashboard` → `AthleteWorkspace.tsx`.
- Check-in / floor tasks: `AthleteWorkspace.tsx` `buildWorkoutFloorTasks()` —
  a **deterministic, non-ML** readiness function — writing to
  `/api/pilot/floor-plans` and `/api/pilot/sessions`.
- Assigned-drill consumption/logging: the athlete-facing side of the
  progression loop above, via `/api/pilot/progression/{gaps,assignments,completions}`.
- History: `AthleteWorkspace.tsx` session list via `/api/pilot/sessions/list`.
- Receiving Coach Cards (individual): `pilot.recognitions` (see §3).

### Workout tracking (the loop as a whole)
Coach creates gap → assigns drill → athlete logs completion → coach verifies
→ history persists in `pilot.progression_gaps` / `drill_assignments` /
`assignment_completions`, backed by `pilot.training_attempts` and
`pilot.sessions`/`coach_reviews`. **This already exists and is real** — the
work needed is UI separation and a deployment check (§4/§5), not a new
engine.

### Coach Cards
- **Individual issuance is ~80% built**: `pilot.recognitions`
  (`achievements.ts:createRecognition`), served by
  `POST/GET /api/pilot/achievements/recognition`, surfaced in
  `CoachRecognitionPad.tsx` / `CoachMilestoneMarker.tsx`. It already tracks
  issuer (`coach_account_id`, server-derived, never client-supplied), org
  (`organization_id` FK), a single `athlete_id` recipient, and an append-only
  history (no PATCH/DELETE). `pilot.athlete_milestones` is the sibling table.
- **Group issuance does not exist anywhere** — see §4 (Blocking Complexity)
  and §6 (Minimum Change Set item 4). This was independently confirmed by two
  research passes (coach-domain and capability-docs), and a repo-wide,
  case-insensitive grep for "coach card"/"CoachCard" across `*.ts`, `*.tsx`,
  `*.md` returns **zero matches** — the term itself is not in the codebase;
  "recognitions" is the closest analog, not a synonym.
- Note: `app/print`'s `FightCard`/`PrintableFightCard` components are a
  *different* concept (a printable member/fight card) that surfaced during
  research as a name-collision risk — flagged in §4, not assumed to be what
  "Coach Cards" means.

---

## 2. MAKE DORMANT

Verified per-folder (not name-inferred) via `requirePageRole`/`RoleSessionGate`
role gates on each page:

**Platform/org admin, advanced:** `admin/macro-analytics`, `admin/curriculum`,
`admin/communications`, `admin/retro-lab`, `admin/compliance-center` (its own
UI badges itself "Planned" — automated monitoring behind it isn't built),
`admin/grants`, `admin/community-service`, `admin/public-interest`,
`admin/volunteer-management`, `admin/door-register`, `admin/video-compliance`,
`admin/video-review`, `admin/portrait-review`, `admin/customize`,
`admin/import`, `admin/export`, `admin/data-quality`, `admin/gear`,
`admin/memberships`, `admin/feedback`, `admin/shadow`.

**Governance/reporting dashboards (no unique Coach/Athlete logic):**
`app/board/*` (board-only), `app/director` (a stub redirect to
`/admin/escalations` + `/admin/safety-review` — its own body says its old
content was already deleted as fabricated prototype content),
`app/operations` (a pure nav launcher, its own comment: "no athlete-scoped
data on the page"), `app/launch` (a literal re-export alias of `/operations`),
`app/audit`, `app/evidence` (SHADOW source-review queue),
`app/source-control` (confirmed mock/placeholder — hardcoded sample data, no
API calls), `app/workspace` (staff/SHADOW research hub, explicitly excludes
athlete records/scheduler/admin/board by its own comment).

**Ancillary/community features (not workout tracking):** `app/names` (Wall of
Names memorial), `app/notices` and `app/chalkboard` (announcement
authoring UI — but see §4, their *rendered output* feeds kept dashboards),
`app/staff-credentials` (status-only, real review lives in
`/admin/credentials`), `app/store` (public storefront index), `app/wall`
(kiosk display), `app/help` (static help center).

**Coach, advanced/SHADOW-adjacent:** `coach/decision-loop`,
`coach/progression-intelligence` (the ML-gap-suggestion *framing*; its
underlying assign/verify functions are KEEP ACTIVE — see §4),
`coach/intervention-protocols/-executions/-review` (confirmed to be a
training-methodology R&D workflow, not youth behavioral safeguarding — see
§1 Safeguarding), `coach/video-analysis` and `coach/video-publications`,
`coach/one-percent-club` (peer-nomination/vote ceremony, not card issuance),
`coach/performance-analytics`, `coach/intelligence`, `coach/transfer-check`,
`coach/cue-library`, `coach/passbook-gaps`, `coach/behavior-standards`,
`coach/cohorts`, `coach/review-queue` (self-declared "Planned — Not Yet
Implemented"), `coach/operations` (`FloorOperationsDesk` — its own honesty
test confirms it renders entirely fabricated mock data; not a real surface).

**AI/ML/SHADOW, full inventory:** `app/shadow/*`, `app/admin/shadow`,
`app/api/pilot/shadow/*` (~75 route files: chat, jobs, film-study, library,
recommendations, decisions, near-misses, unlocks, telemetry), `azureAiRuntime.ts`
+ its Azure OpenAI/vision calls, `coachIntelligence.ts` ("Coach Intelligence
Engine", SQL-only despite the name — no ML), `app/knowledge-graph`,
`app/simulator`, `app/rabbit-holes`, `app/retro-lab`,
`athlete/progression-intelligence`, `athlete/video-analysis`. See §5 for the
verdict that none of this is a hard dependency.

**Youth/guardian-specific:** `app/parent/*`, `app/guardian/*` (both
consistently gated to role `'parent'`, the "canonical guardian-family role"
per their own code comments), `guardianConsent.ts`, `admin/athlete-consent`,
`admin/consent`, the guardian-media-consent columns on `pilot.waivers`,
GATE 3 (travel waiver) inside `competitionSafetyGates.ts`.

**Confirmed dead/legacy code (no action needed, already effectively dormant):**
`packages/intelligence/*` (`advancedAnalytics.ts`, `aiRefusalEngine.ts`),
`packages/portals/*`, `packages/routing/*` (`routeFactory.ts`),
`packages/continuity/*` — zero import edges from `apps/web` found by grep
across all of them; `packages/portals/README.md` and
`packages/routing/README.md` self-describe as placeholder/unimplemented.
`packages/governance/featureFlags.ts` is similarly unimported (see §4).
`apps/research-bridge` — has its own IaC (`infra/main.bicep`) and passes its
own CI (`research-bridge-ci.yml` typechecks/tests/builds it), but **no
workflow anywhere in `.github/workflows` actually deploys it** (`main.bicep`
is never referenced by any workflow), and `apps/web` only ever *exports*
data toward it (one-way), never calls into it.

---

## 3. BLOCKING COMPLEXITY

1. **No working capability/feature-flag mechanism is wired to enforcement.**
   Three candidate mechanisms exist and none actually gates a route:
   `packages/governance/featureFlags.ts` (zero import edges from `apps/web`,
   and its own comment admits its one intended caller is itself never
   invoked); the CAP-001..013 "Capability Room" registry (`pilot.
   admin_capability_registry`) is read back for display only, never checked
   by an `if` that blocks anything; the 200-module backlog
   (`docs/capabilities/expanded-200-backlog.csv`) has its own README
   admitting nothing in the running app reads it. **The only mechanism that
   actually works today** is the role-allowlist argument already used on
   every `page.tsx`/API route (`requirePageRole([...])` /
   `RoleSessionGate allowedRoles={[...]}` / `requireRole(principal, [...])`)
   — narrowing or removing a role from that array, or removing a nav link,
   is the real, already-used lever for "dormant." There is no single switch
   that dormants a whole feature area (nav + page + API) in one place; it
   has to be done per-surface using the existing pattern.
2. **The real basic-workout loop is UI-entangled, not backend-entangled.**
   `progression.ts`'s create/assign/verify functions are clean and
   separable, but the *only* client surface exposing them today is
   `coach/progression-intelligence`, which renders the loop UI intermixed
   with auto-generated ML-style `GapSuggestionItem` rows in the same view.
   Carving out a baseline "assign & track workout" surface means a new/
   trimmed page reusing the existing backend — not a new engine, and not
   simply hiding the existing page (coaches need *something* to use).
3. **No durable "group" primitive exists for group Coach Card issuance.**
   `floor_groups` are explicitly per-session/ephemeral ("nothing follows an
   athlete to tomorrow"); `competence cohorts` are rule-computed with no
   membership table ("a RULE, not a roster"); `announcements` are broadcast
   text with no per-recipient tracking. Building group Coach Cards requires
   first deciding which of these (if any) should be promoted into a durable,
   addressable roster — a product decision, not just a route.
4. **Adult vs. youth is not a stored discriminator anywhere.** No
   `is_minor`/`age` column exists on `pilot.athletes` or `pilot.accounts`.
   Age is derived at *read time* from `dob` (an 18-year cutoff in
   `wallDisplay.ts`) purely for display/consent purposes, and the auth/role
   model is fully age-blind (`role === 'athlete'` covers everyone via PIN
   login). **"Adult-only production" cannot be enforced by a per-athlete
   code branch today** — it has to be an org-level/intake-policy decision
   (only enroll adults into baseline-scoped orgs) unless a schema change is
   explicitly authorized later.

---

## 4. DEPENDENCY RISKS

- `admin/page.tsx` (the shared admin hub) hard-links to several
  MAKE-DORMANT routes (`people`, `export`, `consent`, `import`, `gear`,
  `customize`, `compliance-center`, `shadow`) and unconditionally calls the
  non-enforcing Capability-Room APIs (`track-assignments`, `capabilities`)
  on mount — hiding those surfaces means editing this shared hub's nav, not
  just deleting their own folders.
- `admin/coach-coverage` backs core coach→athlete authorization
  (`assertCoachAssignedToAthlete`) — it is admin-labeled but load-bearing;
  do not dormant it.
- `trainingHolds.ts` STOP holds are wired directly into
  `schedulerDb.ts`'s class-registration path for **every** athlete — this
  cannot be treated as "youth-only safeguarding" and disabled; it is
  foundational.
- `competitionSafetyGates.ts`'s `assertAthleteMayBeEnteredInCompetition`
  bundles a foundational access check, a generic training-hold check, and
  the youth-only travel-waiver check (GATE 3) in one function — disabling
  the youth-specific gate requires a surgical edit inside that function, not
  disabling the whole assertion.
- `notices`/`chalkboard` are MAKE-DORMANT as *authoring* pages, but their
  output (`AnnouncementBanner`) is rendered on kept athlete/coach/parent
  dashboards — keep the render path even if the dedicated authoring pages
  are hidden from nav.
- `app/schedule` (class registration / coaching requests / check-in) is a
  real, live Coach+Adult-Athlete feature not named in the original scope
  description but squarely inside "normal boxing operations." **Recommend
  KEEP ACTIVE** — flagging explicitly since it wasn't named, rather than
  silently deciding.
- Drill-table fragmentation: three separate tables serve "drills" —
  `pilot.drills` (used by the basic loop), `pilot.drill_library` (versioned,
  used by workout-template items), and a drill-versioning review workflow
  on top of `pilot.drills`. Keeping the basic loop while dormanting advanced
  drill-versioning requires deciding which table is canonical for the
  baseline (recommend `pilot.drills`, already the one the basic loop uses).
- SHADOW's minor-safe prompt/feedback-scan (`shadowChat.ts`, `feedback.ts`)
  runs identically for adult athletes sharing the same code path — isolating
  youth AI paths must not strip safety scanning from adults using the same
  SHADOW surface, if that surface stays reachable for anyone.
- `app/print` (`FightCard`/`PrintableFightCard`) is a real, live
  Coach+Adult-Athlete-facing feature (member card / milestone certificate
  printing) that shares vocabulary with "Coach Cards" by coincidence, not
  design — worth an explicit naming check with the owner so it isn't
  confused with the recognitions-based Coach Cards feature above.
- `guardianConsent.ts` throws when an athlete has zero `guardian_links` rows
  — before treating guardian flows as fully dormant for adult-only orgs,
  confirm no adult-facing route ever reaches this function (adults
  structurally have no guardian links, so an accidental call would
  incorrectly block them).

---

## 5. DATA RISKS

- **No core table has any outbound FK, NOT NULL dependency, or check
  constraint into the SHADOW/safeguarding/youth clusters** — verified by
  grepping every `alter table pilot.(organizations|accounts|athletes|
  organization_memberships)` across all 96 migration files: only additive
  columns were ever added to core tables, never FKs into advanced tables.
  Making a feature dormant at the app layer (stop writing to its tables) is
  schema-safe.
- **One real trigger coupling**: `cascade_parent_deletion()` (a trigger on
  `pilot.accounts`) joins `pilot.guardian_links`/`pilot.parents` to cascade a
  parent's soft-delete to linked athletes. Leaving those tables in place but
  unused (dormant) is safe — the trigger simply no-ops on empty tables.
  **Do not drop those tables**; that would break the trigger.
- **`isMinor()` defaults a missing/unparseable `dob` to "minor"** for
  display/consent purposes (`profileVisibility.ts`) — a data-quality gap on
  an adult athlete's record (no `dob` recorded) silently degrades their
  display/consent handling today. Scoping work must not assume "no dob ⇒
  safe to treat as adult"; if anything it's the opposite under current code.
- **Deployment gap, flagged as the single most important data risk found**:
  per `docs/current/PRODUCTION_STATE.json`, both staging and production are
  pinned at the commit for PR #391 (2026-08-16), and ~122 commits since
  (~PR #412 onward) are unconfirmed-deployed. Critically, the schema log
  states the `pilot.training_attempts` migration — one of the core tables
  this baseline depends on for "basic workout tracking" — **was registered
  in the migration workflow but was NOT part of the last confirmed
  production run** ("merged after; applies with the next wave"). **Before
  relying on the basic workout loop as "already working in production,"
  this needs a direct check against the live database**, not an inference
  from source. This is a `NEEDS_MEASUREMENT` item, not yet answerable from
  this repo alone.
- **Precedent for how this repo treats schema removal**:
  `pilot_slice_postgres_dead_schema_removal_migration.sql` dropped three
  genuinely-unused tables (`messages`, `skills`, `staff`) only after an
  exhaustive cross-repo usage grep and explicit owner sign-off, using plain
  `drop table if exists` (no CASCADE) so an undiscovered reference would
  fail loudly. **This task should never reach that bar** — nothing here
  calls for dropping tables, only for the app layer to stop writing to
  SHADOW/safeguarding/youth tables for baseline-scoped orgs. If a future
  phase ever does consider dropping something, this migration is the
  precedent for the standard of care required first.

---

## 6. MINIMUM CHANGE SET

Ordered, smallest safe steps — each independently shippable, none requiring
a rewrite:

1. **`NEEDS_MEASUREMENT`, no code**: confirm directly against the actual
   staging/production database whether `pilot.training_attempts` (and any
   other workout-tracking migration merged after PR #391) has actually been
   applied. This gates whether "basic workout tracking" is a baseline that
   already works in production or one that needs an owner-authorized
   deploy/migration pass first (Ops/deploy lane, human-gated per the
   kernel — not something this task can trigger itself).
2. **Nav-level dormancy pass** (reversible, zero deletion, no schema
   change): remove the MAKE-DORMANT surfaces from §2 from default
   navigation for baseline roles, using the existing
   `requirePageRole`/`RoleSessionGate` allowlist pattern already used
   throughout the codebase (e.g. how `athletes/page.tsx` already excludes
   `platform_owner` via `WrongRoleNotice`). Routes stay reachable by direct
   URL and fully role-gated exactly as today — this only declutters what a
   baseline user is shown, per the "inactive routes, disabled navigation"
   preference over deletion.
3. **Carve a minimal "Assign & Track Workout" coach surface** out of
   `coach/progression-intelligence`, reusing the existing
   `progression.ts` functions (`createProgressionGap` → `assignDrill` →
   `recordCompletion` → `verifyCompletion`) behind a new thin page that
   omits the ML gap-suggestion UI. No backend changes.
4. **Coach Cards — individual**: no new code required. Confirm
   `pilot.recognitions` + `CoachRecognitionPad.tsx` already satisfy the
   baseline's individual-issuance requirement end-to-end (issuer/org/
   recipient/status/history all present); at most a labeling/copy change if
   the product wants it called "Coach Card" in the UI.
5. **Coach Cards — group (`OWNER_DECISION` needed before code)**: decide
   which existing concept (floor-groups, cohorts) should be promoted into a
   durable, addressable roster, or whether a new minimal group-roster table
   is warranted. Once decided, the smallest safe addition is one additive
   join table plus a fan-out write path reusing `pilot.recognitions`'
   existing issuer/org/status/history columns per member — not a new
   recognition system.
6. **Safeguarding dormancy for adult-only orgs**: use the already-existing,
   already-wired per-org kill switch (`pilot.safety_gates.active_flag =
   false`) to turn off GATE 3 (travel waiver) and guardian-consent-blocking
   behavior for baseline-scoped organizations. No new mechanism needed —
   this is configuration, not code, and is the intended dormancy lever the
   codebase already provides. Medical clearance and training-hold gates
   stay active and untouched (§1) since they are generic, not youth-only.
7. **Youth isolation**: hide `/parent` and `/guardian` from navigation for
   adult-only orgs (same lever as step 2). `guardian_links`/`pilot.parents`
   tables and their trigger stay exactly as-is, simply unused for
   baseline-scoped orgs — no schema change.
8. **AI/ML isolation**: no code change required beyond step 2's nav pass —
   §5 of the AI/ML research verified zero hard dependency between any core
   path and any SHADOW/AI module; every AI surface already fails closed
   when unconfigured and sits outside the post-login routing table.

Each of these is independently shippable as its own small, bounded PR, in
roughly the order above (measurement first, then nav decluttering, then the
one genuine product gap — group Coach Cards — last, since it is the only
item requiring a new decision rather than reuse of what already exists).

---

## Scope-creep watchlist (recorded, not built)

Per the owner's instruction to record rather than build anything
interesting-but-nonessential encountered along the way:

- **LATER** — `app/schedule` class-registration/coaching-request system is
  fully wired and real; confirm inclusion explicitly (leaning KEEP, see §4)
  rather than silently deciding either way.
- **LATER** — the 200-module capability backlog
  (`docs/capabilities/expanded-200-backlog.csv`) is a real, detailed planning
  artifact but is unconsumed by the running app and has stale counts vs.
  current state; useful as a secondary reference, not authoritative, and not
  something this task should reconcile.
- **PRESERVE** — `apps/research-bridge` has real IaC scaffolding
  (`infra/main.bicep`) that no workflow currently invokes; leave as-is,
  dormant by omission, not by explicit flag.
- **PRESERVE** — `packages/{intelligence,portals,routing,continuity}` are
  confirmed dead/unimported legacy code; no action needed, they impose zero
  risk sitting as-is per the non-destructive rule.
