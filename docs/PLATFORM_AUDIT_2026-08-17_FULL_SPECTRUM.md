# PPBF Platform — Full-Spectrum Application Audit

**Date:** 2026-08-17
**Scope:** Entire application — every role tier from Omega (platform_owner) down to the public visitor. UX/UI completeness, navigation flow, capability status, frontend↔backend wiring, database/infrastructure layer, the SHADOW AI subsystem, needed research, and the inventory of forms/materials the organization needs.
**Method:** Twelve parallel research passes (frontend/UX census, backend/API wiring, the 200+ module capability tracker, role/auth wiring per tier, forms & materials inventory, SHADOW AI status, database schema, CI/testing/deployment health, design-system completeness, a dedicated fabricated-data sweep, synthesis of four prior internal audits dated 2026-07-18 through 2026-08-07, and a sweep of the organization's Google Drive), each independently verified against current source rather than trusted at face value, plus direct spot-verification of the highest-stakes claims. **No code was changed** in producing the original report below; a small set of follow-up fixes were made afterward and are tracked in the addendum at the bottom of this document.

> **Addendum, 2026-08-17 23:3x UTC — cross-referenced against the concurrent capability-network audit.** A separate, independently-run capability-network audit (8 agents, 34 capabilities mapped as a read/write graph, published as its own report) was underway in parallel with this one, on the same `origin/main`. Its findings substantially overlap with and extend this report's — see **§13 Addendum** at the end of this document for the reconciliation and the status of every fix made in response to either report.

**How to read this document:** findings are marked with a severity tag — 🔴 **HIGH** (integrity/safety-relevant, fix soon), 🟡 **MEDIUM** (real defect, not urgent), 🔵 **LOW/INFO** (housekeeping, or a positive finding worth recording). Per this repo's own `MASTER_INDEX.md` doctrine, current source beats prose — every claim below was checked against live code, schema, or a directly-read document, not against memory of a past audit.

---

## 0. Executive summary — the 18 things that matter most

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | `/board/dashboard` shows nonprofit board members and the platform owner **hardcoded, undisclosed fake budget/grant/meeting data** ($125,000 allocated, $84,220 spent, $89,500 fabricated grant pipeline) with zero API wiring and no honesty disclaimer — the exact opposite of the honest `/board` hub three clicks away, which explicitly says "there is no figure to load and none is being withheld." | 🔴 HIGH | §4.4, §12 |
| 2 | `/admin/macro-analytics` shows an org admin **fabricated SafeSport/background-check clearance status for three named staff** ("Cleared - 2026 cycle," etc.) — undisclosed, safeguarding-relevant, worse in kind than the budget fabrication above. | 🔴 HIGH | §4.4, §12 |
| 3 | **Omega (platform_owner) has real, audited backend endpoints with zero UI**: promote/transfer/demote an org admin, toggle an organization's active status, create/status a platform user, grant master SHADOW access. Today these require a direct API call — there is no console workflow for the platform's most senior tier to do them. | 🔴 HIGH | §2.1, §12 |
| 4 | The 200+ module **capability tracker is completely disconnected from the running app** (`governance.active=false`; nothing in `apps/web` reads it). A row marked "DONE" changes nothing a user sees. Only ~20-30 of the 94 "DONE" rows carry real, evidence-cited builds; the rest range from a single unverified 2026-08-03 stamp to fully tested slices. | 🔴 HIGH | §5, §12 |
| 5 | The entire **Swim/Water Confidence safety domain is 0% built** — no schema, no code, no UI, all 7 modules still blank `DRAFT` scaffolds — despite the platform's own task-dimension taxonomy including water-related programming. | 🔴 HIGH | §5, §6, §12 |
| 6 | **No medical intake form, no liability-waiver e-signature capture, and no SafeSport/code-of-conduct acknowledgment flow exist anywhere in the app.** Consent tracking is metadata-only ("a waiver was signed, on paper, off-platform"). | 🔴 HIGH | §9, §12 |
| 7 | The **Consent/Waiver Tracker's write API has no UI screen calling it** — a guardian's consent can currently be recorded by an API call with no human standing in the gym. A real, well-designed **clearance register** (background-check/SafeSport tracking, PA Act 153/15 + US Center for SafeSport aware) has full schema + server module + tests and **zero API route, zero UI** — completely unreachable. | 🔴 HIGH | §5, §6, §9 |
| 8 | The `document-ingest` integration is **missing every required environment variable in both staging and production** — it will throw on every real invocation as currently configured, not just in a documented-gap sense. | 🟡 MEDIUM | §7 |
| 9 | The **core platform has no infrastructure-as-code** anywhere in this repo — only the SHADOW research-bridge subsystem is defined in Bicep. The primary app/database can't be reproduced from source alone. | 🟡 MEDIUM | §7 |
| 10 | Four independent audits (2026-07-18 → 2026-08-16) each **independently rediscovered the same three defects**: the kiosk tap-target accessibility floor keeps regressing (three separate sweeps each missed a different subset), the contrast sweep (`npm run sweep`) has never actually been run, and "a real backend ships with no UI entry point" recurs across Omega, coach workspace navigation, and several standalone routes. | 🟡 MEDIUM | §11 |
| 11 | Multi-tenant isolation is **application-code-enforced only** — zero Postgres Row-Level Security policies anywhere in the schema. Composite primary/foreign keys mitigate the worst cross-tenant-reference bug class, but nothing at the database layer stops a query that simply omits the `organization_id` filter. | 🟡 MEDIUM | §6 |
| 12 | SHADOW's own research-evidence registry flags an **unresolved AAP/CPS pediatric-medicine opposition to youth boxing** as "the most consequential" unresolved conflict, marked "ESCALATE TO BOARD AND MEDICAL ADVISOR... do not proceed with youth contact expansion until this exists." This is a live, open governance question, not a code defect. | 🔴 HIGH (governance) | §8, §10 |
| 13 | Two Drive documents both titled `SHADOW_ML_ALGORITHM_STACK.md`, both marked "Accepted," created one minute apart, with **no reconciled canonical version** — an unresolved documentation-authority question. | 🟡 MEDIUM | §10, §11 |
| 14 | **Good news, independently verified:** a Drive handoff document's flagged "highest severity" concern — that medical/contact clearance is "a client-supplied boolean with no server-side verification" — traces to `packages/execution/safetyGate.ts`, confirmed **dead legacy code never imported anywhere in the live app**. The real, live path (`contactClearanceGate.ts`) does a genuine server-side database lookup before flagging unauthorized contact. This concern is resolved in current code. | 🔵 INFO (resolved) | §10 |
| 15 | The "off-design-system console styling" seen on the flagship `/shadow` AI page and 6 admin pages is **not a gap in the design system** — a working dark "night room" mode already exists and is used correctly on sibling SHADOW pages. It's a **regression**: `/shadow` drifted from a documented, previously-verified conversion, and `docs/FRONTEND_STYLE_CONTRACT.md` **falsely claims the migration is complete**. | 🟡 MEDIUM | §4.3, §11 |
| 16 | Four **orphaned git bundles** sit in the organization's Drive (`feat-coach-workspace-ux`, `feat-athlete-workspace-ux`, `feat-coach-floor-run-surface`, `fix-shadow-pain-report-label`) — real engineering work handed off outside the normal git remote. Their branch names don't appear in current repo history; whether this work ever landed, was superseded, or was lost is unknown. | 🟡 MEDIUM | §10, §12 |
| 17 | Production's Azure resource group is still named `rg-ppbf-enterprise-staging` — flagged as a near-miss by a prior audit, still true today. | 🔵 LOW | §7, §11 |
| 18 | A public-surface privacy denylist (`privacyTiers.ts`) contains the string `'pilot.compliance_records'` — **no such table exists**; every sibling entry in the same list correctly matches a real table. This entry silently protects nothing (likely meant `pilot.compliance_violations`). | 🟡 MEDIUM | §6 |

**The overall picture:** this is a large (126 pages, 228 API routes, 162 database tables), unusually disciplined codebase — access control is clean, most of the app is real and DB-backed, test coverage is dense exactly where it matters (safety gates, payments, auth), and the team has repeatedly caught and fixed its own defects (three P0s in one week in early August, a full audit-driven remediation on 2026-07-31). The genuine problems cluster in a few identifiable places: a small batch of legacy prototype pages that show fabricated data without disclosure, a governance layer (Omega tier, capability tracking, documentation currency) that hasn't kept pace with the build layer, and several safety-adjacent domains (water safety, medical intake, background-check verification) that are either 0% built or built-but-unreachable.

---

## 1. Role-by-role experience: Omega down to public

Role enum (`apps/web/src/server/pilot/contracts.ts`): `platform_owner` (internally "**Omega**" in code/comments — doctrine: "broader in breadth, strictly narrower in depth" than an org admin), `organization_admin`/`admin`, `board`, `coach`, `athlete`, `parent`, `volunteer`, `staff`. Credential policy: "administrators use Microsoft, adults use email magic-link, kids use a stage name and a PIN."

| Role | Destination | What's real | Gaps |
|---|---|---|---|
| **Omega / platform_owner** | `/admin/platform` | Gym switcher + live cross-org aggregate metrics, invite staff/gym-admin, create an athlete "login shell," full 3-step org-onboarding wizard. `access.ts` enforces the doctrine at the data layer: `assertActorCanAccessAthlete` throws unconditionally for platform_owner before any other check — this role **cannot** see organization-private athlete records, full stop, even though it can see everything else. | **6 real, audited backend endpoints have no UI**: promote/transfer/demote an org admin, toggle org active status, create/status a platform user, grant master SHADOW access. Console is real but thin relative to its own backend (2 pages, 3 forms). |
| **organization_admin** (+ legacy `admin`) | `/admin` | The richest tier: a 2,670-line hub fanning out to ~15 real, wired sub-consoles (People, capability matrix/builder, PIN management, activation codes, compliance, video, roster import/export, drills, equipment). Full capability-registry CRUD with bulk actions and undo. | Compliance Center honestly labeled "Planned." History of nav links (`/admin/athletes`, `/admin/export`, `/coach/drills`) that were reachable only by typing a URL until someone added buttons — a recurring pattern, not a one-off. |
| **board** | `/board` (or seat-specific) | Aggregate-only by hard design: k-anonymity floor of 5 (`BOARD_MINIMUM_COHORT_SIZE`), figures below the floor render "withheld," never blank/zero. `assertActorCanAccessAthlete` refuses board the same way it refuses Omega. A real regression test (`boardRoleBoundaries.test.ts`) drives 8 athlete-scoped API surfaces as a board principal and asserts 403 on every one. 8 named-seat pages exist (president, treasurer, secretary, etc.). | **`/board/dashboard` (a different, unlinked page) shows the opposite of this discipline** — see §0 #1. Board SHADOW chat access is deliberately, verifiably empty. |
| **coach** | `/coach/environment/intake-router` → `CoachWorkspace` | Full-featured, real workspace (intake review, floor plans, pain reports, reviews). A code comment records that the *previous* destination, `/coach/review-queue`, was "a hardcoded mock whose Approve button discarded everything" — deliberately routed away from. Access to an athlete requires exact assignment or a time-boxed, audited coverage grant. | Workspace links to only 4 of the coach's 25 real sub-pages in-context (cue library, drills, one-percent club, etc. are reachable only via global search). |
| **athlete** | `/athlete/dashboard` → `AthleteWorkspace` | The largest single dashboard component in the app (2,771 lines); PIN sign-in with forced first-login PIN rotation enforced both client- and server-side. | Code history shows a full-tier regression once slipped through: a prior commit briefly swapped the real workspace for a zero-fetch check-in stub, silently dropping the athlete's only pain-reporting path, before being reverted — evidence of real fragility risk even though currently resolved. `athlete/dashboard/sparring` has **no role guard at all** and is unlinked from the workspace — the one athlete-scoped data-entry surface open to any signed-in role in the global nav. |
| **parent/guardian** | `/parent/dashboard` → `ParentHub` | Solid, fully cross-linked dashboard; access gated per-athlete through verified guardian links, checked per call. | `guardian/` is a live, fully duplicate, deprecated stub of `parent/` — two URLs for the same thing, confusing but not unsafe (both honestly redirect-with-explanation). |
| **volunteer / staff** | `/workspace` (shared) | Real, honest, self-aware: an explicit "Outside This Role" section names exactly what's not available and why, and every link was checked against its backing route's role allowlist before being added. | **The thinnest tier by far** — one page, four links (SHADOW Chat, Library, Research Intake, Help). No shift signup, no task list, despite the public-facing volunteer pitch describing real gym work. |
| **public / unauthenticated** | `/public` | Complete, coherent, 823-line real marketing + intake funnel: landing → program cards → a genuine intake form (POSTs to `/api/pilot/public-interest`, honeypot + consent checkbox) → explicit "what happens after you submit" flow. Deliberately **not** self-service enrollment — states plainly that submission only logs interest for human follow-up. All internal anchor links resolve; no dead ends found. | None found — this is one of the most complete, disciplined surfaces in the app. |
| **PIN / kiosk auth** | `/admin/pin`, `/athlete/sign-in`, `/change-pin`, `/admin/activation-codes` | Fully DB-backed end to end: account-shell creation → activation-code issuance → PIN activation → forced rotation on first use → reset with full session revocation. No stub steps found anywhere in the chain. | None found. |

---

## 2. Frontend / UX findings

### 2.1 Route census

**126 `page.tsx` files** on disk (one dynamic segment, `store/[organizationId]`). The app's own design doc, `apps/web/src/design/PAGE_MAP.md`, inventories only 65 routes — it predates roughly half the app (all of `director/`, most of `coach/*`, most of `admin/*`, `parent/consent`, `parent/safety`, `store/*`, `chalkboard`, `wall`, `workspace`, `profile`, `print`, `notices`, `names`) and should be treated as stale, not current design guidance.

The app does have a **live, self-correcting navigation-coverage system** that PAGE_MAP.md predates: `apps/web/components/buildingMap.ts` (the actual global nav catalog) plus `buildingMapCoverage.test.ts`, which walks every route on every test run and fails if a page lacks a nav entry, a documented exclusion, or a tracked "pending triage" entry. Verified by hand: **zero unaccounted orphans** — every one of the 125 non-dynamic routes is a door, a documented exclusion, or an explicitly pending-triage item. This is real engineering discipline worth recording as a strength.

| Section | Pages | Assessment |
|---|---|---|
| `admin/` | 42 | Broad, mostly real; hub page links only ~13 of its 42 sub-pages directly (global search covers the rest, by design) |
| `coach/` | 25 | Deep and real, but the daily-use workspace links only 4 of them in-context |
| `board/` | 12 | 8 disciplined seat wrappers + the fabricated-data outlier (`/board/dashboard`, §0 #1) |
| `athlete/` | 5 | Small, solid, one access-control inconsistency (`sparring` sub-page, no role guard) |
| `parent/` | 4 | Complete, fully cross-linked, no gaps found |
| `public/`, `workspace/` | 1 each | `public/` is not thin — a genuinely complete 823-line funnel; `workspace/` is thin by design (staff/volunteer) |
| All others | 1 each | Spot-checked; real and fetch-backed, or documented pure redirects |

### 2.2 Navigation/flow defects (beyond the existing `docs/design/PLACEHOLDER_MAP.md` findings)

`docs/design/PLACEHOLDER_MAP.md` already documents several cases of stale "coming soon" copy sitting on real, working backends (Athlete Workspace video/progression cards, Coach Film Study tab, Parent visibility placeholder, Admin Revenue Center). This audit found the following **additional** instances of the same pattern, plus new flow defects:

- 🟡 **`/coach/environment/passbook-check`** claims "nothing behind this field yet," but `pilot/passbook` + `pilot/passbook/gaps` are real, working backend routes. Same PLACEHOLDER_MAP shape, not yet documented there.
- 🟡 **Two parallel athlete check-in mechanisms.** `POST /api/pilot/athlete/check-in` is real and working but has **zero frontend callers** — the athlete UI actually check-ins through `POST /api/pilot/sessions` instead. A code comment in `AthleteWorkspace.tsx` already flags this directly.
- 🔵 **`director/` is a signpost, not a role** — its only page is 44 lines explaining that real incident-center content moved to `/admin/escalations` and `/admin/safety-review`; there is no `director` role in the role enum. Intentional per its own comment, but the section name overpromises.
- 🟡 **`retro-lab` naming collision** — `/retro-lab` (internal theme scratchpad) and `/admin/retro-lab` (an unrelated QA workbench, `PunxsyEcosystemCore` + `DevToolsQAConsole`) share a name with no cross-reference.
- 🔵 **A disabled test wizard ships inside the production admin route tree** — `/admin/organizations/test` (env-flag gated, off by default) sits one path segment from the real `/admin/organizations`, inviting confusion.
- 🟡 **`drill-library` route has a real backend and zero callers** — both athlete and coach drill UIs call the plain `pilot/drills` route instead; looks like a superseded implementation nobody adopted.

### 2.3 Design-system compliance

Across all 126 pages: **81% reference real design tokens directly**, 73% use real component classes (`.badge`, `.tile`, `.frame`, `.stamp`), and 71% perform real data-fetching with explicit loading/error/empty states (a genuine strength — not a gap). Most of the remaining pages are thin wrappers around token-compliant components, not real non-compliance.

🟡 **The real gap is a 7-page "console" cluster** (`/shadow` — the flagship, all-role AI assistant page — plus `/coach/operations`, `/board/dashboard`, `/admin/macro-analytics`, `/admin/curriculum`, `/admin/communications`, `/admin/retro-lab`) using an entirely off-system dark/mono visual language. A dedicated audit (§11) traced this to a **regression, not a design-system gap**: a working "night room" console mode already exists and is used correctly on `/admin/shadow` and `/shadow/scout`. `/shadow` itself has a documented prior conversion pass whose specific claims (zero raw hex, emoji replaced with words) the *live file now contradicts* — meaning later feature work on that file was done from an unconverted base and never re-swept. The other 6 pages share identical copy-pasted off-system boilerplate (`bg-[#09090b] font-mono text-slate-300`), suggesting one batch of work bypassed the shell/room mechanism wholesale.

Kiosk tap-target compliance (`--tap`, 55px floor) spot-checked clean on `athlete/sign-in` and `AthleteWorkspace` — every button carries either the kiosk variant or an explicit override.

### 2.4 Fabricated/undisclosed data — dedicated sweep results

This warrants its own subsection given severity. A dedicated audit independently verified and **escalated** the initial finding:

- 🔴 **`/board/dashboard`** (`BoardViewportSwitcher.tsx`) — confirmed in full: hardcoded budget rows, a fabricated $89,500 grant pipeline, a fake meeting-minutes queue, a "Total Training Floor Minutes: 8720" figure with a **broken interaction** (clicking it opens a "Mandatory Reason for Manual Override" prompt whose Acknowledge button silently does nothing), and internal build-tracking tags (`[V-BOARD-PUBLIC]`, "Layer 22") leaking into rendered copy. Zero fetch calls anywhere in the file. **The team already knows**: `buildingMapCoverage.test.ts`'s own comment reads *"a board must not be shown invented figures"* — the principle is written down, just never enforced on this page. No in-app navigation links to it (mitigating exposure, but the route is fully live and directly guessable).
- 🔴 **`/admin/macro-analytics`** (`MacroCommandCenter.tsx`, new finding) — three named staff ("Avery Hall," "Jordan Pike," "Morgan Lee") with **fabricated SafeSport/background-check status text**, plus hardcoded org-wide athlete counts and "risk flag" figures presented as live. Same internal-tag leakage, same test-file comment ("figures are not the gym's") already on record internally. For a youth combat-sports nonprofit, fabricated safeguarding-clearance status is a distinct and more sensitive variant of this defect than budget numbers.
- 🟡 **`/operations`** — a collapsible "System Diagnostics and SHADOW Certification" panel, visible to every role including athletes and parents, renders a static "Signed & Active" certification stamp over specific safety-relevant claims (readiness clamps, RPE lockouts, role-isolation guarantees) that are not backed by any live check. Lower severity — tucked behind a closed toggle — but the framing ("Signed & Active") over decorative text is worth fixing.
- 🔵 **Confirmed genuinely honest, by contrast**: `/coach/operations` (`FloorOperationsDesk.tsx`) carries an explicit "Planned — Not Yet Implemented" stamp and the line "do not act on anything it shows" directly above its fabricated sample data — this is the pattern the other pages should have followed. `/admin/retro-lab` is also honest (a visible red "mock-only front-end simulation mode" banner, correctly admin/owner-gated). `admin/curriculum` (`CurriculumProgressionEngine.tsx`) is fully mocked with fake athlete names and a literal `issueMockBadge()` button but has **no disclosure at all** — grouped with the "needs a fix" set, not the honest set.

**Pattern verdict** (from the dedicated audit): this is a **cluster from one identifiable build batch** — sharing the same off-system styling, the same internal tag leakage, the same unfinished "Pending Coach Verification Flag" placeholder string — not a codebase-wide habit. The org's newer work is consistently disciplined about disclosing placeholder data; a handful of legacy prototype pages were flagged internally (in test-file comments) but never finished being fixed in the UI itself.

---

## 3. Backend / API wiring findings

228 API routes (225 under `api/pilot/**`), organized into ~20 domains (SHADOW 45 routes, admin 33, coach 13, platform 12, auth 9, profile 7, intake 7, video 6, board 6, and smaller domains down to 1-3 routes each).

- 🔵 **Frontend-to-backend wiring is clean.** A full sweep of ~324 `fetch()` call sites across the entire frontend found **zero calls to a missing route** — every single one resolves to a real `route.ts`.
- 🔵 **Access control is clean.** Every route calls a real auth helper; the only 10 routes with no principal-auth check are all correctly, deliberately public (login/activation entry points, the one documented unauthenticated write endpoint, two explicitly-scoped public reads, the Stripe webhook verified by signature instead of session, and the rate-limited public wall display). No gaps found in a systematic pass.
- 🔵 **The backend is unusually clean of stub/mock markers.** A full grep of all non-test backend files for TODO/FIXME/mock/stub/hardcoded/fake turned up only one real instance: `api/document-ingest`'s `PPBF_INGEST_MOCK_MODE`, which is **honestly self-disclosed** as an ops-readiness warning and has no frontend caller (CLI-only).
- 🟡 **A family of real, working, intentionally API-only endpoints has no console.** The platform/organizations and platform/users mutation family (§0 #3) is deliberate, per its own code comments ("platform_owner only... not yet a console workflow") — but it's still a gap for the tier that most needs a console.
- 🟡 **Several real backends have no frontend caller at all**, beyond the ones already covered: `passbook`/`passbook/gaps` (real, but the linked page claims otherwise — §2.2), `floor-hours/public` (a deliberately hardened public endpoint nothing on `/public` displays), `publications/library` (nothing reads back the list of published videos), `intake/review-queue`, `workout-templates`. These read as backend-ahead-of-frontend build order, not security issues.

---

## 4. Capability status matrix (200+ modules)

**The single most important framing point:** the 200+ module capability tracker (`PPBF_CAPABILITIES.json`, `docs/capabilities/expanded-200-index.json`, `docs/capabilities/expanded-200-backlog.csv`) is **entirely disconnected from the running application**. `governance.active` is `false`; a repo-wide search for any of these three files being read by `apps/web` returns nothing. A row marked `DONE` changes nothing a coach, athlete, parent, or board member sees — it is a planning/self-audit artifact layered on top of the real codebase.

**Current counts** (201 total modules, verified programmatically): **94 DONE, 101 DRAFT, 6 DEFERRED.** Of the 94 "DONE," only **5 carry `ManualVerification: PASSED`** (Safety Gate System, Coach Review System, Goal Management System, Safety Review Engine, Pain/Symptom Flag Engine). The rest range across three distinct quality eras:
- **Waves 1-8 (all dated 2026-08-03):** mechanical one-line stamps, no cited files — 53 of the 94 DONE rows.
- **Wave 9 "register reconciliation" (2026-08-15):** a real, evidence-cited re-audit that explicitly confirmed **113 of the then-remaining modules as "registry-name strings only — nothing built."**
- **2026-08-16 individual builds:** real, dated, cited commits (Coach Intelligence Engine, Coach Cue Library, program phases, community service tracker, the "register bar" batch, etc.) — roughly 20-30 modules with genuine evidence trails.

### Domain breakdown

| Domain | Modules | DONE | Notable |
|---|---|---|---|
| Core Athlete Record, Routing & Data Quality | 22 | 21 | Strongest domain — Athlete Profile/Passbook, Goal Management (verified), Audit Trail |
| Physical Training & Combat Engines | 54 | 16 | 38 still draft; **all 7 Swim/Water Confidence modules are 0% built** (§0 #5) |
| Learning, Mental & Safety Engines | 31 | 9 | Only the core Safety Gate + Pain Flag are verified; Water Safety Gate, Breath-Hold Restriction, Stop/Hold/Regress, Unsafe Behavior Flag, Guardian Safety Report all still blank scaffolds |
| Stakeholder Portals & Program Ops | 43 | 30 | Best-covered stakeholder domain; Coach Intelligence Engine ("The Morning Read") is real and shipped |
| Governance, Trust & AI Guardrails | 26 | 15 | Includes the unwired Consent/Waiver Tracker (§0 #7) |
| Advanced/Future | 25 | 3 | Correctly, deliberately deferred (digital twin, predictive ML, etc.) |

**Discrepancies worth flagging:** the JSON files are frozen 2026-08-03 snapshots (never regenerated); only the CSV moved. Module 201 (Gear Vendor Records) exists in the CSV but not in the two JSON files — tracker drift. Module 001's own audit log records an unresolved contradiction: its Passbook API's role allowlist includes `parent` and would hand a linked guardian the full coach-observation session log, while the live `ParentDigest` component deliberately withholds exactly that — not exploited today only because no page calls the API yet.

---

## 5. Database & infrastructure

**162 tables + 13 views** across 88 migration files (1 base schema + 87 incremental), applied in a hand-maintained dependency order inside `.github/workflows/apply-migrations.yml`. Domain breakdown: SHADOW/AI is the largest slice (~40 tables, ~25%), followed by training/drills (14), safety/escalation/clearance/compliance (13), scheduling/attendance (10), athlete/family records (~10).

- 🟡 **Isolation is application-layer only.** Zero `ROW LEVEL SECURITY`/`CREATE POLICY` statements anywhere in the schema; 159 of 162 tables carry `organization_id`, mostly via composite primary/foreign keys that do give a real DB-level guarantee against a *cross-tenant reference*, but nothing stops an application query that simply omits the `organization_id` filter. The guarantee rests entirely on `access.ts` discipline, not the database.
- 🟢 **Migration hygiene is genuinely strong.** Every migration file has a matching runner script and vice versa, self-enforced by a CI job that fails on drift. Exactly one true `DROP TABLE` exists in the entire history, and it is unusually well-guarded (documented zero-reference audit, explicit owner sign-off, `if exists` not `cascade`, base-schema file updated in lockstep so a fresh environment can't recreate the dropped tables).
- 🟡 **Confirmed: clearance register is real, orphaned schema.** `pilot.clearance_types`/`pilot.person_clearances` plus a 223-line server module exist, well-designed (role-graded activity scopes, a `CHECK` constraint forcing verifier+date on any "current" clearance) — imported by **nothing except its own test file**. No route, no page.
- 🟡 **Confirmed: `pilot.transfer_claims` is even more orphaned** — has schema, a seed pipeline, and a dedicated contract test, but **no server module and no API route at all**.
- 🔵 **Confirmed: curriculum has no schema at all**, not merely an unwired one — categorically different from the clearance case. No table, no server module; `/admin/curriculum` is a pure frontend mock end to end.
- 🔵 **Confirmed: payments ledger tables exist as designed placeholders** — `payment_accounts` is genuinely wired (Stripe Connect onboarding); `payment_transactions`/`payment_subscriptions` are empty, deliberately unwired mirror tables per the payment slot's own design, matching `docs/current/ACTIVE_WORK.md`'s BLOCKED status exactly.
- 🔵 **Confirmed: zero water/swim safety schema presence** — no table, column, or comment anywhere matches swim/water/aquatic/pool. Matches the capability tracker's "0% built" claim at the schema layer too — a documented-but-never-started domain.
- 🟡 **Inert privacy-denylist entry.** `privacyTiers.ts`'s `PUBLIC_SURFACE_FORBIDDEN_TABLES` list contains `'pilot.compliance_records'`, which matches no real table (the real tables are `compliance_rules`/`compliance_violations`); every sibling entry correctly prefix-matches a real table. This entry can never fire — likely a typo for the safety-sensitive `compliance_violations`.

### CI/CD, testing, and operational health

- 🟢 **Test coverage is dense exactly where it should be.** 575 test files against 582 non-test source files (roughly 1:1). Every safety-critical module checked (`access.ts`, safety gates, payments, PIN/credential policy, SHADOW guardrails) has direct, paired test coverage, including a distinct Postgres-integration test tier (`*.pg.test.ts`) with its own meta-test policing the convention.
- 🟢 **Deploy gates are well-guarded**, with unusually candid in-file documentation of a real 2026-08-07 incident (a false migration attestation) that led to an added automated schema-verification step — a good transparency signal, though it also confirms the human-attestation pattern is a known-weak point.
- 🔴 **`document-ingest` is broken as configured.** ~13 required environment variables (Dataverse, Graph/SharePoint, Google service account) are undocumented in `.env.example` and unset in both deploy workflows; the mock-mode bypass flag is also unset in both. As currently deployed, this route throws on every real invocation.
- 🟡 **No infrastructure-as-code for the core platform.** `infra/main.bicep` provisions only the SHADOW research-bridge subsystem; the primary app/database Container Apps (referenced everywhere by name) have no Bicep definition in this repo — a real reproducibility gap.
- 🟡 **Retention automation overstated in its own policy doc.** `docs/DATA_RETENTION.md` describes an automatic daily hard-delete and cites a script name (`pilot:cleanup-expired-data`) that doesn't exist in `package.json` (the real script is `pilot:cleanup-deleted-data`). The actual mechanism runs nightly as a **dry run only**; real deletion requires a human to manually dispatch the workflow — arguably the safer design, but the compliance document (which claims FERPA/COPPA/GDPR scope) currently misdescribes it.
- 🟢 **Backups are genuinely automated and verified** — nightly `pg_dump`, row-count verification before upload, 90-day/14-backup floor retention, round-trip blob-size verification. A real strength.
- 🔵 Windows-oriented PowerShell tooling (16 of 22 `scripts/` files) is confirmed disconnected from the actual Linux-only CI/CD path — convenience tooling, not a defect, but a friction point for non-Windows contributors and unclear whether it's still current.

---

## 6. SHADOW AI subsystem

SHADOW (chat assistant, evidence-cited responses, video analysis, safety escalation, coach intelligence) is, on inspection, **the most mature and best-guarded subsystem in the app**. Every checked route is real and DB-backed, not a stub.

**What's live:** a full dual-tier chat pipeline (fast "Quick Round" vs. async "Heavy Bag") with real citation enforcement — any stated quantity lacking an authorized evidence citation is discarded before the user sees it, verified in code, not just documented. Video upload/review workflow with quarantine-by-default and non-overridable malware verdicts. Film Study (AI video observation) that never touches an athlete record directly — output lands as a proposal a coach must accept or reject. Deterministic (non-ML) gap suggestions requiring coach confirmation before an athlete ever sees one. Coach Intelligence Engine v1 ("The Morning Read") — five deterministic, named-threshold reads, explicitly "no ML, no scores, no predictions." A guarded research-evidence import pipeline that leaves everything `pending_review` until a human approves.

**Doctrine enforced in code, not just documentation:** platform_owner is explicitly excluded from the medical-status role set (verified directly in the route); board is confirmed excluded from SHADOW chat; guardian media consent gates Film Study through the same check used for video publication; a fail-closed 503 (not a confusing 500) fires on any unmigrated environment.

**What's deliberately parked, with stated re-open conditions:** per-skill AI video scoring (owner: "Human Film Study IS the analysis pathway; shipping machine scores about minors' athletic ability without proven accuracy is the risk being refused"), publication automation, wearables/biometric integration, several smaller backlog items — each with an explicit condition for revisiting.

**Research/decisions still needed:**
- 🔴 An ML scoring approach with explicit evidence standards (the named re-open condition for parked video scoring).
- 🔴 **The AAP/CPS pediatric-medicine opposition to youth boxing** — the evidence registry's own conflict ledger marks this "ESCALATE TO BOARD AND MEDICAL ADVISOR... do not proceed with youth contact expansion until this exists." This is not a code task; it needs a board/medical-advisor decision.
- 🟡 Reconciling `SHADOW_ML_ARCHITECTURE_SPEC.md` (still calls Scout Reports "not implemented") against the actual shipped mechanism (a working path through the chat endpoint's `sessionType` override) — code has moved ahead of the doc here.
- 🟡 A governance/privacy/evaluation process for the fine-tuning pipeline (currently a disabled gate with no defined process to satisfy it).
- 🟡 Measurement of the SHADOW response over-filter rate against its stated <1% target — tracked as an open issue, not yet delivering a number.

---

## 7. Forms & materials inventory

### In-app digital forms — status

| Form | Route | Status |
|---|---|---|
| Public interest / intake | `/public` | 🟢 Working, DB-backed |
| Guardian consent grant/withdraw | `/parent/consent` | 🟢 Working, DB-backed |
| Consent/waiver recording | `/admin/consent` | 🟡 Working but metadata-only — records *that* a paper/verbal waiver was signed, not the waiver itself |
| Activation / PIN issuance | `/activate`, `/admin/pin`, `/admin/activation-codes` | 🟢 Working end-to-end, no stub steps |
| Volunteer management | `/admin/volunteer-management` | 🟡 Real CRUD, but `background_check_status` is free text that **gates nothing** |
| Grant obligations (internal) | `/admin/grants` | 🟢 Working, internal-tracking only — external grant packet explicitly deferred |
| Safety escalations/flags | `/admin/escalations`, `/admin/safety-flags` | 🟢 Working, mandatory resolution notes enforced |
| Video/portrait compliance review | `/admin/video-compliance`, `/admin/portrait-review` | 🟢 Working approval flows |
| Board seat assignment | `/admin/board-seats` | 🟢 Working, DB-enforced one-primary-per-seat |
| Sports-medicine clearance | `/coach/sports-medicine` | 🟡 Read-only display; the setter API exists but **no page calls it** |
| Curriculum | `/admin/curriculum` | 🔴 **Fully mocked** — zero API calls, fake athlete names, a literal `issueMockBadge()` button, nothing persists |
| Consent/Waiver Tracker (module 151) | (API only) | 🔴 Real write API, **zero UI screen** — consent recordable with no human in the loop |
| Clearance register (background check/SafeSport) | (schema + server module only) | 🔴 Real, well-designed, **completely unreachable** — no route, no page |

### Gaps — likely missing entirely

A systematic search (codebase + docs) found **no trace anywhere** of:
- 🔴 A medical intake form (allergies, medications, chronic conditions) — the only medical surface is a coarse cleared/restricted/pending status with no UI to set it.
- 🔴 Liability waiver or medical-release **text or e-signature capture** — only metadata logging of an off-platform paper/verbal waiver.
- 🔴 A SafeSport / MAAPP abuse-prevention acknowledgment flow, or a code-of-conduct acknowledgment a family/staff member actually signs — "Code of Conduct" exists only as an automated behavioral-monitoring rule name.
- 🟡 A background-check verification path connected to anything (the real clearance-register schema built for exactly this has no UI).
- 🟡 A printable/digital emergency contact card.
- 🟡 W-9, insurance certificate, or 501(c)(3) determination — not expected to live in a code repo, but confirmed absent as content (only referenced as prerequisites).
- 🟡 A grant application/reporting packet for external funders (explicitly deferred).

### What the platform does generate

Real, working: a member "fight card" and milestone certificate (`/print`), a roster CSV export (explicitly, honestly scoped — "no medical intake, waivers, attendance, session records, coach reviews or pain reports... there is no screen that exports them today").

---

## 8. Prior-audit synthesis (2026-07-18 → 2026-08-16)

Four dated internal audits were read and cross-checked against current source and `docs/current/ACTIVE_WORK.md`, per this repo's own doctrine that dated audits are historical evidence, not current truth.

**Recurring, unresolved-until-recently themes** (found in 3+ independent audits):
1. **The kiosk tap-target accessibility floor keeps regressing** — three successive fix sweeps each missed a different subset of undersized controls.
2. **The contrast sweep (`npm run sweep`) has never actually been run** in any documented conversion batch — it requires a live dev server, and every batch recorded skipping it.
3. **"Capability exists, no way in"** — features built with a real backend and zero navigation entry point, recurring across `/admin/athletes`/`/admin/export`/`/coach/drills` (now fixed), the SHADOW chat inline-answer gap, and (per this audit) the Omega platform-admin endpoints and several orphaned routes documented above.
4. **Schema-mutation-from-HTTP-route** appeared twice in unrelated commits five days apart (a live DDL migration route, then a `create table if not exists` inside an unauthenticated login handler) — both fixed, but the recurrence suggests this class of mistake is easy to reintroduce.
5. **"Deployed" being conflated with "verified"** — self-acknowledged and still open: `docs/current/PRODUCTION_STATE.json` (2026-08-16) lists T-001, T-002, all of PR #238's surfaces, and both August release waves as `deployed_not_runtime_verified`.

**Findings confirmed already resolved** (contradicted by current source, listed here only for completeness): the drill library's empty-render bug, a cross-org PIN-reset privilege bug, pain reports/session notes being silently discarded, a live DDL-over-HTTP route, unbounded video quarantine, coach-roster DOB/emergency-contact over-exposure — all independently source-verified as fixed.

**Findings likely still open, not yet re-tracked:** the SHADOW response validator's two known unsafe-advice patterns (deliberately left unfixed per the original audit to avoid over-filtering — worth a fresh look), the `/public` program catalog never having been verified against what the gym actually offers, and the production resource group's misleading legacy name (`rg-ppbf-enterprise-staging`, confirmed still true as of 2026-08-16).

---

## 9. Needed research (consolidated from Google Drive)

The organization's Drive contains a `RESEARCH_GAPS` document tracking 56 numbered open items across 7 sweeps (most recently 2026-08-17). Highest-value open questions:

- 🔴 **Boxing-specific evidence is thin everywhere** — the platform's motor-learning citations lean on general (often golf-heavy) literature; PPBF has almost no boxing-specific retention/transfer data of its own.
- 🔴 **Nothing in SHADOW is calibrated** — the Quick/Heavy routing classifier's confidence number, retrieval weights, and pattern-engine thresholds are all uncalibrated heuristics, explicitly logged as "owner-signoff debt."
- 🟡 **ACWR and Banister fitness-fatigue formula constants are contested in the literature itself**, not just uncalibrated for PPBF — the research doc flags specific papers arguing against using ACWR to drive training decisions at all.
- 🟡 A hard-fought competitive loss currently **can't become learning evidence** — `evaluateValidatedAthleteLesson` rejects a "miss" outright, flagged as a real architecture gap for coach/athlete learning.
- 🟡 No donor/constituent CRM, no facility/asset lifecycle tracking, no governance meeting/vote lifecycle system, no outbound-communications delivery system — all named as core data-model gaps, not calibration issues.
- 🟡 Economics: no willingness-to-pay data for partner gyms, no IRS-990 peer cohort defined yet, AI vendor pricing noted as internally inconsistent even within one vendor's own documentation.

**Important framing finding:** the organization's "PPBF Clean-Sheet Redesign" effort in Drive has produced substantial research (5 populated folders) but **its architecture/target-design/roadmap/handoff folders are still empty**, despite an internal project index declaring the "competing architecture candidates" phase open since 2026-08-15/16. If this audit's findings feed into a redesign conversation, it should be stated precisely: **no target design exists yet** — only research inputs to one. There are also no wireframes or UI mockups anywhere in Drive for that effort.

**Coaching-content corpus status:** five v3 source manuals (Coach Commands/Corner Shorthand, Safety and Risk Management, Youth Development/Motor Learning, System Core, Glossary) exist as finished documents and are staged for SHADOW ingestion — but the corpus's own README states roughly 40 more topical manuals (drills, padwork, sparring architecture, conditioning) are still queued and not yet written. The Safety manual's specific operational rules (stop-on-dizziness, contact-progression gates) are, by the evidence inventory's own admission, **policy/judgment text, not evidence-cited** — worth knowing before SHADOW cites them as authoritative.

---

## 10. Documentation & governance integrity concerns

Several documents in the repo and Drive currently **overstate or misstate** the state they describe — worth a cleanup pass in its own right, since stale documentation is exactly what causes a future builder (human or AI) to trust something that isn't true:

- 🟡 `docs/FRONTEND_STYLE_CONTRACT.md` states "the migration is complete... every route page and shared component speaks the design system" — directly false given the 7-page console cluster in §2.3.
- 🟡 `docs/DATA_RETENTION.md` describes automatic daily hard-deletion and cites a non-existent script name; actual deletion requires manual dispatch (§5).
- 🟡 `docs/MULTI_ORG_MIGRATION_RUNBOOK.md` still lists three tables (`pilot.staff`, `pilot.messages`, `pilot.skills`) that were later dropped by a subsequent migration.
- 🟡 `apps/web/src/design/PAGE_MAP.md` documents only half the app's current routes (§2.1).
- 🟡 Two Drive documents, both titled `SHADOW_ML_ALGORITHM_STACK.md`, both marked "Accepted," created one minute apart on 2026-08-14 — no reconciled canonical version exists.
- 🟡 `docs/capabilities/expanded-200-index.json` and `PPBF_CAPABILITIES.json` are frozen 2026-08-03 snapshots that no longer reflect the (also imperfect) living CSV tracker.
- 🟡 Four orphaned git bundles in Drive represent real coach/athlete-workspace UX engineering work outside the normal git remote, with unknown merge status — worth a direct check against repo/PR history by whoever has full GitHub access, since this audit's Drive research could not extract or read their contents (sandboxed).

---

## 11. Prioritized recommendations

**P0 — integrity/safeguarding, small fix, do first:**
1. Fix or delete `/board/dashboard` (`BoardViewportSwitcher.tsx`) — either add the same honest disclaimer stamp `FloorOperationsDesk` carries, or delete it outright since the real `/board` hub already covers this role more completely and honestly.
2. Fix or delete `/admin/macro-analytics`'s fabricated staff SafeSport/background-check status — this is the more serious of the two fabricated-data findings given the safeguarding context.
3. Either wire the Consent/Waiver Tracker's write API to a real UI screen, or remove/gate the unwired API so guardian consent can't be recorded with no human involved.

**P1 — safety-domain scoping, needs an owner decision, not just code:**
4. Decide the status of Swim/Water Confidence programming: if PPBF runs or plans water-related activity, this is a 0%-built safety domain (no schema, no code, no UI) that needs explicit prioritization or an explicit "not offered" decision.
5. Escalate the AAP/CPS pediatric-boxing-opposition research conflict to the board and medical advisor, per SHADOW's own evidence registry's flag — this is a live governance question already identified by the platform's own research pipeline.
6. Scope and build (or explicitly defer with a stated reason) a real medical intake form, liability-waiver e-signature capture, and SafeSport/code-of-conduct acknowledgment flow — none currently exist anywhere in the app.

**P1 — Omega/governance layer:**
7. Build console UI for the six audited platform-admin endpoints with no UI (promote/transfer/demote org admin, org status toggle, platform user management) — today they require a direct API call.
8. Fix the `document-ingest` integration's missing environment variables (or explicitly disable/hide the feature until it's configured) so it stops throwing on every real invocation.

**P2 — cleanup, real but not urgent:**
9. Port the 7-page design-system "console" cluster back to the existing `room--night` mode (a working spec already exists from the prior conversion pass on `/shadow`).
10. Correct the stale documentation identified in §10 (style contract, data retention, migration runbook, page map) so they describe current behavior.
11. Reconcile or delete the duplicate `SHADOW_ML_ALGORITHM_STACK.md` documents in Drive.
12. Wire or archive the two confirmed-orphaned real backends (clearance register, transfer claims) — both have working schema and tests with zero reachable UI.
13. Fix the inert `'pilot.compliance_records'` entry in the public-surface privacy denylist (§5) — likely meant `pilot.compliance_violations`.

**P3 — lower urgency:**
14. Investigate the four orphaned git bundles in Drive against current repo/PR history to determine whether that coach/athlete-workspace UX work needs to be recovered.
15. Add Bicep/IaC coverage for the core platform (currently only the research-bridge subsystem is defined as code).
16. Operationalize the contrast sweep (wire `npm run sweep` into CI or a documented pre-merge step) and do one more full kiosk tap-target pass given three prior sweeps each missed a different subset.
17. Rename the production resource group away from its legacy `rg-ppbf-enterprise-staging` name.
18. Give the coach workspace an in-context sub-nav (or a deliberate decision that global search is the intended discovery path) — 21 of 25 real coach pages are reachable only that way today.

---

## 13. Addendum — reconciliation with the concurrent capability-network audit, and follow-up fix status

A separate capability-network audit ran concurrently with this one (8 agents mapping 34 capabilities as a read/write graph, plus a cross-cluster pass and a verbatim-quote validation step; published as its own report, status pinned to `origin/main` at `04dd116b` and open PRs as of 2026-08-17 23:30 UTC). Rather than duplicate its content here, this section reconciles the two and records what this session actually fixed in response to both.

### Not duplicated — already fixed, in review, or owned elsewhere

Checked against `is:open`/recently-merged PRs before touching anything. The following findings from this report are already closed or actively in review by other sessions and were deliberately **not** re-fixed here:

- Board-dashboard and macro-analytics fabricated data, the production resource-group name bug, and the magic-link origin bug — **PR #422** (green CI, clean, ready to merge — not merged by this session; merging another session's PR wasn't this session's call to make unilaterally).
- Document-ingest reporting "configured" without checking real destinations — **PR #412** (has a merge conflict to resolve).
- Nine other capability-network findings (Coach Intelligence missing safety-escalation/compliance-violation signals, video-scan-refusal auto-escalation, Film Study consent gate, compliance auto-escalation, competition/league withdrawal actions, research submission-review panel, volunteer-roster/login link, transfer-check-failed progression rule) — **PR #447**.
- Twelve additional findings the capability-network report lists as closed since publication (film-study consent, video-scan escalation, competition-loss progression linkage, transfer-failure gaps, performance-analytics role gate, research-source UI, competition/league withdrawal, session-run link, volunteer/login link, cross-org privilege flag, shadow-job authorization N+1, incident double-filing) — **PRs #438, #439, #441, #442, #443, #444, #445, #446, #448, #449, #431, #433**, all merged.
- Eight more in the capability-network audit's own "in review" list (competition-entry consent gates #452, Morning Read safety-register blind spot #450, Film Study rejected-proposal citability #459, cross-athlete progression race #460, portrait-review-without-image #461, revenue-center fabrication #462, the gate-inventory documentation set #463, and an unopened branch for lapsed-membership flagging).

### Fixed by this session, in this PR

- The inert `pilot.compliance_records` entry in `privacyTiers.ts`'s public-surface denylist (real fix — see the "Fixed" commit in this PR).
- Four stale documentation files corrected to match current source (`FRONTEND_STYLE_CONTRACT.md`, `DATA_RETENTION.md`, `MULTI_ORG_MIGRATION_RUNBOOK.md`, `PAGE_MAP.md`).
- Three additional bounded fixes picked up from the capability-network audit's "found since" and "still open — unclaimed" sections, none claimed by any other open PR at the time of picking them up:
  - The stale `Source` column on `/admin/escalations` rendering blank for the newest safety-escalation source types.
  - A login-route test named for verifying durable-store-outage tolerance that never actually simulated an outage.
  - A misleading invariant claim in `coachIntelligence.ts` — two attendance rules documented as "never drift apart" that in fact used different comparison operators and disagreed at the exact-half boundary.

  (Status of each — fixed, or found to need a different call than a code fix — is recorded in this PR's own description and commit history, since agent work on these was still in flight when this addendum was written. Check the PR for final disposition.)

### Escalated, not fixed — needs an owner decision

The capability-network audit surfaced one finding more urgent than anything in the original report's own punch list, and it is **not** fixed here on purpose: **guardian links accept an unvalidated `parent_id`.** The athlete side of a guardian-link write is access-checked (`assertActorCanAccessAthlete`); the parent/guardian side is not checked at all. A coach with legitimate standing on one athlete in an organization can attach *any* guardian account in that same organization to that athlete, and the attached guardian's account then reads the child's training holds, messages, and safety surfaces. Cross-organization attachment is blocked by existing checks; cross-family attachment within one organization is not. The correct fix narrows a role gate coaches use routinely, which is exactly the class of change this repo's own contributor guardrails reserve for an explicit owner decision rather than an autonomous fix — so it is reported here, not patched.

### What this reconciliation adds beyond either report alone

The capability-network audit's most important methodological finding is worth repeating here rather than only in its own document: **parallel delivery produces defects neither audit, nor any single PR's CI, can see** — an exhaustive `Record<Union, …>` type broke `main` three times in one day because a union grew on one branch while its exhaustive map grew on another, invisible to per-PR review and passing CI on each branch individually; two auto-escalation features merged the same day and would have double-filed one incident into a coach's digest under two different vocabularies had the collision not been caught before merge. Both are structural risks (a missing "require branches up to date before merging" repository setting, and no habit yet of asking "who else reads this register" before adding a writer to it), not code defects this report's per-file findings would have surfaced on their own. Worth carrying into whatever process governs future parallel-agent work on this repository.

---

*Prepared as a read-only audit; no application code was modified in producing the original report above. A small number of follow-up fixes made afterward, and one escalated-not-fixed finding, are recorded in this addendum. Findings are traceable to specific files/routes/tables cited throughout — ask for any section to be expanded with exact file:line references from the underlying research passes.*
