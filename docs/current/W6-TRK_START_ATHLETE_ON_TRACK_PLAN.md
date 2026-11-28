# W6-TRK: start an athlete on a training track (plan only)

STATUS: WAITING-FOR-OVERWATCH

Plan only, no code. Main read at `a54dcfe7a574edf12400a45f778adff6227f15b3` (2026-11-28). Labels: OBSERVED (read in code or file, with file:line), INFERRED, UNVERIFIED. Nothing here is built until "OVERWATCH: GO".

Work item source: Jason 2026-11-28 "start lanes to finish what we need to do from abouve", relayed by Backbone note 47 (item: starting an athlete on a track). The note is not in this repo, so the relay itself is REPORTED by the brief, not read.

## 0. Sizing file

OBSERVED: `docs/content-review/w4-sizing/W4_SIZING.md` has no section for this item (the only "track" hits are about FT1 drill rewrites, around line 1140). The rules file asks for a re-read of the item's sizing section; there is none, so the sizes in section 6 are my estimates (INFERRED), not a re-check of a sizing.

## 1. What exists today

### Tracks (the template half, merged)
- OBSERVED: three tables, no athlete, no dates: `infra/azure/pilot_slice_postgres_training_tracks_migration.sql:1-33` (header), `training_tracks` :54-83, `track_blocks` :98-126, `track_block_sessions` :137-160. Applied on staging and production 2026-11-12 (`docs/current/ACTIVE_WORK.md:167`).
- OBSERVED: the per-athlete column is deliberately not there: migration header lines 5-7 ("athlete_development_blocks.source_track_block_id (P17's per-athlete half) is NOT here: it comes with the lane that starts an athlete on a track"); `ACTIVE_WORK.md:167` ("waits for the lane that starts an athlete on a track"); `docs/backbone/SCHEMA_PROPOSAL.md:250-252` (P17, nullable); `docs/backbone/DATA_MODEL.md:159-162` ("A member's instance reuses `athlete_development_blocks` with a new nullable `source_track_block_id`"); `OWNER_DECISIONS.md:4985` (OD-2026-11-11-003 "Not ruled here": the column "is left to the lane that starts an athlete on a track").
- OBSERVED: a track is versioned (R2). A new version re-mints every block under a new track id and the old rows stay (migration header :12-19). `track_blocks` primary key is `(organization_id, track_block_id)` (:117), so a composite foreign key from a development block to a specific block row is possible, and it pins the version the athlete started on.
- OBSERVED: a track block session names a workout template by lineage, with no foreign key (`track_block_sessions.template_lineage_id`, migration :146, :159; comment :165). The Class plans read resolves the lineage to the template's current version at read time (`apps/web/src/server/pilot/classPlans.ts:139-157`).
- OBSERVED (repo seed, UNVERIFIED against the live database): `apps/web/seed-data/training-tracks/seed_track_blocks.csv` has 27 blocks on 6 tracks. FT1 "8-Week Non-Contact Boxing Pilot Program" (8 blocks of 1 week, age band "all ages", `lane` standard, `track` fitness); "Eight-week camp" (8 blocks of 1 week, titles carry taper percentages such as "70% → 55%", age band "any"); "48-Session Fully Scripted Youth Coaching" (3 blocks of 4 weeks); "The First 90 Days" (3 blocks of 4); "Phase 1 - Foundation / Novice" (3 blocks of 13, 26 and 39 weeks); "Block Templates - Copy and Adapt" (2 blocks, `weeks` blank). `track_blocks.weeks` is nullable (migration :104), so a block can have no week count.
- OBSERVED: `listClassPlanTracks` returns every current active track that has at least one block (`classPlans.ts:58-61`), so all 6 appear on Class plans, not only FT1.

### Sessions
- OBSERVED: a day opens a workout template, and a template is issued to an athlete by `issueWorkoutTemplate` (`apps/web/src/server/pilot/workoutTemplates.ts:990`), after `planTemplateIssue` (:646) decides what is ready. The P22 contact gate runs at issue: `assertDrillClearOfMedicalRestriction` is called in `coachCards.ts:146` (import :13).

### athlete_development_blocks (the per-athlete record)
- OBSERVED: columns and shape: `infra/azure/pilot_slice_postgres_athlete_development_blocks_migration.sql:83-108`; status `draft | active | completed | cancelled` (:113-114); required `title` and `training_emphasis` (`athleteDevelopmentBlocks.ts:117-125`); `starts_on`/`ends_on` calendar dates (:126-135). No overlap constraint, on purpose: "Whether an athlete may be in two blocks at once is coaching doctrine, and an exclusion constraint would decide it silently" (migration comment, lines 60-72, bullet at about :67). A later one-column migration with a composite FK was named as the way to add a source link (same comment, :60-65).
- OBSERVED: the block row is "the coach's own plan ... computes nothing" (`athleteDevelopmentBlocks.ts:7-19`), and `training_emphasis` is "the coach's own words, written down verbatim" (:13-16).
- Closest precedent for the migration: `pilot_slice_postgres_athlete_development_block_competition_target_migration.sql` (adds `target_competition_id text null` at :82 and a composite FK at :100; 146 lines), with its runner `apps/web/scripts/pilot-apply-athlete-development-block-competition-target-migration.mjs` (185 lines), registered in `apps/web/package.json:375` and `:591`, `.github/workflows/apply-migrations.yml:200`, and covered by `apps/web/src/server/pilot/migrationDispatchCoverage.test.ts:316-325`.

### Who can create a development block today
- OBSERVED: `DEVELOPMENT_BLOCK_WRITE_ROLES = ['coach', 'organization_admin', 'admin']` (`athleteDevelopmentBlocks.ts:158`; owner decision 2026-08-28 "Admin and coaches", comment :46-53). Enforced by an active membership check (`hasBlockWriteMembership`, :201-213) inside `createDevelopmentBlock` (:224-276), and the athlete must be one the actor can reach (`canActorReachAthlete`, :253). The route repeats it: `AUTHOR_ROLES` at `apps/web/app/api/pilot/coach/development-blocks/route.ts:69`, `requireRole` at :234, `assertActorCanAccessAthlete` at :246, POST at :231-275.
- OBSERVED: `createDevelopmentBlock` writes one row with no transaction and no audit event (:255-273; `import` list :1-5 has no audit or transaction helper). `withTransaction` exists in `db.ts` and `writePilotAuditEvent` in `audit.ts` (both used by `medicalRestrictions.ts:6-8`).
- OBSERVED: the coach screen is `app/coach/development-blocks/page.tsx` (2,125 lines), gated `['coach', 'admin']` (:1146). The only "starting text" today is five fixed block templates (`developmentBlockTemplates.ts:24-31`, :75-150), hidden for minors unless the coach ticks an unsaved box (:153-195; OD-2026-10-04-014, `OWNER_DECISIONS.md:10898`).

### What the athlete and parent see today
- OBSERVED: `GET /api/pilot/athlete/development-blocks`, roles `['athlete', 'parent']` (`app/api/pilot/athlete/development-blocks/route.ts:73`, :181), through `assertActorCanAccessAthlete` (the GET handler starts at :178), and only blocks with status `active` or `completed` (:198-203; A-Q20 and PLAN-4, OD-2026-10-08-006). A draft is not shown. Screens: `app/athlete/development-blocks/page.tsx` (gate `['athlete']`, :58) and `app/parent/development-blocks/page.tsx` (gate `['parent']`, :123). The family projection carries no track information (the type at :100-130 has title, emphasis, dates, status, coach name, objectives).

### Class plans (FT1c)
- OBSERVED: `/coach/class-plans`, read-only, gate `['coach', 'admin']` (`app/coach/class-plans/page.tsx:253`; 257 lines), API `GET /api/pilot/training-tracks` (`app/api/pilot/training-tracks/route.ts:23-26`, `CLASS_PLAN_ROLES`), data from `classPlans.ts` (`getClassPlanTrack` :120-165). Ruling: coaches and gym admins only (OD-2026-11-12-005 ruling 2, `OWNER_DECISIONS.md:4811`). OD-2026-11-11-003 left "who besides coaches sees the track" not ruled (`:4985`).

### Name collision to avoid
- OBSERVED: the app already has "Tracks": a per-athlete label an admin sets on the Tracks screen, shown on the athlete's Tracks tab (OD-2026-10-07-010, `OWNER_DECISIONS.md:9097-9104`). OD-2026-11-12-005 chose "Class plans" for the training-track screen for that reason (`:4817`). The new action should use "Class plans" words ("Start on a class plan"), not "assign track". (INFERRED: this is a copy choice; the question list below does not ask it because OD-2026-11-12-005 already rules the screen name.)

## 2. What "start an athlete on a track" needs

1. **Migration** (own PR): `alter table pilot.athlete_development_blocks add column if not exists source_track_block_id text null`, a composite FK `(organization_id, source_track_block_id)` to `pilot.track_blocks(organization_id, track_block_id)`, and a partial index for reads. Same pattern as the competition-target migration. Idempotent. Registered the way earlier migrations are (runner, `package.json` x2, `apply-migrations.yml`, `migrationDispatchCoverage.test.ts`; the three registration files are the collision-rule exception). I never apply it. FK delete behaviour (restrict versus set null) is a design detail the PR tests; INFERRED that restrict is right because track rows are never deleted except with their organization, and UNVERIFIED that an organization cascade deletes both tables cleanly under restrict (the migration PR must prove it on a real database, `test:migrations`).
2. **Server function** `startAthleteOnTrack` (new file, e.g. `athleteTrackStart.ts`): in one transaction, check the actor's membership role (reuse `hasBlockWriteMembership`, no new role list), check the actor can reach the athlete (`canActorReachAthlete` path, same hidden-not-found answer), load the current version of the track and its blocks, refuse a track with any block lacking `weeks` or with no blocks, then write one `athlete_development_blocks` row per track block with `source_track_block_id` set, dates computed from the coach's start date plus the cumulative weeks, status `draft`. One audit row, field names only (the `medicalRestrictions.ts` pattern, :30-37). `createDevelopmentBlock` stays as it is; the new function shares `developmentBlockShapeError` rather than copying it (INFERRED; needs a small export, one line).
3. **Route**: `POST /api/pilot/coach/class-plans/start` (name for Overwatch to confirm), `AUTHOR_ROLES` exactly as the development-blocks route, a body of `{ athlete_id, track_id, starts_on }`, a 404 for an athlete the actor cannot reach, a 201 with the block ids. One new row in `apiRouteInventory.json` (registration-file exception).
4. **Coach screen**: on Class plans, a "Start an athlete on this plan" control on the track page (choose an athlete from the coach's accessible athletes, a start date, a preview of the dated weeks, one button). After it, the blocks show on `/coach/development-blocks` as drafts the coach reviews and activates there (existing activation path, `setDevelopmentBlockStatus`, `athleteDevelopmentBlocks.ts:353`). Gate stays `['coach', 'admin']`.
5. **Who may do it**: the same people who may author a development block today: coach, organization_admin, admin, with an active membership and reach to the athlete. This applies the 2026-08-28 ruling cited at `athleteDevelopmentBlocks.ts:46-53`; no role, gate or permission line changes (section 5 says so for Overwatch's approval step).
6. **What the athlete and parent see**: today, nothing until the coach sets a block `active`; then the block's title, emphasis and dates through the existing family route and screens. Whether they see more (the week-by-day list, the track name) is not ruled: question J2.

### Fill for the required text (design)
`training_emphasis` is required and non-blank (`athleteDevelopmentBlocks.ts:121-125`) and is defined as the coach's own words. INFERRED design: pre-fill title from the track block title and the emphasis from the track block's own description (`track_blocks.details->'description'`, per the migration comment at :99-101), saved as a draft the coach edits before activating, the way a block template pre-fills the form today (`developmentBlockTemplates.ts:10-17`). Question O2.

## 3. PR split

All draft PRs, in order, each its own PR; line 1 of each body STATUS; each carries `MIGRATIONS:`. Non-test line estimates are INFERRED from the precedents named above.

| PR | Content | Allowlist | Non-test size | MIGRATIONS |
|---|---|---|---|---|
| TRK-1 | migration: `source_track_block_id` + composite FK + index, runner, registration lines, migration test | `infra/azure/pilot_slice_postgres_athlete_development_block_source_track_migration.sql`, `apps/web/scripts/pilot-apply-athlete-development-block-source-track-migration.mjs`, `apps/web/package.json`, `.github/workflows/apply-migrations.yml`, `apps/web/src/server/pilot/migrationDispatchCoverage.test.ts`, one new `*.pg.test.ts` | about 260 (sql 60, runner 185, registrations 15) | the slug, e.g. `athlete-development-block-source-track` |
| TRK-2 | `startAthleteOnTrack`, shared shape check export, route, route inventory row, `privacyTiers.ts` note for the new column, pg test | new `athleteTrackStart.ts`, the new route file, `athleteDevelopmentBlocks.ts` (export only), `apiRouteInventory.json`, `privacyTiers.ts`, tests | about 320 (module 170, route 90, inventory 35, other 25) | NONE (needs TRK-1 merged and applied on the target) |
| TRK-3 | Class plans "Start an athlete" control, athlete picker, dated preview, blocks listed as drafts on the development-blocks screen with their source plan named | `app/coach/class-plans/page.tsx`, one new component file, `app/coach/development-blocks/page.tsx` (a few lines to name the source) | about 330 (new component 250, class-plans 40, development-blocks 40) | NONE |
| TRK-4 (only if J2 is B) | family view: the track name on the block, or the week-by-day list read-only for athlete and parent | `app/api/pilot/athlete/development-blocks/route.ts`, the two family pages, tests | about 250 to 400; split in two if over | NONE |

Estimated total, TRK-1 to TRK-3: about 910 non-test lines in three PRs. Migration alone in TRK-1 as the rules require. TRK-2 cannot ship before TRK-1 is merged and applied (INFERRED: a column that does not exist makes the insert fail), so Overwatch's apply step sits between them.

Collision check (OBSERVED 2026-11-28, `list_pull_requests`, open PRs): #2226, #2225, #2224 (dependency bumps; they touch package manifests, not the files above except possibly `apps/web/package.json`, which is the registration-file exception) and #2150 (research bridge liveness probe, infra). No open PR touches Class plans, development blocks, the training-track tables or the medical restriction module. UNVERIFIED: the PRs' file lists were not read file by file; each build PR repeats the check before push as the rules require.

## 4. Sizes and effort (INFERRED)

TRK-1 small and careful (migration, two adversarial reviewers under the rules, though OD-2026-11-28-001 bypasses review gating for merges; the lane will still run its own fresh-context reviewers for migrations, minors' data and permissions). TRK-2 medium (transaction, audit, org and athlete scoping). TRK-3 medium (one new screen section, 55px tap floor, 19.1px text). TRK-4 small to medium, and only if J2 is B.

## 5. Permission, role and gate statement (for Overwatch's approval)

No `requireRole`, `requirePageRole`, `RoleSessionGate`, `allowedRoles` or app/api permission line is changed. The new route copies `AUTHOR_ROLES = ['coach', 'organization_admin', 'admin']` from the development-blocks route (`route.ts:69`). The new screen control sits inside the existing Class plans gate `['coach', 'admin']` (`page.tsx:253`). OBSERVED difference to note, not change: the API role list names `organization_admin` and the page gate names `admin`; I did not read how the page role maps (UNVERIFIED), so the plan does not rely on an organization admin reaching the button.

## 6. Risks

- **Minors' data (kernel rule: unknown date of birth is a minor, OD-2026-10-04-010; L1 rule: no new warnings, gates or disclaimers).** A started track writes a coaching plan about one athlete. It goes through the same athlete-reach check as every block write, and the family read still filters to `active` and `completed`, so a draft started for a minor is not visible to the family until the coach activates it. Open: whether starting a minor on a track needs the same per-athlete tick as block templates (J1).
- **Medical holds, OD-2026-11-10-002 (contact hard gate).** OBSERVED: the gate is on entries: sparring-level sessions, drills, issues and competition entries (`medicalRestrictions.ts:1-20`, gated levels `controlled_sparring` and `open_sparring` at :457; OD-2026-11-15-007 `OWNER_DECISIONS.md:4498`, ruling "applies to boxing entries only" at :4290). INFERRED: a plan is not an entry, so starting a restricted athlete on a track writes a draft and does not need to be refused; the gate already refuses the sparring days when they are issued (`coachCards.ts:146`), and non-contact days still save and show the note, as OD-2026-11-10-002 rules. The lane adds no refusal, no new warning and no new disclaimer, and does not read or copy any medical field into the plan (field names only in the audit row). I did not find a ruling that says a restricted athlete may not be put on a contact-containing plan, so I do not add one (do not guess). Overwatch to confirm this reading in the GO. Another reason for the open J1 answer: the repo seed shows "Eight-week camp" and "Phase 1" tracks that carry load and taper percentages, which are the same kind of text OD-2026-10-04-014 treats specially for minors.
- **Version drift.** A later track version does not change a started athlete's blocks (they point to the old block rows, which are kept). The days of a block still resolve by lineage to the template's current version when the coach opens them (`classPlans.ts:139-157`); INFERRED fine for a coach plan, but it means "what the athlete started on" is the block list, not a frozen set of sessions.
- **Eight rows for FT1.** FT1 has 8 one-week blocks (seed), so one start writes 8 drafts. A family opening the list later sees up to 8 entries. Question O1 and J2 decide how that reads.
- **Blocks with no week count** (seed "Block Templates - Copy and Adapt") cannot be dated: the function refuses them by name, and the screen says why in the coach's words (not a warning to a family).
- **No double-start guard.** The table forbids nothing (migration comment); a second click would write 8 more drafts. TRK-2 needs an idempotency check (same athlete, track block and start date returns the existing rows). INFERRED, tested in TRK-2.
- **Name collision with "Tracks"** (section 1): copy only.
- **Public repo:** this file names no member, account or email.

## 7. Questions

Each is also posted as its own comment in the PR.

### QUESTION FOR Jason: Which training tracks may a coach start an athlete on, and do minors need the per-athlete tick?
OFFICIAL: Class plans lists 6 tracks that have blocks (FT1, Eight-week camp, 48-Session Youth, First 90 Days, Phase 1, Block Templates). The Eight-week camp titles and Phase 1 carry load and taper percentages; FT1 is "all ages" (DATA_MODEL.md:165). Options, recommended first: **A (Rec.): FT1 only for now**, other tracks open when their own lane says so; **B: any track whose blocks all have week counts, and for an athlete under 18 or with no date of birth the coach ticks an unsaved box first, as for block templates (OD-2026-10-04-014)**; **C: any track whose blocks all have week counts, no tick.**
PLAIN: right now only the 8-week non-contact plan is the one you approved building around. Do you want the Start button to work for only that plan, or for every plan on the page, and if every plan, should a coach have to tick a box before putting a child on one?
Checked, not answered in: `docs/current/OWNER_DECISIONS.md` searched for "track", "start an athlete", "development block", "class plan", "enrol", "assign", "minor", "all ages", "overlap"; OD-2026-11-11-003 (`:4985` "Not ruled"), OD-2026-11-10-003, OD-2026-11-12-005, OD-2026-10-04-014 (S&C block templates only; does not name tracks), OD-2026-10-07-010 (the older per-athlete Tracks label); `docs/backbone/DATA_MODEL.md`, `SCHEMA_PROPOSAL.md` P17; W4_SIZING.md (no section for this item); CLOUD_LANE_RULES.md.

### QUESTION FOR Jason: What do the athlete and a linked parent see after a coach starts the athlete on a plan?
OFFICIAL: Today the family route shows only blocks the coach has set active or completed: title, emphasis, dates, status, coach name (`athlete/development-blocks/route.ts:198-203`). Options, recommended first: **A (Rec.): nothing new**: each started block shows like any block once the coach activates it, with no week-by-day list and no new page (matches OD-2026-11-12-005's note that a member-facing page is a separate build); **B: also a read-only week-by-day list of the plan, for the athlete and the linked parent** (TRK-4 would build it).
PLAIN: after the coach starts a kid on the 8-week plan and turns it on, do the kid and parent see just "Week 3: ..." cards like any other training block, or the full day-by-day plan too?
Checked, not answered in: OWNER_DECISIONS.md searched for "parent", "athlete", "class plan", "track", "development block", "member-facing"; OD-2026-11-12-005 (rules coaches and admins only for Class plans; `:4985` of OD-2026-11-11-003 lists "who besides coaches sees the track" as not ruled); OD-2026-10-08-006 (A-Q20, PLAN-4: family sees active and completed blocks only; about blocks, not tracks); OD-2026-11-19-012 (drill provenance, coaches and admins only; not the plan); W4_SIZING.md.

### QUESTION FOR Jason: May an athlete be started on a plan while another development block of theirs is still active?
OFFICIAL: The table allows overlapping blocks on purpose (migration comment, "coaching doctrine"). Options, recommended first: **A (Rec.): allow it silently**, the coach decides, nothing is blocked or warned; **B: allow it but show the coach a one-line "already in a block through <date>"** on the start screen; **C: refuse until the other block is completed or cancelled.**
PLAIN: if a boxer is already in one of the coach's blocks, can the coach also start them on the 8-week plan?
Checked, not answered in: OWNER_DECISIONS.md searched for "overlap", "two blocks", "at the same time", "more than one block", "development block"; the development-blocks migration comment (leaves it open); `docs/capabilities/modules/036-periodization-block-planning-engine.md` (grepped for "overlap", "two blocks", "concurrent": no match); W4_SIZING.md.

### QUESTION FOR App Overwatch: One development block per track block, or one for the whole track?
OFFICIAL: DATA_MODEL.md:159-162 and P17 imply one athlete block per track block (the column is a single `source_track_block_id`). Options: **A (Rec.): one draft block per track block, all written at start (8 for FT1)**; B: one block spanning the track, linked to the first track block (loses the per-block link); C: one block at a time, the coach starts each week's block when it is due.
PLAIN: FT1 is 8 one-week blocks. Do we write 8 drafts at once, or one at a time?
Checked, not answered in: OWNER_DECISIONS.md (OD-2026-11-11-003 `:4985` leaves the column to this lane; nothing on shape), DATA_MODEL.md, SCHEMA_PROPOSAL.md, W4_SIZING.md, CLOUD_LANE_RULES.md.

### QUESTION FOR App Overwatch: What fills the required "training emphasis" on a started block?
OFFICIAL: it is required and defined as the coach's own words. Options: **A (Rec.): pre-fill from the track block's own description, saved as a draft, the coach edits before activating**; B: the coach types it at start (a form with 8 boxes for FT1); C: a fixed neutral line ("Class plan week N").
PLAIN: the app needs a sentence for each block; do we copy the plan's own text for the coach to adjust, or make the coach write it?
Checked, not answered in: OWNER_DECISIONS.md searched for "training emphasis", "block template"; OD-2026-10-04-014 (templates pre-fill the form for the coach to edit, precedent not ruling for tracks); `athleteDevelopmentBlocks.ts:13-16`; W4_SIZING.md.

## 8. Done when (this lane)

This PR posted as a draft with STATUS: WAITING-FOR-OVERWATCH, "plan ready" comment, a 30-minute check scheduled. No code until "OVERWATCH: GO".
