# Intake, research, workouts and programs: audit and plan (2026-10-03)

**What this is.** A read-only audit of four domains treated as one pipeline --
how material gets in, where it is stored, how it becomes workouts and programs,
and how coaches and athletes use it -- and a sequenced plan of bounded work
items. Nothing here is built, decided or approved by this document. Jason's
decisions are in `docs/current/OWNER_DECISIONS.md`; this file only cites them.

**Subject.** `main` at `03f5c649b1157753bb39639e9d01ae41109e3fae` (merged
2026-10-03T11:17Z, PR #1116). Every `file:line` below is at that SHA unless
it names another.

**Method and evidence levels.** Four read-only sweeps, one per domain, each
tracing route -> query -> render rather than grepping; a live GitHub query of
open and recently merged pull requests (snapshot 2026-10-03 ~11:30Z); and the
auditing session re-read every finding it marks **re-measured**. Levels used:

- **SOURCE-INSPECTED** -- read in the source at the SHA. Says nothing about
  runtime, deployed or database state.
- **MEASURED** -- a command was run in the repository checkout (counts, the CI
  classifier). The command is named.
- **EXTERNALLY VERIFIED** -- read from GitHub's API at the snapshot time.
- **REPORTED** -- carried from a sweep or an existing record and not re-read
  by the auditing session.

**What this audit could not do.** The container has no Postgres and cannot
load a deployed page, so no `.pg.test.ts` suite, no `test:migrations`, no
seed, no staging or production read and no screenshot was run. Every claim
about what a screen shows or what a database holds is therefore SOURCE-INSPECTED
only, and the "Proof" column of each plan item names the gate or human check
that would cover it.

---

## 1. The pipeline as built

Two intake mechanisms exist and do not meet.

**Gym content** enters through the content-import engine
(`apps/web/src/server/pilot/contentImport/`): the admin upload screen
`/admin/content-import` (`POST /api/pilot/admin/content-import`) or the
operator workflow `.github/workflows/seed-reference-data.yml`, both calling the
same `planImport`/`applyImport` with the same actor rule (`actor.ts:56-126`:
an active organization admin or admin with an active membership; the platform
owner refused for a gym and required for `__platform__`). Nine datasets are
specified (`contentImport/specs/index.ts:19-29`); seven load; `transfer-claims`
and `assessment-protocols` are refused by name (`cli.ts:244-262`,
`datasets/index.ts:16-18`). No dataset is research.

**Research** enters by a separate path with no engine in common: the platform
baseline importer (`apps/web/scripts/import-shadow-research.mjs`,
`.github/workflows/import-shadow-research.yml`, forced to `__platform__`), the
doctrine seed (`scripts/seed-shadow-library.mjs`, shelf-less), and in the app
the `/research` "Add Source Text" panel posting documents and chunks
(`app/research/LibraryTextIntakePanel.tsx`, `src/client/libraryTextIntake.ts`),
with PR #1109 adding a page-by-page PDF reader on the same panel. A third
thing called "document ingest" (`/api/document-ingest`) parses a PDF and writes
to Dataverse, SharePoint and Google Drive, never to the Library, and has no
page that calls it.

**Workouts** are the reference drill library (`pilot.drill_library`,
versioned) and workout templates whose items FK to it
(`infra/azure/pilot_slice_postgres_workout_templates_v2_migration.sql:87-88`).
The AI intake prompt (`contentImport/aiPrompt.ts`) carries the gym's current
reference heads to an outside AI and the admin uploads the answer as two CSVs.

**Programs** are three structures that do not reference each other:
(1) drill assignments and Coach Cards, which FK to the *operational*
`pilot.drills` (`..._drills_migration.sql:142-146`), created only by three
writers that all require an active operational drill (`progression.ts:263`,
`coachCards.ts:129`, `:300`; predicate `progression.ts:183-185`);
(2) workout templates and session scripts, which FK to the *reference* library
and are delivered as live runs; (3) development blocks, narrative plans with
objectives. Nothing turns a template or a script into an assignment.

**Athlete intake** (roster import, add-one-athlete, intake promotion, and the
root `scripts/seed-data.ts`) is four paths with four conflict and timestamp
behaviours, and the `/admin/shadow` upload of athlete forms writes a research
requirement row on every upload.

---

## 2. Findings

Classification uses the kernel labels. "Decided by" names the entry a fix
rests on; **OD REQUIRED** means no recorded decision covers it.

### 2.1 Seams between the domains

| # | Item | Classification | Evidence | Impact |
|---|---|---|---|---|
| S1 | Every `/admin/shadow` athlete-intake upload writes a research requirement whose text carries the uploaded file's name, readable on `/research` by every organization role. **Re-measured.** | VERIFIED_GAP; conflicts with OD-2026-10-02-015 D4 ("athlete intake files stay out of research") | SOURCE-INSPECTED: `app/api/pilot/shadow/upload/route.ts:219-239` calls `createShadowResearchRequirement` with no `subjectId`; `src/server/pilot/shadow.ts:79` builds the text `Review ${documentType} (${fileName}) and validate routing to ...`; `research-requirements/route.ts` GET gate is `SHADOW_PROJECTION_READ_ROLES` (all seven member roles plus platform owner) and `scopeToReachableSubjects` narrows only subject-bearing rows; `app/research/page.tsx:684` renders `requirement.research_requirement`; `/research` admits athlete, coach, parent, admin, platform_owner, staff, volunteer (`:451`). | A medical form or waiver's file name is visible to athletes, parents and volunteers of the organization. Whether the file name carries a person's name depends on what the admin uploaded; the sanitiser (`safeOriginalName`) was not read. Privacy; D4. |
| S2 | Research is not a content-import dataset; the two intake mechanisms share no code, actor rule, ledger or plan hash. **Re-measured.** | VERIFIED_GAP against OD-2026-09-29-005 R4 ("all four types ... must end up working together"); the PARKED row `BACKLOG-content-intake-follow-ups` (IMP-11/16/17) waits on the licensed-excerpt question, which OD-2026-10-02-013 answer 2 has since answered | SOURCE-INSPECTED: `contentImport/specs/index.ts:19-29` (nine datasets, none research); `apps/web/scripts/import-shadow-research.mjs`; `.github/workflows/import-shadow-research.yml:183`; `contentImport/upload.ts:145-146, 219-226` refuses research files by name | The parked row's re-open condition is met and the row still reads PARKED (STALE_DOC). R4's "all types" is not delivered for research and Jason has not narrowed it. |
| S3 | No column or code turns a workout template or session script into athlete work. Templates and scripts FK to `drill_library`; assignments FK to `pilot.drills`. | OWNER_DECISION (whether a template is meant to become assignments) -- no entry found | SOURCE-INSPECTED: `..._workout_templates_v2_migration.sql:87-88`; `..._session_scripts_migration.sql:94-95`; `..._drills_migration.sql:142-146`; writers `progression.ts:263`, `coachCards.ts:129`, `:300` (MEASURED: `grep "insert into pilot.drill_assignments"` finds exactly those three outside tests) | "Program" exists as three disconnected structures. The workout intake pipeline ends at a read-only catalog (`/coach/workout-templates`). |
| S4 | `pilot.athlete_competence` has no writer outside tests, so imported competence levels and cohort definitions can display a ladder but place nobody. **Re-measured.** | VERIFIED_GAP (data imported that cannot be used); the assessment path is OD REQUIRED | MEASURED: `grep -rn athlete_competence` over `src app scripts` excluding `*.test.*` finds no insert or update; `competenceCohorts.ts:279-297` renders "No assessed competence levels yet" for every cohort with a level range | OD-2026-09-29-005 R4 delivered cohorts and levels into the engine; nothing assesses an athlete against them. |
| S5 | `/api/document-ingest` and Library intake are separate pipelines; document-ingest has no page (and none is planned: OD-2026-10-02-015 D4 names the `/research` reader instead) and, at this SHA, no `serverExternalPackages` for `pdf-parse`. **Re-measured.** | OPEN_PR for the bundling fix (#1109 adds the `next.config.ts` line); OWNER_DECISION on whether `/api/document-ingest` is still wanted once RINT-02 lands (OD-2026-10-02-015 D4 says the RINT-02 reader covers research PDFs) | SOURCE-INSPECTED: `apps/web/next.config.ts` keys are `output`, `distDir`, `poweredByHeader`, `turbopack`, `headers`; `app/api/document-ingest/route.ts:3` imports `pdf-parse`; the route writes Dataverse, SharePoint and Google Drive (`:233-262`) and nothing in `pilot.*` except an audit row; only `scripts/run-mock-ingest.ts` references the path. EXTERNALLY VERIFIED: #1109 is open, `mergeable_state: clean`, CI green at head `b1970352`. | The Build List row "`/api/document-ingest` likely fails on every PDF in production" is INFERRED there and stays INFERRED here (not run). |
| S6 | The AI workout prompt lists reference heads that are `active and superseded_at is null`; the upload accepts any head with `superseded_at is null`, withdrawn included. **Re-measured.** | VERIFIED_GAP (small) | SOURCE-INSPECTED: `drillLibraryV3.ts:304-306`; `contentImport/lineage.ts:44-47` | An AI following the prompt cannot produce a withdrawn id, but a hand-edited CSV linking a withdrawn drill loads. Low impact; one filter. |
| S7 | #1115 built the server half of the platform shelf (OD-2026-10-02-013 1B, -015 D2/D3) and no page sends `shelf`; `/research` admits the platform owner and shows the curator panels, whose writes now 403 under D3. **Re-measured.** | VERIFIED_GAP, decided (1B, D2, D3) | SOURCE-INSPECTED: `src/server/pilot/libraryShelf.ts:54-76`; MEASURED: `grep -rn shelf app src/client` (non-test) finds no `.tsx` or client module sending `shelf`; `app/research/page.tsx:451` role list; the sources probe is a read (`:191`), so the panels render for platform_owner | The decided screen is half-built: routes accept `shelf=platform`, nothing in the app sends it. The platform owner's `/research` writes fail with a server refusal the page did not anticipate. |
| S8 | D3 is applied unevenly: `capability-coverage` POST, `research-submissions` POST/PATCH and `review-flags` PATCH take `principal.organizationId` and never call `resolveLibraryShelf`, so the platform owner can still write those three to the gym shelf. | VERIFIED_GAP, decided (D3) | SOURCE-INSPECTED (re-measured for submissions): `research-submissions/route.ts:142, 171-178` (`CURATOR` roles include platform_owner; `*InOrg(principal.organizationId)`); MEASURED: `grep resolveLibraryShelf` over those three route files finds no call. REPORTED for capability-coverage and review-flags line numbers (sweep: `:36/:48`, `:51/:80`). | D3's "no longer writes a gym's shelf" holds for sources, documents and chunks and not for these three writes. |
| S9 | No licence or rights field exists on sources, documents or chunks. **Re-measured.** | VERIFIED_GAP, decided (OD-2026-10-02-013 answers 2A and 4A: licensed excerpts private; full text only for PPBF-owned or open-licence material) | MEASURED: `grep -rniE "licen[cs]e"` over `src app infra/azure` finds only "licensed medical professional", a comment at `calibration/ontology.ts:505` and unrelated prose; chunk CSV columns carry `evidence_tier` and `authority_tier` in metadata and no licence key | The rule "full text only for PPBF-owned or open-licence material" has nothing to check against. |
| S10 | `pilot.universal_stop_rules` has a table, a loader and a reader, no committed file and no workflow choice. **Re-measured at this SHA.** | BLOCKED on Jason's wording (open owner question, `ACTIVE_WORK.md`) | SOURCE-INSPECTED: `..._content_import_migration.sql:164-222`; `contentImport/datasets/universalStopRules.ts`; `drillLibraryV3.ts:211-223`; `.github/workflows/seed-reference-data.yml:65-67, 86-98`; MEASURED: no `seed_universal_stop_rules.csv` under `apps/web/seed-data/` | Every drill's injury stop (OD-2026-09-29-005 R3) is still only the copied legacy lines. |
| S11 | Four athlete-creation paths with different `created_at` and conflict semantics; `scripts/seed-data.ts` upserts five tables with `ON CONFLICT DO UPDATE` and no actor check, and `SEED_GUIDE.md` documents only that path. | VERIFIED_GAP for the add-one-athlete `created_at` (already a Build List row, decided by OD-2026-09-29-002 item 4); STALE_DOC for `SEED_GUIDE.md`; OWNER_DECISION on whether `scripts/seed-data.ts` stays | REPORTED (sweep): `scripts/seed-data.ts:214-225, 354, 365, 410, 455, 509-519`; `SEED_GUIDE.md:21-50, 86, 311`; SOURCE-INSPECTED (confirmed in the Build List row): `app/api/pilot/athletes/route.ts` takes `created_at` from the request via `validation.ts:141` and `entities.ts:78` | A laptop-run overwrite path for minors' records sits beside the gated app paths. |

### 2.2 Research

| # | Item | Classification | Evidence | Impact |
|---|---|---|---|---|
| R1 | `/research` requirements read: a failed fetch becomes `[]` with no error shown; `/research/review`: each failed submissions fetch becomes `[]`, so a total failure reads "No sources have been submitted". **Re-measured.** | VERIFIED_GAP (the #991 class); decided by OD-2026-09-29-002 item 4; timing OD-2026-10-01-001 section 3 | SOURCE-INSPECTED: `app/research/page.tsx:170-182`; `app/research/review/page.tsx:108-116` | A read failure is shown as an empty inbox. |
| R2 | The seed README and a route comment say 1,214 sources; the CSV holds 1,001 rows and the importer expects 1,001. **Re-measured.** | STALE_DOC | MEASURED: `csv.DictReader` over `seed-data/shadow-research/2026-08-07/seed_shadow_library_sources.csv` = 1001 rows; `README_RESEARCH_INTAKE_SEED.md:21, 48` and `evidence/review/route.ts:29` say 1214 / 1,214; `scripts/import-shadow-research.mjs:19` expects 1001 | Two numbers in the repo for one file. |
| R3 | Platform-shelf sources cannot be retraction-suppressed through the app: `admin/retraction-checks` has no shelf parameter. | VERIFIED_GAP (small), follows from 1B | REPORTED (sweep): `app/api/pilot/admin/retraction-checks/route.ts:42, 87`; `sourceRetractionChecks.ts:228, 257` | A retracted platform paper stays retrievable by every gym until an operator tool is run. |
| R4 | `evidence/review` GET returns `subject_id` and `document_name` for athlete-scoped documents to the platform owner on its own gym shelf; `/evidence` does not render `subject_id`. | NEEDS_MEASUREMENT against OD-2026-09-28-005 (the platform owner never opens an individual athlete record) | REPORTED (sweep): `shadowLibrary.ts:754`; `app/evidence/page.tsx:20-30`. Not re-read. | Possible API-level exposure; the page hides it. To be read before it is called a defect. |
| R5 | Routes with no page yet (the UI is not finished -- owner, 2026-10-03 -- so a missing page is not evidence that a route is unwanted): `library/search` (a probe only), `library/capability-coverage` (the doctrine seed script only), `research-bridge/session-export` (its own comment says nothing calls it), `admin/retraction-checks`. | PARKED candidates or OWNER_DECISION (keep or delete) | REPORTED (sweep) | Surface nobody can reach from the app. |
| R6 | The Library chat answered a nonsense question with an unrelated passage (Build List row). | NEEDS_MEASUREMENT | REPORTED only; the question and environment are not recorded; no code was read for it here either | Not investigated in this audit. |

### 2.3 Workouts

| # | Item | Classification | Evidence | Impact |
|---|---|---|---|---|
| W1 | Which drill states count as "the gym's drill list" for the AI prompt is a builder default (current reference heads), not Jason's ruling. **Re-measured.** | OWNER_DECISION (OD-2026-10-02-012: "not settled") | SOURCE-INSPECTED: `app/api/pilot/admin/content-import/route.ts:134-138, 143`; `drillLibraryV3.ts:304-306` | The list is the 119-drill reference library, not the gym's adopted operational drills. |
| W2 | `/coach/workout-templates` detail shows the raw `drill_id` as the step label. | OPEN_PR | EXTERNALLY VERIFIED: #1118 (`lane/workout-template-drill-name`, head `60a11727`) changes `page.tsx`, `workoutTemplates.ts` and two tests; `validate` was in progress at snapshot | Fixed when #1118 lands. |
| W3 | `/drills/proposals` (GET/POST), `/drills/proposals/review` and `/drills/lineage` have no page yet; the proposal review gate admits platform_owner while list, create and promote refuse it. | VERIFIED_GAP (gate inconsistency) + PARKED candidate | REPORTED (sweep): `proposals/route.ts:219, 253`; `review/route.ts:114` with `requireEvidenceReviewer` (`shadowLibrary.ts:310-313`); `promote/route.ts:47-51` | A platform owner can review a proposal it could not have made. No UI exercises either path. |
| W4 | `pilot.drill_version_outcomes` has no reader or writer outside tests and the migration. **Re-measured.** | PARKED candidate | MEASURED: `grep -rn drill_version_outcomes` over `apps/web` and `infra`: migration, apply script, two `.pg.test.ts`, one comment | Schema with no code behind it. |
| W5 | `pilot.reference_content_revisions` is read only by the importer itself; disciplines, competence levels and cohort definitions revise in place with a ledger, which R2 did not decide. | OWNER_DECISION (open question in `ACTIVE_WORK.md`, added 2026-09-30) | REPORTED (sweep): `contentImport/ledger.ts:44`; `registries.ts:17-22`; migration `:225, 260-277` | Already recorded as open; nothing new. |
| W6 | Two drill sources of truth by design (`pilot.drills` operational, `pilot.drill_library` reference), bridged only by `reference_drill_id`; the 2026-09-30 production census found the 119 reference drills twice, under `ppbf-default-org` and `punxsy_prominence`. | OWNER_DECISION (the census follow-up, `BACKLOG-content-intake-follow-ups`) | REPORTED: `ACTIVE_WORK.md` "Content import in use" row (run 36729675728) | Not re-measured here (no database). |
| W7 | Decisions OD-2026-09-16-001, -09-18-001, -09-19-001, -09-19-002, -09-15-001, -08-27-001 / -08-28-005 and -09-29-005 R2 (drills and templates) are visibly implemented; no contradiction found. | EXISTING | SOURCE-INSPECTED (sweep, with the three assignment writers re-measured): predicate `progression.ts:183-185`; `assignmentDrillInstruction.ts:139-141, 189`; `drillLibraryV3.ts:1069-1086`; `COACHING_CONTENT_READER_ROLES` (`coachingContentAccess.ts:356-365`) | -- |

### 2.4 Programs

| # | Item | Classification | Evidence | Impact |
|---|---|---|---|---|
| P1 | `/coach/floor-groups`: a failed groups read leaves `groups` at `[]` and renders "No groups yet". **Re-measured.** | VERIFIED_GAP (#991 class), decided as above | SOURCE-INSPECTED: `app/coach/floor-groups/page.tsx:65, 240, 253-255` (`void reloadGroups(value)` with no catch) | A read failure reads as an empty day. |
| P2 | `/coach/progression-intelligence`: the empty claims are not guarded by `errorMessage`, and a failed read keeps the previous athlete's rows on screen. | VERIFIED_GAP (#991 class), decided as above | REPORTED (sweep): `page.tsx:398-413, 738, 1088, 1126` | A read failure can show one athlete's work under another's name. Not re-read; to be confirmed before fixing. |
| P3 | `/api/pilot/floor-plans` (GET/POST/PATCH) and `/api/pilot/progression/gap-justification` have no page yet. | PARKED candidates | REPORTED (sweep): `AthleteWorkspace.tsx:1611-1615` says the floor no longer posts there | Unused surface, with a coach scope rule (`coach_id = accountId`) that differs from the central rule. |
| P4 | Role mismatches: `/coach/cards` admits `['coach']` while the route admits admin and organization_admin; `competence-cohorts` athlete report omits `organization_admin` unlike sibling routes. | VERIFIED_GAP (small) | REPORTED (sweep): `cards/page.tsx:333`; `competence-cohorts/route.ts:38-39` | An organization admin cannot issue a card from the page or read the fit report. |
| P5 | No cross-organization read found; athlete and parent views are self- or link-scoped; no cross-athlete comparison in athlete views. | EXISTING | SOURCE-INSPECTED (sweep): every query binds `principal.organizationId`; `progression.ts:96-97` composite drill join; `athlete/development-blocks/route.ts:220-235` enumerated projection | -- |

### 2.5 Data intake

| # | Item | Classification | Evidence | Impact |
|---|---|---|---|---|
| D1 | Intake promotion skips the deleted-login check when the promotion names no `account_id`, and writes anyway. **Confirmed at this SHA by the sweep; matches the Build List row.** | VERIFIED_GAP, decided (Build List row, OD-2026-09-29-002 item 4); part (ii) serialization not settled | SOURCE-INSPECTED (sweep): `review-action/route.ts:501, 512, 550`; `intake.ts:1524-1561, 1653-1657` | A live athlete whose login is deleted. Safety of record. |
| D2 | `/admin/shadow` sends only `general_intake`; the route accepts five other document types with no page yet; the writes (blob, case, document, intake, audits, requirement) are sequential awaits in no transaction; there is no route test. | VERIFIED_GAP | REPORTED (sweep): `shadow/upload/route.ts:32-290`; `admin/shadow/page.tsx:1704-1712`; MEASURED: `ls app/api/pilot/shadow/upload/` shows `route.ts` only | A partial failure leaves a blob with no row or a row with no requirement; nothing tests the route. |
| D3 | Disciplines have two seed sources: `disciplineSeeds.ts` inside `createOrganization` (platform-owner routes, no actor stamp, no ledger) and the CSV through the engine. | DUPLICATE (guarded by `disciplineSeedsOwnership.test.ts`) | REPORTED (sweep): `disciplineSeeds.ts:137-170`; `auth.ts:1175`; `platform/organizations/route.ts:57` | The platform owner writes gym rows outside the actor rule, by a path a test keeps in step with the CSV. |
| D4 | `seed:transfer-claims` is an npm script that always throws; `seed:drill-secondary-skills` duplicates `seed:drill-library`. | STALE / DUPLICATE (small) | REPORTED (sweep): `apps/web/package.json:126, 329`; `seedWorkflowContract.test.ts:258-260` asserts the throw | Noise in the script list. |
| D5 | `seed-reference-data.yml:17-18` and `actor.ts:7` still say the upload screen "will call later"; it exists (#1031). | STALE_DOC | REPORTED (sweep) | Comments contradict the code they sit in. |
| D6 | `intake/tickets/`: none READY or CLAIMED; none touches these domains. `intake/drops` is gitignored. | EXISTING | REPORTED (sweep): `Status:` lines; `intake/drops/.gitignore:4` | The ticket path is idle for this work. |
| D7 | The content-import migration is registered in both `apply-migrations.yml` (`:193, 380, 392`) and the `test:migrations` chain; no `*roster*`, `*intake*`, `*universal_stop*` or `*reference_content*` migration file exists (those tables live in the base `pilot_slice_postgres.sql` or the content-import file). | EXISTING | REPORTED (sweep) | -- |

### 2.6 Open pull requests and Build List rows in these domains

EXTERNALLY VERIFIED, snapshot 2026-10-03 ~11:30Z. Four open PRs in the
repository; three touch these domains.

| PR | Head | State | Files in these domains | Decided? |
|---|---|---|---|---|
| #1109 RINT-02 PDF page reader on `/research` | `b1970352` | clean; CI green | `shadow/library/pdf-text/route.ts` (new), `LibraryTextIntakePanel.tsx`, `src/client/libraryTextIntake.ts`, `libraryPdfText*.ts`, `next.config.ts` (+`serverExternalPackages`), `ci.yml`, `package.json` | Yes: OD-2026-10-02-013 4A; -015 D4 names it. Also carries the only fix for S5. |
| #1118 workout-template drill name | `60a11727` | blocked (validate running) | `coach/workout-templates/page.tsx`, `workoutTemplates.ts`, two tests | Live-bug class (OD-2026-09-29-002 item 4). Fixes W2. |
| #941 drill cabinet | `c4613b27` | **dirty**, 12 days old, base stale | `coach/drills/page.tsx`, `buildingMap.ts`, `ppbf-golden-era.css`, e2e, design tests | OD-2026-09-29-002 "5 A": check against `main`, close if `main` has it; "check in progress" since 2026-09-28. Collides with any `/coach/drills` work. |
| #1119 pain tone | `f7f8d83b` | blocked (validate running) | `CoachWorkspace.tsx` | Outside these domains. |

Build List rows in these domains and their state at this SHA: "Content import
in use" (engine on `main`; no `seed-reference-data` run recorded since
2026-09-16; upload-screen use UNVERIFIED); "Research baseline repair in
production" (applied 2026-09-30; one signed-in SHADOW question still owed);
"`/api/document-ingest` likely fails on every PDF" (S5); "The roster's
creation time comes from the admin's device" (S11); "Intake can leave a live
athlete whose login is marked deleted" (D1); "The Library chat answered a
nonsense question" (R6); "Wire `gold` to something" (outside these four
domains; not audited).

---

## 3. The plan

One concern per PR. Order inside each group is by likelihood of data loss or
leak first. "Proof" names the smallest check and the gate that covers what
the container cannot run. Sizes: S under a day, M a day or two, L more.

### 3.1 Decided -- build now

| # | Objective | Files likely touched | Rests on | Depends on / collides with | Migration | Proof | Size |
|---|---|---|---|---|---|---|---|
| B1 | **S1.** Stop `/admin/shadow` athlete-intake uploads from writing a research requirement, or write one that carries no file name and no document type; and decide what happens to rows already written (see Q1). | `app/api/pilot/shadow/upload/route.ts:219-239`; `src/server/pilot/shadow.ts:79`; a new `shadow/upload/route.test.ts` | OD-2026-10-02-015 D4 | None open. D2 (no route test) is fixed by the same PR's test. | NONE for the write change. Cleaning existing rows is a data mutation Jason approves per run. | Route test: an upload of each document type creates no requirement (or one with no file name); watch it fail against the current code first. `mutation:prove` on the new guard. Existing-row count: a read-only production query, when Jason says so. | S |
| B2 | **D1 (i).** The unconditional pre-write deleted-login check in intake promotion, including when `promotion.athlete.account_id` is absent. Part (ii), serialization, stays open (Q5). | `app/api/pilot/intake/review-action/route.ts:501-550`; `src/server/pilot/intake.ts:1524-1561`; `intakeLoginRefusals.pg.test.ts` | Build List row; OD-2026-09-29-002 item 4; OD-2026-09-30-007 section 7 | None open. | NONE | A `.pg.test.ts` case: cleanup retires the login, then a promotion with no `account_id` is refused 409. Cannot run in the container; `pre-release-migrations.yml` and the Windows run cover it. Mutation: remove the new check, watch it red. | S |
| B3 | **S11 (part).** Stamp `pilot.athletes.created_at` on the server for the add-one-athlete route; drop the client field. | `app/api/pilot/athletes/route.ts`; `src/server/pilot/validation.ts:141`; `entities.ts:78`; `app/admin/people/page.tsx:705, 720`; `athletes/route.test.ts` | Build List row; OD-2026-09-29-002 item 4 | None open. | NONE | Route test asserting `created_at` is ignored from the body and set by the server; the existing test at `:54` supplies it and must change. | S |
| B4 | **S7.** The platform owner's `/research` and `/evidence` as the platform-shelf screens: send `shelf=platform` from the client for the platform owner, hide or label the gym-shelf curator panels for that role, and make the refusal codes from `libraryShelf.ts` readable on screen. | `app/research/page.tsx`; `app/research/LibraryTextIntakePanel.tsx`; `src/client/libraryTextIntake.ts`; `app/evidence/page.tsx`; their tests | OD-2026-10-02-013 1B; OD-2026-10-02-015 D2, D3 | **Collides with #1109** (`LibraryTextIntakePanel.tsx`, `libraryTextIntake.ts`): sequence after it merges. | NONE | Page tests: platform_owner requests carry `shelf=platform`; a gym admin's never do. Visual: a signed-in walk by Jason or a screenshot; a code read cannot show it. | M |
| B5 | **S8.** Route `capability-coverage` POST, `research-submissions` POST/PATCH and `review-flags` PATCH through `resolveLibraryShelf(..., 'write')`. | the three route files; `platformLibraryWriteScope.convention.test.ts` (extend to cover them) | OD-2026-10-02-015 D3 | After #1115 (merged). | NONE | Convention test extended so every Library write route calls `resolveLibraryShelf`; watch it fail before the change. | S |
| B6 | **S5.** Land the `serverExternalPackages` fix: merge #1109 (green, clean) or, if it stalls, port its `next.config.ts` lines alone. | `apps/web/next.config.ts` | OD-2026-10-02-013 4A; -015 D4; Build List row | #1109 | NONE | The standalone build with a PDF parse, which #1109 reports proving; not reproducible in the container. | S (port) |
| B7 | **R1, P1.** The #991-class fixes in these domains: `/research` requirements error state, `/research/review` submissions error state, `/coach/floor-groups` groups error state. P2 (`progression-intelligence`) after a re-read confirms it. | the three pages and their tests | OD-2026-09-29-002 item 4; timing OD-2026-10-01-001 section 3 ("the two safety batches first; these wait") | May overlap Lane 14's batches 3-8, whose report is outside the repository: check it before starting. | NONE | Page tests: a failed read renders a distinct error and no empty claim, modelled on `app/evidence/page.test.tsx`. | S each |
| B8 | **S6.** Filter the upload's drill-lineage heads to `active` to match the prompt. | `contentImport/lineage.ts:44-47`; `contentImportTemplatesScripts.pg.test.ts` | OD-2026-10-02-012 (the prompt's list) | None. | NONE | A `.pg.test.ts` case: a template linking a withdrawn head is rejected; covered by the migrations gate. | S |
| B9 | **R2, D5, S11 (docs).** Correct the 1,214 figures to the measured 1,001 (or re-measure if the CSV changes), the two "will call later" comments, and either rewrite `SEED_GUIDE.md` around the gated paths or mark it history. | `README_RESEARCH_INTAKE_SEED.md:21, 48`; `evidence/review/route.ts:29`; `seed-reference-data.yml:17-18`; `actor.ts:7`; `SEED_GUIDE.md` | Kernel: "Report the check, not the conclusion" | None. | NONE | Docs-only: run the doc-asserting suites by hand (`evidenceApplicabilityContract`, `ciClassifierScopeContract`, `ownerDecisionIds`). | S |
| B10 | **S2 (record).** Update the PARKED row `BACKLOG-content-intake-follow-ups`: its licensed-excerpt condition is answered (OD-2026-10-02-013 answer 2); the research import (IMP-11/16/17) is now waiting on a plan, not a decision. | `docs/current/ACTIVE_WORK.md` | OD-2026-10-02-013 | None. | NONE | Docs-only, as B9. | S |
| B11 | **#941.** Finish the "5 A" check: compare against `main`, close if `main` has what it adds, else list what is missing for Jason. | none in the repo (a report) | OD-2026-09-29-002 "5 A" | Blocks any `/coach/drills` change while open and dirty. | NONE | A written comparison on the PR. | S |

### 3.2 Needs Jason first

| # | Objective | Rests on | The one question (see section 4) | Size once decided |
|---|---|---|---|---|
| N1 | **S2.** The versioned research import through the content-import engine (IMP-11/16/17), with licensed excerpts stored privately (2A) and curator-chosen excerpts with citation and page (4A). | OD-2026-09-29-005 R4; OD-2026-10-02-013 2, 3, 4; -02-006 section 2 | Q2 (private location and operator) | L; needs a migration (licence/rights field, S9) and a new dataset spec |
| N2 | **S9.** A rights or licence marker on sources so "full text only for PPBF-owned or open-licence material" is checkable, and the intake refuses full text otherwise. | OD-2026-10-02-013 4A | Q3 (the allowed values) | M; migration |
| N3 | **S3.** Whether a workout template or session script is meant to become athlete work (assignments) and by what act. | none found | Q4 | L if yes |
| N4 | **S4.** How an athlete's competence level is assessed and recorded, so cohorts can place anyone. | OD-2026-09-29-005 R4 delivered the ladder; nothing on assessment | Q6 | M-L; may need a migration |
| N5 | **W1.** Which drill states make "the gym's drill list" in the AI prompt. | OD-2026-10-02-012 ("not settled") | Q7 | S |
| N6 | **S10.** The wording of the universal stop rules, then the committed file and a workflow choice. | OD-2026-09-29-005 R3; open owner question | Q8 (his material, not a question Claude can answer) | S once the words exist |
| N7 | **W6.** The 119 reference drills under two organizations: which set is the gym's. | census row | Q9 | S-M; a data mutation Jason approves |
| N8 | **S5 (retire?).** Whether `/api/document-ingest` stays once RINT-02 lands. | OD-2026-10-02-015 D4 | Q10 | S to delete; nothing to build |
| N9 | **W5.** In-place revisions with a ledger for disciplines, competence levels and cohorts. | open question (2026-09-30) | already on the open list; not re-asked here | -- |
| N10 | **S11 (seed-data.ts).** Whether the laptop upsert seeder for athletes, parents, goals and sessions stays. | none found | Q11 | S to retire |
| N11 | **R5, W3, W4, P3.** Routes and tables with no in-app caller yet: park each with a re-open condition; delete only what is clearly obsolete (OD-2026-10-03-002). | Kernel: "prefer deletion ... over expansion" | Q12 | S each |

---

## 4. Owner questions

Each is one question with the recommendation marked; none is answered here.

- **Q1 (B1).** The research-requirement rows that intake uploads have already written (count unknown; a read-only production query would give it): delete them, or leave them and only stop new ones? Recommended: count first, then decide. **Answered 2026-10-03 (OD-2026-10-03-002):** delete them all (the audit recommended counting first; his choice overrules it). Still a production data change: a read-only count, then his word per run.
- **Q2 (N1).** Licensed excerpts are stored privately in the database (2A). Who loads them and from where: Admin@ through the in-app platform-shelf screen (B4) only, or also an operator workflow reading a private location? Recommended: the screen only, until a private location exists. **Answered 2026-10-03 (OD-2026-10-03-002):** the screen plus an operator workflow reading a private location (the audit recommended the screen only; his choice overrules it). Neither the private location nor its secret exists yet.
- **Q3 (N2).** The rights values a source may carry. Proposed: `ppbf_owned`, `open_licence`, `licensed_excerpt_only`, `unknown` (full text refused unless the first two). Recommended as proposed. **Answered 2026-10-03 (OD-2026-10-03-002):** the four values as proposed: ppbf_owned, open_licence, licensed_excerpt_only, unknown.
- **Q4 (N3).** Should a workout template or session script become athlete assignments, and if so by whose act (a coach issuing it to an athlete or a program)? Recommended: not until N4 exists; templates stay a catalog. **Answered 2026-10-03 (OD-2026-10-03-002):** yes: a coach issues a template to an athlete or program in one action. Open sub-question for him: a step whose drill the gym has not adopted (refuse and name it, adopt it, or skip it and say so); the audit recommends refusing.
- **Q5 (B2 part ii).** Serializing intake's checks and writes against the account cleanup: a shared advisory lock (two pool connections per promotion) or a single transaction? Recommended: a single transaction, if `intake.ts:1653-1657`'s reason for sequential writes can be removed. **Answered 2026-10-03 (OD-2026-10-03-002):** one transaction around intake's writes; re-read the reason for the separate writes at intake.ts:1653-1657 first.
- **Q6 (N4).** How is an athlete's competence level recorded: a coach sets it by hand on the athlete record, or it is derived from assignments and completions? Recommended: coach-set, as minors' limits are coach-set data (OD-2026-09-21-001). **Answered 2026-10-03 (OD-2026-10-03-002):** a coach sets the level by hand.
- **Q7 (N5).** Which drills go to the outside AI: A, the current reference library (as built); B, only drills this gym has adopted; C, both, marked. Recommended: A (he chose "not limited to approved drills"). **Answered 2026-10-03 (OD-2026-10-03-002):** A, the current reference library as built (his "Match", read by the recorder as A). He added that the drills need auditing, "alot are too simplistic and dont really do anything", and that this can wait until the Fable items are done: parked, with measurements at 93bc76d (119 drills; execution median 21 words, 105 of 119 under 30; purpose median 5; standard_setup median 2; common_errors empty on 114; 34 with no cue; every drill has exactly 3 scale levels, not checked for substance).
- **Q8 (N6).** The universal stop-rule wording (his material). Not asked on 2026-10-03: it is text for him to write, not a choice.
- **Q9 (N7).** Of the two copies of the 119 reference drills, which organization's set is the gym's, and is the other deleted or left? Recommended: `punxsy_prominence` (OD-2026-09-28-007) is the gym; the `ppbf-default-org` copy is a question for the policy-shelf move's owner. **Answered 2026-10-03 (OD-2026-10-03-002):** confirm which copy is in use, delete the other (the audit recommended leaving both; his choice overrules it). A read-only check first, then his word per run.
- **Q10 (N8).** Retire `/api/document-ingest` once #1109 is in production? Recommended: yes; it feeds nothing in the app. **Answered 2026-10-03 (OD-2026-10-03-002):** retire it, after #1109 lands; search the repository for callers first (external flows cannot be seen from here).
- **Q11 (N10).** Retire `scripts/seed-data.ts` and `SEED_GUIDE.md`, or keep them for a named purpose? Recommended: retire. **Answered 2026-10-03 (OD-2026-10-03-002):** retire the script and SEED_GUIDE.md; a replacement for test fixtures may be wanted.
- **Q12 (N11).** The callerless routes and tables (R5, W3, W4, P3): delete now, or park each with a re-open condition? Recommended: park with a condition, delete at the next release that touches the file. Answered 2026-10-03 (OD-2026-10-03-002): park each with a re-open condition; delete only what is clearly obsolete, because the UI is not finished and a route with no page may be waiting for its screen.

---

## 5. Unknowns

- Whether any content has been loaded through `/admin/content-import` or
  `seed-reference-data` on staging or production (no database read).
- The number of research-requirement rows intake uploads have already written
  (S1), and whether any file name in them carries a person's name.
- What `safeOriginalName` strips (not read).
- Whether `/api/document-ingest` fails in production (INFERRED by the Build
  List row from #1109's standalone-build evidence for a different route; not
  run).
- Whether the `/research/chat` nonsense answer (R6) reproduces, and in which
  environment.
- R4 (platform owner and `subject_id` on `evidence/review`) and P2
  (`progression-intelligence` stale rows): REPORTED by a sweep and not re-read.
- Whether Lane 14's batches 3-8 (outside the repository) already cover R1 and
  P1.
- The merge state of #1118 and #1119 after the snapshot (their `validate`
  jobs were running).

---

## 6. Adversarial pass over this audit's own findings

Taken after the tables were written; each line names what was re-checked.

- **Every number.** 1001 (CSV rows, `csv.DictReader`, re-run); 9 datasets and
  7 loadable (`specs/index.ts:19-29`, `datasets/index.ts:93`); 3 assignment
  writers (`grep`, re-run); 4 open PRs (API, one page of 100); 0 non-test
  writers of `athlete_competence` (`grep`, re-run); 0 `.tsx` senders of
  `shelf` (`grep`, re-run). The "119 drills twice" and "1,193 chunks" figures
  are REPORTED from records and the sweep and were not re-measured; the chunk
  CSV's `wc -l` (9545) is not a row count because of multi-line fields.
- **What verified each "verified".** Nothing in this file is runtime-verified.
  S1 rests on four source reads joined by reasoning about role sets; the one
  step not read is `safeOriginalName`. If it replaced the name with a hash, S1
  would shrink to "document type visible", and the finding says so.
- **What a guard was seen to fail.** No guard was written, so none was watched
  to fail; the plan's Proof column requires it for B1, B2, B5 and B8.
- **Claims wider than the check.** "No cross-organization read found" (P5,
  W7) is the sweeps' reading of the queries they traced, not of every query
  in the domains; "none found" is a search result. "No licence field exists"
  (S9) is a grep over `src`, `app` and `infra/azure` for one stem; a second
  grep for `rights`, `copyright_status`, `licence_` and `license_` found only
  two comments about database DDL rights (`rateLimit.ts:73`, the rate-limit
  migration `:23`), so the finding stands for those names and no others.
- **Decisions the code contradicts.** Two are asserted: S1 against D4, and S8
  against D3. S7 is a gap, not a contradiction (#1115 built what it said; the
  screen is the half not built). W7 found none for the drill rulings.
- **Scope.** Q4 and Q6 could be read as product expansion; they are put as
  questions because the pipeline as built ends at a catalog and a ladder that
  places nobody, and Jason has not said whether that is the intent.
- **What would change the plan's order.** If Q1's count is zero and the
  sanitiser hashes names, B1 drops below B2. If #1109 does not merge within
  the week, B4 should be rebased on its branch rather than wait.

---

## Appendix: adjacent findings (outside the four domains)

- `research-bridge/session-export` gives a `hasMasterShadowAccess` account
  every organization's export except `__platform__`; its docblock says the
  payload is de-identified and nothing calls it (REPORTED; `buildResearchBridgeExport` not read).
- `drill_name`/`drill_description` snapshots on assignments sit beside live
  `coalesce(d.name, a.drill_name)` reads; `updateDrill` edits `name` and
  `focus` in place, so wording can drift from the snapshot. Documented as
  intended (REPORTED, `progression.ts:87-94`, `drills.ts:315-322`).
- "Group" exists four ways (programs by `program_name`, cohort definitions,
  floor-plan groups, development blocks) with no shared id.
- `/coach/floor-groups` GET lists every placed athlete in the organization
  with no per-coach filter; staff-facing and consistent with the name-visibility
  doctrine, noted only.
