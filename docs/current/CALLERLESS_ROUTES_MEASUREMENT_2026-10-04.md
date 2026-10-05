# Callerless routes and tables: measurement, 2026-10-04

**Status: COMPLETE (measured 2026-10-05).** Build List row "Callerless routes
and tables: measure each, then park or delete", `docs/current/ACTIVE_WORK.md`;
OD-2026-10-03-002 section 12. Nothing here is deleted. Jason decides per item;
each deletion is its own lane.

Measured at `main` SHA: `5640f890b60b2d22602fb3a388626fb32e9e1b43`

Evidence level: code reading only (`git grep` over the whole repository,
excluding `docs/`, plus reading each route). No production row counts were
taken (overwatch GO, 2026-10-05: code only).

## The criteria (OD-2026-10-03-002 section 12)

"Park each callerless route and table with a re-open condition; delete only
what is clearly obsolete, never a route that may be waiting for its screen."
Each item is marked **PARKED** (with a re-open condition), **PLANNED UI**, or
**OBSOLETE**. The UI is not finished, so the fact that no page calls a route is
not on its own evidence that the route is unwanted.

"Caller" below means a `fetch` from `apps/web/app/**` pages or
`apps/web/components/**`, a script, a workflow, or an external service in this
repository. Tests and the runtime probe manifest are listed separately; they
are not callers.

## Summary

| # | Item | Callers (non-test) | Tests | Mark | Recommendation |
|---|---|---|---|---|---|
| 1 | `shadow/library/search` | none | none on the route; domain function tested | PLANNED UI | Park |
| 2 | `shadow/library/capability-coverage` (GET reads) | GET: none. POST: seed script | route test + pg suites | PLANNED UI | Park |
| 3 | `admin/retraction-checks` | none; its table is written only by an unwired script | none on the route; domain pg test | PARKED | Park |
| 4 | `drills/proposals` + `proposals/review` | none | both routes tested | PLANNED UI | Park |
| 5 | `drills/lineage` | none | route tested | PLANNED UI | Park (with item 4) |
| 6 | `floor-plans` | none, and tests pin that none exists | route test + deletion and AI-absence tests | **OBSOLETE** | Delete the route (own lane); table data is a separate decision |
| 7 | `progression/gap-justification` | none | route test | PLANNED UI | Park |
| 8 | `shadow/research-bridge/session-export` | none; 404 on production by design | route test | PARKED | Park |
| 9 | table `pilot.drill_version_outcomes` | no reader or writer in app code | constraint tests only | PARKED | Park |

One item is clearly obsolete (6). The rest are wired, gated and mostly tested,
and wait on a screen or a decision that has not been made yet.

## Items

### 1. `app/api/pilot/shadow/library/search` (POST)

- **Gate:** `requirePrincipal` then `requireRole(SHADOW_PROJECTION_READ_ROLES)`,
  `apps/web/app/api/pilot/shadow/library/search/route.ts:19-20`. Scope limited
  to `scoped` | `subject`; the old `master` scope is gone (`route.ts:10-15`).
- **Callers:** none in pages, components, scripts or workflows. Only
  reference outside the route: runtime probe `PR-238z` (unauthenticated 401),
  `apps/web/scripts/runtime-probes.manifest.mjs:458`. The two library endpoints
  pages do call are `sources` and `review-flags`.
- **Tests:** no route test. The function it wraps, `searchShadowLibrary`
  (`src/server/pilot/shadowLibrary.ts`), is live: the `chunks`, `claims`,
  `documents` and `sources` routes and `shadowEvidence.ts` call it, with tests
  in `shadowLibrary.test.ts` and several `.pg.test.ts` suites.
- **Tables:** reads the library tables through `searchShadowLibrary`; writes nothing.
- **Mark: PLANNED UI.** A 60-line wrapper over a live, tested function.
  Deleting it saves almost nothing. **Re-open condition:** a search box on
  `/research` or the coach library. If that screen is dropped, delete it then.

### 2. `app/api/pilot/shadow/library/capability-coverage` (the GET reads)

- **Gate:** `requireRole(SHADOW_LIBRARY_CURATOR_ROLES)` on GET and POST,
  `route.ts:43` and `route.ts:56`. Shelf resolved by `libraryShelf.ts`.
- **Callers:** GET has none. POST is called by the seed script
  `apps/web/scripts/seed-shadow-library.mjs:354` (upsert rule) and `:373`
  (`action: 'recompute'`), run as `npm run seed:shadow:library`
  (`apps/web/package.json:121`). The route comment says so: "POST carries two
  operations because the seed script calls it both ways".
- **Tests:** `capability-coverage/route.test.ts` (246 lines);
  `shadowLibraryPipeline.pg.test.ts:227,578-756`;
  `shadowLibrarySeedCoverage.test.ts:29`;
  `platformLibraryWriteScope.convention.test.ts:252`.
- **Tables:** `pilot.shadow_library_capability_map` (rules) and the research
  requirements that recompute opens and closes. Writers: this route's POST,
  reached from the seed script. Reader: this route's GET.
- **Mark: PLANNED UI.** The coverage view ("does the Library hold enough
  authority to speak on this capability") is a curator screen that has not
  been built. The POST half is in use. **Re-open condition:** the platform
  shelf or curator screen is built (OD-2026-10-03-002 section 2). Deleting
  only the GET would leave the seed script writing rules nobody can read in
  the app.

### 3. `app/api/pilot/admin/retraction-checks` (GET, PATCH)

- **Gate:** `requireRole(['organization_admin','admin','platform_owner'])`,
  `route.ts:18,45,90`. Every PATCH writes an audit event.
- **Callers:** none. Runtime probe `PR-238ab` only
  (`runtime-probes.manifest.mjs:487`).
- **Tests:** no route test. Domain module tested in
  `src/server/pilot/sourceRetractionChecks.pg.test.ts`.
- **Tables:** `pilot.source_retraction_checks`. Written only by
  `apps/web/scripts/check-source-retractions.mjs:291` (`npm run
  check:retractions`, `package.json:376`). That script is **unwired**: no
  workflow runs it, on purpose, because it calls NCBI and CrossRef and needs an
  operator-supplied `--csv` registry. The comment says "surveillance belongs
  on a schedule … deliberately not made here"
  (`.github/workflows/evidence-corpus.yml:49-57`). The route's PATCH also
  calls `suppressSource`, which is shared with live code
  (`rabbitHoles.ts`, `libraryServability.ts`).
- **Mark: PARKED.** The route is the human half of retraction surveillance,
  and the machine half has never been scheduled. **Re-open condition:**
  a decision to run `check-source-retractions.mjs` on a schedule against a
  chosen registry. Without that, the table has no rows and no screen is worth
  building. If surveillance is ruled out, delete the route, script and
  migration together.

### 4. `app/api/pilot/drills/proposals` (GET, POST) and `proposals/review` (POST)

- **Gate:** proposals: `requireRole(['coach','organization_admin','admin'])`,
  `route.ts:222,256`. Review: `adoptDrillChangeProposal` and
  `declineDrillChangeProposal` each call `requireEvidenceReviewer(role)`
  themselves (`review/route.ts:16-19`). Review is on the route-gate allowlist
  (`routeGateDeclaration.convention.test.ts:448`).
- **Callers:** none. `/coach/drills` calls `/api/pilot/drills`,
  `/drill-library` and `/drills/promote` only (`app/coach/drills/page.tsx:328,352,430,521,564,611,656`).
- **Tests:** `proposals/route.test.ts` (347 lines), `review/route.test.ts`
  (282), `drillVersioning.test.ts`, `drillVersioning.pg.test.ts`,
  `assignmentDrillInstruction.pg.test.ts`, `drillLifecycle.pg.test.ts`,
  `referenceDrillVersions.pg.test.ts`.
- **Tables:** `pilot.drill_change_proposals` (writer: `proposeDrillChange`,
  only from this route; reader: `listDrillChangeProposals`, only from this
  route). Adopting a proposal writes a new `pilot.drills` version.
- **Mark: PLANNED UI.** This is the drill-refinement lifecycle, built from a
  full spec and deployed to production (PR-238w, `docs/current/WORK_QUEUE.md:133`).
  It has no screen yet. It is also the tool Jason's parked reference-drill
  audit would use (OD-2026-10-03-002 section 7: "many too simplistic").
  **Re-open condition:** a propose/review panel on `/coach/drills`, or the
  reference-drill audit lane starting.

### 5. `app/api/pilot/drills/lineage` (GET)

- **Gate:** same role set as proposals, `route.ts:14-17,38`.
- **Callers:** none. `drillLibraryV3.ts:615` mirrors `getDrillLineage` in a
  comment and does not call it.
- **Tests:** `lineage/route.test.ts` (89 lines); `drillVersioning.pg.test.ts`.
- **Tables:** reads `pilot.drills` by `lineage_id`; writes nothing.
- **Mark: PLANNED UI**, as part of item 4. The comment at `route.ts:11-14` gives
  its purpose: a reviewer deciding a proposal needs the version history.
  **Re-open condition:** the same as item 4. Keep it or delete it with item 4.

### 6. `app/api/pilot/floor-plans` (GET, POST, PATCH) — OBSOLETE

- **Gate:** GET and POST `requireRole(['organization_admin','admin','coach','athlete'])`
  plus `assertActorCanAccessAthlete`, `route.ts:41,105,131`. PATCH is for
  athletes only, `route.ts:203`.
- **Callers:** none, and tests check that none comes back:
  - The athlete check-in no longer POSTs a plan: "Check-in builds nothing. It
    used to generate a plan … The Floor is now the work a coach assigned
    (A-FIN-04)", `components/AthleteWorkspace.tsx:1652-1656`. Pinned by
    `components/athleteWorkspace.test.tsx:1904-1911,2032,3273`
    (`floorPlanCalls()` has length 0).
  - The coach "Athlete Floor Plans" tab was removed because every plan was
    auto-generated from the unvalidated readiness slider under a
    client-supplied name ('Current Athlete'), and "Nothing coach-authored ever
    wrote to pilot.athlete_floor_plans", `components/CoachWorkspace.tsx:3860-3872`.
    Pinned by `components/coachWorkspaceHonesty.test.tsx:668-691`.
- **Tests:** `floor-plans/route.test.ts` (217 lines);
  `deletionScopeB.pg.test.ts:95,435,756-763`;
  `aiRuntimeAbsence.test.ts:4,188`.
- **Tables:** `pilot.athlete_floor_plans` (`infra/azure/pilot_slice_postgres.sql:871`).
  This route is its only reader and writer in app code.
- **Mark: OBSOLETE.** Both of the route's consumers were removed on purpose
  and replaced (A-FIN-04, coach-assigned work), and the replacement's tests
  forbid calling it again. The CoachWorkspace comment says a future
  individualized-plan surface "starts from coach authorship and
  server-resolved identity, not this feed", so no screen is waiting for this
  route.
- **For the deletion lane:** remove the route and its test, then update
  `aiRuntimeAbsence.test.ts` and `deletionScopeB.pg.test.ts`. The table and its
  existing rows are a **separate** decision: rows written before A-FIN-04 are
  athletes' (including minors') readiness payloads, and dropping the table is a
  migration. It needs a read-only production count, then Jason's word on
  keep, delete or drop.

### 7. `app/api/pilot/progression/gap-justification` (GET)

- **Gate:** `requireRole(['coach','admin','organization_admin','athlete','parent'])`
  plus `assertActorCanAccessAthlete`, `route.ts:29,38`. The role set mirrors
  `/progression/gaps` on purpose (`route.ts:21-23`).
- **Callers:** none. `getGapJustifications` is called only by this route
  (`progression.ts:538` mentions it in a comment).
- **Tests:** `gap-justification/route.test.ts` (204 lines);
  `progressionSuggestions.test.ts`.
- **Tables:** reads the performance-analytics sources for one athlete; writes nothing.
- **Mark: PLANNED UI.** The "what" (`/progression/gaps`) is shown on three
  pages: `app/coach/progression-intelligence`, `app/athlete/progression-intelligence`
  and `app/parent/progression-visibility`. This route is the "why" next to it,
  and no page shows that yet. **Re-open condition:** a "why this gap" line on
  those pages.

### 8. `app/api/pilot/shadow/research-bridge/session-export` (GET)

- **Gate:** first `assertResearchBridgeExportEnvironment` (a 404 fence: no
  payload on production, whoever asks), `route.ts:80-104`,
  `src/server/pilot/researchBridgeAuth.ts:78-100`. Then organization_admin, or
  cross-organization access, `route.ts:123-135`. On the route-gate allowlist
  (`routeGateDeclaration.convention.test.ts:582`).
- **Callers:** none. The route's own comment says so: "nothing consumes this
  route -- no client, no page, no script, no workflow", `route.ts:97-101`. The
  external research-bridge service calls the sibling `/export`
  (`apps/research-bridge/src/ppbfClient.ts:20`), which is token-authenticated.
- **Tests:** `session-export/route.test.ts` (221 lines);
  `researchBridgeExport.test.ts`.
- **Tables:** reads through `buildResearchBridgeExport`, shared with `/export`,
  plus `pilot.organizations`; writes nothing.
- **Mark: PARKED.** It is a session-signed-in duplicate of `/export`, already
  fenced to non-production. It harms nothing, and its only possible use is a
  staff download on staging. **Re-open condition:** someone asks for a
  signed-in staging download of the research payload. If the research bridge
  is next changed and nobody has asked, delete it in that change.

### 9. Table `pilot.drill_version_outcomes`

- **Defined:** `infra/azure/pilot_slice_postgres_drill_versioning_migration.sql:302-306`
  (descriptive counts only, no effectiveness score, `:68`). Readiness checked by
  `apps/web/scripts/pilot-apply-drill-versioning-migration.mjs:179-205`.
- **Readers and writers:** none in app code. The only non-test mention is a
  comment, `src/server/pilot/drillVersioning.ts:8`. The 2026-10-03 audit
  measured the same (`INTAKE_RESEARCH_WORKOUT_PROGRAM_AUDIT_2026-10-03.md:122`, W4).
- **Tests:** constraint checks in `drillVersioning.pg.test.ts:436-438`;
  snapshot coverage in `assignmentDrillInstruction.pg.test.ts:1597,1764-1775`.
- **Mark: PARKED.** It was built as the measurement half of drill versioning,
  with "no read/write code built against it, that measurement layer is
  separate ongoing work" (`WORK_QUEUE.md:133`, PR-238w). With no writer, it
  should hold no rows (INFERRED; not counted in production). Dropping it costs
  a migration and saves nothing at runtime. **Re-open condition:** drill
  effectiveness measurement is built, or item 4 is deleted, in which case
  drop it in the same change.

## What this does not cover

- Callers outside this repository (Power Automate flows, external tools)
  cannot be seen from code. Only `apps/research-bridge` was checked.
- Production row counts for `athlete_floor_plans`, `source_retraction_checks`,
  `drill_change_proposals` and `drill_version_outcomes` were not taken. A
  deletion lane that touches a table needs them first, from a read-only script
  Jason runs.
