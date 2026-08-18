# Pass 6 — Data layer

Scope: the 88 SQL files in `infra/azure/` and the application code that depends
on them. Pinned to `origin/main` at `04dd116b`, on branch
`docs/full-spectrum-audit-2026-08-18`. Read-only: **no database was contacted,
no migration was run, nothing under `scripts/data/` was opened, and no
connection string or `AZURE_*` value appears below.**

De-duplicated against `AGENT_KERNEL.md`, `docs/capabilities/NETWORK_STATUS.md`
(read from `origin/docs/agent-handoff-briefs`, since it is not on `main` — the
coordination defect this audit's README already records), the three completed
passes in this directory, and `git log --oneline origin/main -40`.

One finding below is the direct answer to a question Pass 3 handed forward
rather than guessed at, and says so in place.

---

## Method

**Counts, not estimates.**

| | Count |
|---|---|
| SQL files in `infra/azure/` | 88 (1 base schema + 87 migrations), 12,113 lines |
| **Read in full, line by line** | **9** (2,344 lines) |
| **Read in substantial part** (300+ contiguous lines opened, or the whole of every table definition in the file) | **10** |
| **Never opened in a human-readable form** | **69** |

**Read in full:** `pilot_slice_postgres.sql` (1,397), `..._video_sessions_migration.sql`
(221), `..._safety_flags_migration.sql` (213), `..._clearance_register_migration.sql`
(131), `..._training_holds_migration.sql` (89), `..._data_retention_deletion_migration.sql`
(84), `..._guardian_media_consent_migration.sql` (83), `..._attendance_parent_method_migration.sql`
(72), `..._dead_schema_removal_migration.sql` (54).

**Read in substantial part:** `..._multidiscipline_`, `..._multiorg_`,
`..._shadow_runtime_`, `..._one_percent_club_`, `..._safety_gate_matrix_`,
`..._sparring_exposure_and_load_`, `..._rate_limit_`, `..._transfer_claims_`,
`..._method_naming_`, `..._shadow_decision_loop_`.

**The other 69 were machine-parsed, not read.** Every one of the 88 files went
through five mechanical passes over its full text (comments stripped): every
`create table` body extracted and diffed against duplicate declarations of the
same table; every `references pilot.X(...)` matched to its `on delete` action
across line breaks; every index and unique constraint collected; every
`check (...)`, `default`, `insert`, `drop`, `alter ... drop` catalogued; and the
migration order in `.github/workflows/apply-migrations.yml` walked for forward
references. That is how the claims about all 88 below are made. It finds
structure. It does not find a bad comment, a wrong seed value, or a subtly wrong
`where` clause in a view — **69 files could still hold one and this pass would
not know.**

**Code side.** 76 non-test statements touching `pilot.athletes` and 61 touching
`pilot.accounts` were enumerated and classified mechanically; every
`insert into pilot.*` with an `on conflict (...)` clause in `apps/web` was
matched against the unique constraints actually declared in SQL. Roughly 25
server modules and routes were opened by hand. **Nothing was executed.** Per
this audit's rule 5 and the kernel's invariant 5, source reading is not runtime
proof — reproduce anything below before acting on it.

**Refutation.** Every finding here was attacked before it was written: the whole
migration sequence was searched for a later file that adds the constraint,
index, or column claimed missing, and the `all` order in
`apply-migrations.yml` was used to decide whether such a file runs before or
after. Two candidate findings died that way and are recorded under *Checked and
found sound* rather than deleted.

---

## Safety-critical tables: what the schema permits vs. what the code assumes

### `pilot.training_holds`

Schema permits: exactly what the code assumes. Every column's nullability
matches `TrainingHoldRow` (`apps/web/src/server/pilot/trainingHolds.ts:63-81`)
field for field — `expires_at`, `lifted_by_account_id`, `lifted_at` nullable,
everything else not. The partial unique index
`idx_training_holds_one_active ... where status = 'active'` is the real
enforcement of "one active hold per athlete", and the module both pre-checks it
and catches `23505` to turn the loser of a race into the same caller-facing
conflict (`trainingHolds.ts:205-207`). The `athlete_explanation` CHECK and the
`expires_at > placed_at` CHECK are each mirrored ahead of the write at the route
(`app/api/pilot/training-holds/route.ts:174-178` and `:203-206`), the latter
with a deliberate 60-second clock-skew margin because `placed_at` is stamped by
the database. **This is the model the rest of the schema should be measured
against, and several tables below fall short of it.**

One asymmetry worth naming, not a finding of this pass: `getActiveTrainingHold`
swallows `42P01` (missing table) and returns `null` — "no hold" — which is
fail-open for a safety gate, but only in an environment where the migration has
not been applied. The module documents the choice.

### `pilot.safety_flags`

Schema permits: `athlete_id` and `person_account_id` both nullable, constrained
so at least one is set. The code's `SafetyFlagRow` types both as `string | null`
(`safetyFlags.ts:49-50`) — correct. Four table-level CHECKs
(`note_required`, `external_not_bypassed`, `external_resolution`,
`medical_human_only`) are each mirrored in TypeScript ahead of the write, with
`MEDICAL_HUMAN_ONLY_FLAG_CODES` exported as one set specifically so the pre-check
and the constraint "can never silently drift apart" (`safetyFlags.ts:35-42`). No
drift found.

The authorization gap on this table is Pass 2's F-20 (CRITICAL) and is not
re-reported here. Note only that the DB does back one of its mitigations for
real: `pilot_safety_flags_external_not_bypassed` is a database constraint, not a
convention.

### `pilot.waivers`

Schema permits **more than the code believes**. `waiver_type` and `status` are
bare `text not null` with no CHECK constraint — the vocabulary of a minor's
consent record exists only in TypeScript. See Finding 6. `parent_id` is
nullable and the consent gate filters `parent_id is not null`, so a
`photo_media` row written without one is invisible to the gate (fail-closed, and
Pass 3's Finding 6(a) already covers the consequence).

`covers_video boolean not null default true` is the DDL half of Pass 3's F-12
and is listed in the policy table below, not re-reported.

### `pilot.parents`

Schema permits a guardian record pointing at an account in another organization:
`account_id text null references pilot.accounts(account_id)` — a single-column
FK where every athlete-bearing table uses a composite one. **Already reported by
Pass 2** (`PASS-02-authorization.md`, LOW). Two things Pass 2 did not draw, both
below: the table has no FK *inbound* from `pilot.organization_memberships`
(Finding 9), and its outbound FK from `pilot.waivers` cannot execute its
declared `on delete` action (Finding 8).

### `pilot.athletes`

Schema permits a soft-deleted row to be read by everything. `deleted_at` was
added by the retention migration together with two partial indexes for "the
active-record path, which is every read" — and no read path filters it. **This
is Finding 1, and it is the answer to the question Pass 3 explicitly deferred
to this pass.**

Referentially, this table is the strong point of the schema: **73 of its 74
inbound foreign keys carry `on delete cascade`.** The 74th is Finding 2.

### `pilot.safety_escalations`

Schema and code agree exactly; `SafeEscalationRow`'s nullable set
(`escalationLadder.ts:53-73`) matches the DDL column for column. The
`source_type` CHECK admits nine values and the escalations migration carries a
catalog-guarded reconcile block that drops and re-adds it, so the base schema's
copy and the migration's copy cannot diverge in a live database. The stale
*TypeScript* copy of that union is Pass 4's F-05, already fixed on another
branch.

### `pilot.person_clearances`

Schema permits nothing the code disagrees with; the constraint
`pilot_person_clearances_current` (status `'current'` requires a verifier, a
verification timestamp and an issue date) is real and load-bearing. The module
knowingly delegates to it without a pre-check, and says so — Finding 10. The
register has zero callers, which is already recorded in `NETWORK_STATUS.md` and
bounds that finding to LOW.

### `pilot.video_sessions` and the media tables

Schema permits a row of a minor's video whose `organization_id` names no
organization, whose `athlete_id` names no athlete, and whose
`uploaded_by_account_id` names no account. The migration says so itself, in
those words, and calls it deliberate. What is *not* recorded anywhere is the
consequence for deletion — Finding 3. `athlete_id` is correctly typed
`string | null` in `videoSessions.ts:7`; the status and scan-state vocabularies
are CHECK-constrained and match the code.

---

## Policy hiding in DDL

Every `default true` on a consent, permission, visibility, or status column in
all 88 files, and what each one decides. Four `active_flag`-style "is this row
live" defaults on registry tables (`organizations`, `accounts`,
`organization_memberships`, `volunteers`, `safety_gates`, `clearance_types`,
`disciplines`, `drills`, `gear_vendors`, `compliance_rules`, `cohorts`,
`workout_templates`, `assessment_protocols`, `behavior_standards`,
`announcement_placements`) are omitted: they mean "not yet retired" and decide
nothing about a child.

| Column | Default | Where | What it decides | Read by |
|---|---|---|---|---|
| `pilot.waivers.covers_video` | **`true`** | `..._guardian_media_consent_migration.sql:55` | Whether a guardian's media consent is taken to cover **video as well as photographs** — set on *every* waiver row, including `general`, `medical_release` and `travel` rows that were never about media | Recorded and displayed; **enforced by no gate.** Pass 3 F-12 (HIGH). Repeated in code as `input.coversVideo ?? true` (`intake.ts:515`) |
| `pilot.waivers.public_use_allowed` | `false` | `..._guardian_media_consent_migration.sql:58` | Whether a child's image may be used publicly | Same — recorded, unenforced. **Fail-closed default; correct.** |
| `pilot.disciplines.youth_permitted` | **`true`** | `..._multidiscipline_migration.sql:44` | Whether a discipline (boxing, wrestling, BJJ, combatives) is open to minors. A discipline row created without naming it declares youth training permitted | **Display only.** One reader: `app/coach/disciplines/page.tsx:155` renders "Youth permitted"/"Adults only". No gate consults it |
| `pilot.disciplines.adult_permitted` | `true` | `..._multidiscipline_migration.sql:45` | Same, for adults | No reader at all |
| `pilot.disciplines.mixed_age_permitted` | `false` | `..._multidiscipline_migration.sql:46` | Whether parent-and-child sessions are allowed | Display only. **Fail-closed; correct.** |
| `pilot.emergency_contacts.is_primary` | **`true`** | `pilot_slice_postgres.sql:384` | Which contact is *the* emergency contact for a minor. With no uniqueness constraint and `params.isPrimary ?? true` in the only writer, every contact is primary | Read by the roster export's tie-break. **Finding 5.** |
| `pilot.transfer_claims.athlete_facing` | **`true`** | `..._transfer_claims_migration.sql:56` | The file's own comment calls it "Display control" — whether a neuro/transfer claim is shown to an athlete or parent | **Zero readers in the entire repository.** Decides nothing today; whoever wires it inherits "athlete-facing by default". Finding 12 |
| `pilot.transfer_claims.public_facing` | `false` | `..._transfer_claims_migration.sql:57` | Public/grant-application use of the same claim | Zero readers. Fail-closed default |
| `pilot.competence_levels.requires_coach_approval` | `true` | `..._competence_cohorts_migration.sql:126` | Whether entering a competence level needs a coach's sign-off | Read (`competenceCohorts.ts:327`) and surfaced at `app/coach/cohorts/page.tsx:187`. **Restrictive default; correct.** |
| `pilot.assessment_protocols.human_authority_required` | `true` | `..._assessment_protocols_migration.sql:54` | Whether an assessment needs a human decision | Restrictive default; correct |
| `human_review_required` (7 SHADOW tables) | `true` | `pilot_slice_postgres.sql:489`, `:1053`, `:1075`, `:1340`; `..._shadow_runtime_migration.sql:180`, `:205`, `:226`, `:237` | Whether a SHADOW effectiveness/learning row counts before a human has looked | Restrictive default; correct, and consistent across all seven |

**The pattern:** every default that decides something *about a child's exposure*
is fail-closed except two — `covers_video` (already a HIGH finding of Pass 3)
and `emergency_contacts.is_primary` (Finding 5). `youth_permitted` looks like a
third but is not, because nothing reads it; that is its own kind of problem and
is stated as such rather than dressed up as a gate.

---

## Findings

### [HIGH] Soft delete is written, indexed for, and filtered by nothing — a "deleted" child stays visible everywhere for two years, and a "deleted" guardian keeps logging in

**What is wrong.** The retention migration adds `deleted_at` to `pilot.athletes`
and `pilot.accounts`, and adds two partial indexes explicitly built for the
filter it expects every read to apply:

> `-- --- Partial indexes: the active-record path, which is every read ---`
> `create index if not exists idx_athletes_active_org`
> `  on pilot.athletes(organization_id, athlete_id)`
> `  where deleted_at is null;`
> — `infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:25-28`

No read applies it. Enumerated mechanically across `apps/web`, excluding test
files: **76 non-test statements reference `pilot.athletes`; 4 mention
`deleted_at`, and all four are inside `dataDeletion.ts` itself** (lines 72, 139,
210, 265 — the writer, the counter, and the purge). **61 non-test statements
reference `pilot.accounts`; 3 mention `deleted_at`, all three again in
`dataDeletion.ts`** (63, 219, 272). The org roster read is representative:

> `      'select * from pilot.athletes where organization_id = $1 order by created_at desc',`
> — `apps/web/src/server/pilot/entities.ts:259`

The write is a bare timestamp and touches nothing else:

> `      `update pilot.accounts`
> `         set deleted_at = now(), updated_at = now()`
> `       where account_id = $1`
> — `apps/web/src/server/pilot/dataDeletion.ts:63-65`

**Refutation attempted, four ways.**
(a) *A later migration adds a view or rule that filters it* — no; `deleted_at`
appears in exactly one migration file, and nothing creates a filtered view over
`pilot.athletes` or `pilot.accounts`.
(b) *`active_flag` is set too, and readers filter that* — no. The UPDATE above
sets `deleted_at` and `updated_at` and nothing else; `deleteAthleteRecord`'s
UPDATE (`dataDeletion.ts:139-142`) is the same shape. The login path checks
`active_flag` at `auth.ts:127`, `:208` and `:297` and never `deleted_at`, so a
soft-deleted guardian account still resolves a principal.
(c) *It is unreachable* — no. `POST /api/pilot/admin/data-deletion` calls both
functions (`app/api/pilot/admin/data-deletion/route.ts:50` and `:59`) for any
organization admin.
(d) *Pass 3 already reported this* — no, and it is the reverse. Pass 3 recorded
under "Could not establish": *"Whether `pilot.athletes.deleted_at` is filtered by
athlete-facing list queries generally... that belongs to pass 2 or 6"*
(`PASS-03-minors-consent.md:900-903`). It established only that
`getSubjectIdentity` does not filter it, and correctly called that the *safe*
direction for portraits. Generally, it is the unsafe direction.

**Consequence for a real child.** A family withdraws. An organization admin uses
the right-to-be-forgotten route; the response comes back
`{ deletedRecordsCounts: { athletes: 1 }, deletedAt: ... }` and an audit row
records `data_deletion_initiated`. Nothing changes. The child stays on the coach
roster, in the org-wide consent console, in the admin athlete list, in the
roster CSV export, and in every athlete-scoped read — for the two-year retention
window, at the end of which the purge is supposed to remove them (and cannot;
see Finding 2). The guardian's account, "deleted", continues to authenticate and
continues to read that child's holds, messages and safety surfaces for its
one-year window. The two partial indexes exist to make a filter fast that no
query performs.

This is not the same as Pass 3's F-17 (`DATA_RETENTION.md` promises blob
deletion no code performs). That is about bytes in storage. This is about the
row deletion the code *does* perform having no visible effect.

---

### [HIGH] The retention hard-delete cannot succeed: two foreign keys with no `on delete` action block both halves of the purge, in one transaction

**What is wrong.** `pilot.athletes` has 74 inbound foreign keys. Seventy-three
carry `on delete cascade`. The seventy-fourth, added by the most recent
migration in the `all` order, does not:

> `  constraint pilot_one_percent_nominations_athlete_fk`
> `    foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id),`
> — `infra/azure/pilot_slice_postgres_one_percent_club_migration.sql:61-62`

Nominations are never removed by design — the same file states *"Nothing is
deleted to resolve a nomination -- a withdrawal stays on the record"*
(`:65-66`) — so a withdrawn or expired nomination blocks the delete exactly as
an open one does.

The account half is blocked by an older one:

> `  account_id text null references pilot.accounts(account_id),`
> — `infra/azure/pilot_slice_postgres.sql:267`

Every provisioned guardian has a `pilot.parents` row whose `account_id` is their
account — `staffProvisioning.ts:469-478` writes it on every guardian invite —
so `delete from pilot.accounts ... and role = 'parent'` raises `23503` for any
real guardian.

Both deletes and the audit insert are one transaction, deliberately:

> `      `delete from pilot.athletes`
> `        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:131-132`

so a single blocking row aborts the entire run, for every family, and the
operator gets one identifier-only line:

> `      event: 'retention.cleanup.failed',`
> `      reason: error instanceof Error ? error.name : 'UnknownError',`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:168-169`

**Refutation attempted.** (a) *A later migration adds the cascade* — no;
`one-percent-club` is the **last** entry in the `all` list and nothing alters
`pilot.parents` in any file (`grep -n "alter table pilot.parents" infra/azure/*.sql`
returns nothing). (b) *The purge deletes `pilot.parents` first* — no; the script
and `dataDeletion.ts:199-249` delete from exactly two tables. (c) *The FKs are
deferrable* — no; neither carries `deferrable`, so both are checked immediately.
(d) *The tests would have caught it* — they do not, and this is the useful part:
the pg suite seeds a bare athlete with no dependent rows
(`dataRetentionDeletion.pg.test.ts:213-218`) and asserts
`'applying deletes the expired row and records that it did'` (`:267`). It never
seeds a nomination, and it never runs the purge against a guardian account past
its window at all — the `pilot.parents` rows it does create (`:331`, `:381`,
`:435`) are for the *soft*-delete cascade tests. The suite is green and the
behaviour is broken.

**Consequence.** The direction of failure is safe — nothing is over-deleted —
but the retention policy cannot execute. Records this platform committed to
destroying stay indefinitely, the nightly dry run reports a count of rows that
*would* be deleted and cannot be, and the workflow's own framing of that dry run
as "the monitor" (`.github/workflows/retention-cleanup.yml:36-39`) reports a
number that is wrong in the reassuring direction.

Not CRITICAL by this audit's bar: no minor's data is exposed to anyone new and
no safety gate is defeated. It is HIGH because it is a policy the organization
has published that the schema makes unexecutable, and because it is silent.

---

### [MEDIUM] `pilot.video_sessions` — minors' footage with no foreign key to organization, athlete, or uploader; deleting an athlete leaves the row and its blob path behind

**What is wrong.** The migration states the gap itself:

> `--   * organization_id has no foreign key to pilot.organizations, unlike every`
> `--     other multi-org table.`
> `--   * uploaded_by_account_id has no foreign key to pilot.accounts.`
> `--   * athlete_id has no composite foreign key to pilot.athletes.`
> — `infra/azure/pilot_slice_postgres_video_sessions_migration.sql:50-53`

and explains the omission as deliberate — the shape was copied from a
route-created table and adding FKs "requires knowing whether existing rows would
violate them". That reasoning is sound for the *addition*. What no file records
is what the absence costs on deletion.

`pilot.video_publications` and `pilot.research_library` both cascade from
`pilot.athletes`. `pilot.video_sessions` does not. So when an athlete row is
hard-deleted, the child's published media disappears and **the source video
row — with its `blob_path` — survives**, still listed to every organization
admin by the unfiltered branch of `/api/pilot/video/list`
(`app/api/pilot/video/list/route.ts:119-125`).

The same absence runs the other way: `pilot.compliance_violations.video_session_id`
(`..._compliance_migration.sql:61`) and `pilot.research_library.video_session_id`
(`..._publications_migration.sql:79`) both reference `pilot.video_sessions` with
no `on delete` action, so a video row can never be deleted once either exists.

**Refutation attempted.** Searched every one of the 88 files for an
`alter table ... add constraint ... foreign key` touching `video_sessions`.
There is exactly one `alter ... add constraint ... foreign key` in the whole
directory (`..._multiorg_migration.sql:185`) and it targets
`pilot.organizations`, not this table. The gap is still open.

**Bounded honestly:** Finding 2 means the athlete hard-delete cannot currently
run at all, so this is latent, not live. Fixing Finding 2 without fixing this
one makes it live.

---

### [MEDIUM] The org-wide consent console is 1 + 2N queries, unbounded

**What is wrong.** `listOrganizationConsentStatus` reads every athlete in the
organization and then calls `checkGuardianMediaConsent` once per athlete inside
a `Promise.all`:

> `  return Promise.all(`
> `    athletes.map(async (athlete) => ({`
> `      athleteId: athlete.athlete_id,`
> `      athleteName: athlete.full_name,`
> `      consent: await checkGuardianMediaConsent(organizationId, athlete.athlete_id),`
> — `apps/web/src/server/pilot/guardianConsent.ts:317-321`

and each of those runs **two** queries — one on `pilot.guardian_links`
(`:106-109`), one `distinct on` over `pilot.waivers` (`:72-78`). The only
caller passes no page:

> `    const rows = await listOrganizationConsentStatus(principal.organizationId);`
> — `apps/web/app/api/pilot/admin/athlete-consent/route.ts:22`

**Refutation attempted.** The unbounded half is a **recorded decision**, not an
oversight — the module argues it at `guardianConsent.ts:300-305` ("a default cap
would silently drop athletes from the one screen whose entire purpose is
catching a missing or lapsed consent"), which is the reasoning PR #427 ("Bound
five unpaginated queries, but not by blindly adding LIMIT") established. That
half is correct and is not the finding. The finding is the **2N round trips**,
which the comment does not address and which nothing prevents: the same answer
is obtainable in one query with a `distinct on` lateral, exactly the shape
`waiverCompliance.ts:41-59` already uses on the same two tables. `Promise.all`
makes them concurrent, not fewer; a 200-athlete gym issues 401 queries against
the pool on one page load.

---

### [MEDIUM] Every emergency contact for a minor defaults to "primary", nothing enforces one, and the roster export silently picks the oldest

**What is wrong.** Three things line up.

The column defaults permissive:

> `  is_primary boolean not null default true,`
> — `infra/azure/pilot_slice_postgres.sql:384`

The only writer defaults permissive too, and never demotes an existing row:

> `        params.isPrimary ?? true,`
> — `apps/web/src/server/pilot/intake.ts:438`

and there is no unique constraint or partial unique index on
`(organization_id, athlete_id) where is_primary` anywhere in the 88 files — the
table's only constraints are its primary key and its athlete FK
(`pilot_slice_postgres.sql:388-389`), and its only index is
`(organization_id, athlete_id, created_at desc)` (`:467`).

The consumer that matters resolves "the" contact by a tie-break that the above
makes meaningless:

> `       order by c.is_primary desc, c.created_at asc`
> `       limit 1`
> — `apps/web/app/api/pilot/admin/export/roster/route.ts:81-82`

**Refutation attempted.** Searched for any code that sets `is_primary = false`
on a sibling row when a new primary is added — there is none; `is_primary`
appears in exactly one write path (`intake.ts:438`) and is otherwise read-only
(`app/admin/athletes/page.tsx:67`, `:673`). Searched every migration for a
uniqueness constraint on the column — none.

**Consequence.** A family adds a second emergency contact after a divorce, a
move, or a phone-number change. Both rows are `is_primary = true`. The roster
export — the sheet a coach carries to a competition — deterministically prints
the **first** one entered, the stale one, and the admin UI shows a "primary"
badge on both. TypeScript-level uniqueness would fix it; a partial unique index
would make it impossible.

---

### [MEDIUM] The consent vocabulary of a minor's waiver is enforced only in TypeScript, and reaches the column straight from a request body

**What is wrong.** `pilot.waivers` carries no CHECK on either column that
defines what a waiver *is*:

> `  waiver_type text not null,`
> — `infra/azure/pilot_slice_postgres.sql:413`
> `  status text not null,`
> — `infra/azure/pilot_slice_postgres.sql:418`

The writer takes both as free strings:

> `  waiverType: string;`
> ...
> `  status: string;`
> — `apps/web/src/server/pilot/intake.ts:483,488`

and the reachable route passes them through from the body with a default and no
validation:

> `        waiverType: asString(body.payload.waiver_type, 'general'),`
> ...
> `        status: asString(body.payload.status, 'signed'),`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:93,98`

The contrast is what makes this a miss rather than a choice. `pilot.training_holds.status`,
`pilot.safety_flags.status`, `pilot.safety_escalations.status`,
`pilot.person_clearances.status`, `pilot.intake_documents.review_status`,
`pilot.intake_cases.status`, `pilot.shadow_medical_administrative_status.status`
and `pilot.video_sessions.status` all carry CHECK constraints. The consent table
does not. The same is true of `pilot.medical_intake.clearance_status`
(`pilot_slice_postgres.sql:401`) and `pilot.athletes.gym_status` (`:68`) and
`pilot.attendance.status` (`:293`).

**Refutation attempted, and it lowers the severity.** I traced every consumer of
`waivers.status` to find out which direction an out-of-vocabulary value fails
in. All of them fail **closed**: `checkGuardianMediaConsent` computes
`missingParentIds` as `perGuardian.filter((g) => g.status !== 'signed')`
(`guardianConsent.ts:126`), and the transactional variant does the same
(`:180`) — an unrecognised status reads as *no consent*, never as consent. The
clearance gate is the same shape: `if (record?.status === 'cleared')`
(`contactClearanceGate.ts:144`), against a column that *does* have a CHECK. So
this is not a route to a defeated gate, and it is MEDIUM rather than HIGH.

**Consequence.** A miskeyed or drifted `waiver_type` — `'photo-media'` for
`'photo_media'` — makes a signed consent invisible to the gate while the admin
consent console reports it present, which is the *same disagreement class* Pass
3 recorded as F-16 from a different direction. And a schema that will accept any
string is a schema that cannot be relied on to tell an auditor what consents
exist.

---

### [LOW] `pilot_waivers_parent_fk` declares `on delete set null` on a composite whose first column is `not null` — the action cannot execute

**What is wrong.**

> `      foreign key (organization_id, parent_id) references pilot.parents(organization_id, parent_id)`
> `      on delete set null;`
> — `infra/azure/pilot_slice_postgres_guardian_media_consent_migration.sql:69-70`

PostgreSQL's `ON DELETE SET NULL` with no column list sets **every** referencing
column to NULL. `pilot.waivers.organization_id` is `text not null`
(`pilot_slice_postgres.sql:410`). So deleting a `pilot.parents` row that any
waiver references does not null the `parent_id` — it raises a not-null violation
and aborts the delete.

**Refutation attempted.** (a) *A later migration fixes it* — no; this is the
only reference to `pilot.parents` from `pilot.waivers` in the 88 files. (b) *It
is unreachable* — largely yes, and that is why this is LOW: `delete from
pilot.parents` appears nowhere in non-test application code. The three
occurrences are two pg test teardowns and
`apps/web/scripts/rehearse-seed-guardians.mjs:210`. (c) *`MATCH SIMPLE` saves
it* — that only means the constraint is *not checked* when `parent_id` is null;
it does not change what the delete action does to a row where it is set.

**Consequence.** Latent. Whoever writes the guardian-record cleanup that the
duplicate-guardian and stranded-guardian modules imply will find that deleting a
guardian who ever signed a media consent fails with `23502`, surfacing through
`jsonError` as an opaque `Internal server error` (see Finding 10).

---

### [LOW] `pilot.organization_memberships.account_id` has no foreign key to `pilot.accounts`

**What is wrong.**

> `create table if not exists pilot.organization_memberships (`
> `  account_id text not null,`
> — `infra/azure/pilot_slice_postgres.sql:15-16`

`organization_id` on the very next line references `pilot.organizations` with
`on delete cascade`; `account_id` references nothing. This is the table
`resolvePrincipal` reads to decide a caller's role
(`..._session_expiry_migration.sql:83`), so a role grant can name an account
that does not exist, and deleting an account leaves its role grant behind rather
than cascading or refusing.

**Refutation attempted.** Both declarations of the table (base schema and
`..._multiorg_migration.sql:15-23`) are byte-identical on this point, and no
migration adds the constraint — the only `add constraint ... foreign key` in the
directory targets `organization_id`.

**Consequence.** Bounded by Finding 2 (accounts cannot currently be purged) and
by `auth.ts:290` requiring `om.active_flag = true` **and** joining
`pilot.accounts` for the account row, so an orphan membership alone grants
nothing. It is recorded because it is the one identity join in the schema with
no referential backing, and because a future purge that *does* succeed leaves
role grants for deleted people.

---

### [LOW] No SQLSTATE mapping anywhere — a constraint the code does not mirror becomes `Internal server error`, and at least one module relies on that path by design

**What is wrong.** `jsonError` is the single error translator for the API. It
branches on `PilotError`, three named error classes, and five message prefixes,
and then:

> `    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });`
> — `apps/web/src/server/pilot/http.ts:171`

There is no branch for `23514` (check violation), `23503` (foreign key),
`23505` (unique) or `23502` (not null). Individual modules translate their own —
`trainingHolds.ts:205`, `activityLog.ts:145` — but nothing generic exists.

One module documents that it depends on that path:

> ` * does not decide anything itself. status='current' requires`
> ` * verified_by_account_id, verified_at, and issued_on`
> ` * (pilot_person_clearances_current); callers passing status='current'`
> ` * without a verifier hit that constraint, same as any other write path.`
> — `apps/web/src/server/pilot/clearanceRegister.ts:132-136`

**Refutation attempted, and it lowers this to LOW twice over.** First: I checked
whether the safety-critical CHECK constraints are in fact mirrored, and they
are — see *Checked and found sound*. Second: `recordPersonClearance` has **zero
callers**, which `NETWORK_STATUS.md` already records for the register as a
whole. So the acknowledged reliance is currently unreachable.

**Consequence.** Whoever wires the clearance register — the blocked item at the
top of `NETWORK_STATUS.md`'s "still open" list — gets a 500 with no message
where the constraint is doing exactly its job, and an admin who forgot to name
the verifier is told the server broke.

---

### [LOW] `pilot.mixed_age_session_records.youth_athlete_id` has no foreign key, while its sibling in the same migration does

**What is wrong.** The safeguarding record of a youth athlete paired with an
adult names the child with a bare text column:

> `  youth_athlete_id    text not null,`
> — `infra/azure/pilot_slice_postgres_multidiscipline_migration.sql:155`

Its constraints are the primary key, an FK to `pilot.activity_log`, and the
`unrelated_adult` note check (`:165-172`). No FK to `pilot.athletes`. Two tables
earlier in the same file, `pilot.grappling_exposure` carries
`pilot_grappling_exposure_athlete_fk ... references pilot.athletes(organization_id, athlete_id) on delete cascade`
(`:102-103`), which is what makes this an inconsistency rather than a house
style.

**Refutation attempted.** No later migration adds it. This is also true of
`pilot.intake_cases.primary_athlete_id` (`pilot_slice_postgres.sql:343`) and
`pilot.shadow_chat_audit.athlete_id` (`:526`); `pilot.accounts.athlete_id`
(`:32`) is the missing FK behind Pass 3's F-15 and is not re-reported.

**Bounded honestly:** `recordMixedAgeSession` has **no non-test caller** — the
route's own header says so (`app/api/pilot/multidiscipline/route.ts:14-15`) —
so nothing can write a bad row today. LOW for that reason, recorded so it is
fixed before the write path is built rather than after.

---

### [LOW] `pilot.sparring_exposure.sparring_type` is the one vocabulary column in its table without a CHECK, and the exposure counter would return `NaN` for an unknown value

**What is wrong.**

> `  sparring_type       text not null,   -- hard | play | technical | game | conditioned`
> — `infra/azure/pilot_slice_postgres_sparring_exposure_and_load_migration.sql:56`

The comment names the vocabulary; nothing enforces it. In the same table,
`coach_observed_intensity`, `coach_observed_head_contact` and
`athlete_presentation` all carry CHECKs (`:68-74`), as does `round_type` on the
grappling counterpart (`..._multidiscipline_migration.sql:69-70`).

The consumer indexes a fixed record by that value:

> `    segmentsByType[segment.sparring_type] += 1;`
> — `apps/web/src/server/pilot/sparringExposure.ts:206`

so a value outside the union adds a key whose value is `undefined + 1` = `NaN`,
in the counter that tells a coach how much head-impact exposure a child has
taken.

**Refutation attempted, and it is decisive for severity.**
`recordSparringExposure` has **zero non-test callers** — the only references in
the whole repository are its own definition and `sparringExposure.pg.test.ts`.
No route reaches it. Nothing can write a bad `sparring_type` today. LOW, and
recorded only because the exposure surface is one somebody will wire.

---

### [LOW] `pilot.activity_log` is queried by `athlete_id` with no index on it, unbounded by default

**What is wrong.** The table's three indexes lead on `person_account_id` or
`activity_domain`; none leads on `(organization_id, athlete_id)`. The reader
filters on `athlete_id` and defaults to no limit:

> `       and ($3::text is null or athlete_id = $3)`
> — `apps/web/src/server/pilot/activityLog.ts:175`
> `       ${filter.limit ? 'limit $7' : ''}`
> — `apps/web/src/server/pilot/activityLog.ts:180`

**Refutation attempted.** The unbounded default is argued in the file
(`:165-169`: a volunteer-hours total that goes "to a school, a court, or a
scholarship committee" must not be silently truncated) — same reasoning as
#427, and correct. The *index* is not argued anywhere, and this is the table
that grows per athlete per training day. `pilot.activity_log` is also the one
athlete-bearing table where the org-scoped index does not match the org-scoped
query the app runs; the other eleven flagged by the same sweep are either
join-table reads (`assignment_completions`, `floor_plan_members`,
`external_competition_entries`, `wrestling_league_roster_entries`) or covered by
a status/class-leading index that answers their actual query.

---

### [LOW] `pilot.transfer_claims` has no reader anywhere, and its display-control column defaults to athlete-facing

Covered in the policy table above. Recorded separately because it is the same
class the repository already handled once deliberately: three tables with zero
read or write paths were dropped by
`pilot_slice_postgres_dead_schema_removal_migration.sql:52-54` under a recorded
owner decision. `pilot.transfer_claims` is written only by
`sessionScriptsTransfer.pg.test.ts` and read by nothing — it is either a fourth
candidate for that treatment or an unfinished capability, and which one it is
needs the owner, not a builder.

---

## Checked and found sound

Things I went looking for and did not find. Recorded so the next pass does not
spend an afternoon on them.

**Migration ordering and coverage — genuinely clean.** `apps/web/package.json`
declares 88 `pilot:apply-*` scripts (87 migrations + `schema`). The `all` loop in
`.github/workflows/apply-migrations.yml` runs exactly 87, with **no duplicates,
nothing missing, and nothing in the loop that lacks a script.** The `list-check`
option exists precisely to guard that and it currently passes by inspection.
More importantly: I walked the `all` order and, for each migration, checked every
`pilot.*` object it references against the position of the migration that creates
it. **Zero forward references.** Three apparent hits were views each file creates
itself with `create or replace view` (`..._floor_hours_ledger_migration.sql:52`,
`..._retraction_surveillance_migration.sql:96`,
`..._source_citation_checks_migration.sql:81`). The order is dependency-correct.

**Zero `ON CONFLICT` / unique-constraint mismatches.** Every
`insert into pilot.*` with an `on conflict (columns)` clause in `apps/web` —
all of them — was matched against the unique constraints and unique indexes
actually declared across the 88 files. **Every one has a matching unique
constraint.** This is the `42P10` class that produces a runtime 500 from a
perfectly valid-looking insert, and it does not exist here. Notably
`shadow_recommendation_effectiveness.feedback_id` is declared `bigint null unique`
inline (`pilot_slice_postgres.sql:1045`), which is easy to miss and is correct.

**Seed inserts are idempotent.** Three migrations insert data. All three guard:
`..._method_naming_migration.sql:46` (`on conflict (method_key) do nothing`) and
both `pilot.safety_gates` seeds (`..._safety_gate_matrix_migration.sql:131`,
`:165`), which additionally filter `organization_id not in (select ... )` before
the `on conflict`.

**New organizations get their safety gates.** The migration seeds only
organizations that exist when it runs, which would leave a gym onboarded later
with no `pilot.safety_gates` rows and therefore no FK target for
`pilot.safety_gate_evaluations`. That is closed:
`apps/web/src/server/pilot/safetyGateSeeds.ts` exists for exactly this, is
imported by `auth.ts:12`, uses deterministic ids matching the migration's
construction, and `safetyGateSeedsOwnership.test.ts` fails the build if the two
lists diverge. And `contactClearanceGate.ts:145-151` still records the
evaluation best-effort in case a gate row is absent. Two layers, both real.

**Duplicate table declarations do not leave a live database in two shapes.**
Thirty-three tables are declared in two files (base schema plus a migration).
Eight pairs differ textually; six differ only in whitespace or constraint
naming. The two that differ **materially** are both reconciled by a later
migration, which is why neither is a finding:
- `pilot.scheduler_attendance.method` admits `'parent'` in the base schema and
  not in `..._scheduler_tables_migration.sql:85`. `..._attendance_parent_method_migration.sql:64-70`
  drops both possible constraint names and re-adds the correct one on every run,
  and runs **after** `scheduler-tables` in the `all` order.
- `pilot.shadow_research_requirements` carries a four-column `unique(...)` in the
  base schema (`pilot_slice_postgres.sql:1035`) and not in
  `..._shadow_runtime_migration.sql:153-171`, while `shadowResearch.ts:52` uses
  `on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)`.
  I wrote this up as a finding and then **retracted it**: the same migration adds
  `idx_shadow_research_requirements_source` on exactly those four columns at
  `:537-543`, after a precheck at `:426-438` that aborts if duplicates exist.

**Destructive statements are all accounted for.** Across 88 files: three
`drop table if exists` (`..._dead_schema_removal_migration.sql:52-54`), each
under a recorded owner decision dated 2026-08-07, deliberately not `CASCADE`
so an unknown inbound reference fails loudly. One `drop index`
(`..._drill_versioning_migration.sql:213`). One `drop trigger if exists`
immediately followed by its `create trigger`
(`..._data_retention_deletion_migration.sql:72-78`). Everything else is a
`drop constraint` inside a catalog-guarded or `if exists` reconcile block
whose next statement re-adds it. **No `delete from`, no `truncate`, no
`alter table ... drop column` anywhere in the 88 files.**

**Tenancy columns.** 162 distinct tables. **Three lack `organization_id`**, and
all three are justified in their own headers:
`pilot.auth_rate_limit_buckets` (an opaque salted bucket key — the migration
argues it at `..._rate_limit_migration.sql:41-46` and the column list bears it
out), `pilot.methods` (a product-wide constant, argued at
`..._method_naming_migration.sql:27-29`), and `pilot.document_ingest_audit`
(`pilot_slice_postgres.sql:825-832`). **No table holding a child's records lacks
an organization column.** `pilot.document_ingest_audit` is the one I would keep
an eye on — it carries `file_name` and a free `details jsonb` for intake
documents, which are medical forms and waivers — but its shape gives no per-org
read path to leak across, and I did not trace its writers.

**Safety-critical CHECK constraints are mirrored in TypeScript, carefully.** I
checked each of the constraints that encode a safeguarding rule and found a
pre-check ahead of every reachable one, each trimming the string the same way
`btrim` does: `pilot_grappling_exposure_choke_note` →
`multidiscipline.ts:132-135`; `pilot_mixed_age_unrelated` →
`multidiscipline.ts:311-316`; `pilot_safety_flags_medical_human_only` →
`safetyFlags.ts:119`; `pilot_safety_flags_note_required` → `MIN_NOTE_LENGTH`;
the `athlete_explanation` and `expires_at` checks on `pilot.training_holds` →
`app/api/pilot/training-holds/route.ts:174` and `:203`. The last of those
mirrors the constraint *with a clock-skew margin* because the DB stamps
`placed_at` itself — that is the standard the rest of the schema should be held
to, and it is largely met.

**The escalation ladder's N+1 is bounded and acknowledged.**
`detectRepeatedPatternEscalations` runs one idempotency query and one
`fileEscalation` transaction per candidate (`escalationLadder.ts:501-527`), but
the candidate set is a `having count(*) >= threshold` aggregate, the module
states it "runs on-demand (an admin action), not on a hot write path"
(`:472-475`), and `idx_safety_escalations_org_athlete` supports the per-candidate
lookup. Not a finding; PR #434 already swept this class.

**The video listing routes are all bounded** by `parseSafeLimit(..., 50, 100)`
(`app/api/pilot/video/list/route.ts:34`), including the deliberately broad coach
branch whose breadth is documented and owner-confirmed at `:77-100`.

---

## Could not establish

Holes, stated as holes.

- **Whether the retention purge has ever run in `APPLY` mode**, in staging or
  production. This decides whether Finding 2 has already failed silently in a
  real run, and whether Finding 3 is latent or has already happened. Pass 3 flagged
  the same question. It needs GitHub Actions run history that no session here can
  see. **This is the single most useful thing anyone with production access could
  answer for both passes.**
- **What any deployed database actually looks like.** Everything above is read
  from files. `pilot.video_sessions` in particular exists in an environment "if
  and only if somebody once POSTed to that route there"
  (`..._video_sessions_migration.sql:7-8`), so staging and production may hold
  the *old* status CHECK, or the table with neither index, and nothing in the
  repository can tell which. The same uncertainty applies to any table whose two
  declarations differ.
- **Whether the 69 unopened migrations contain findings.** The mechanical passes
  cover structure — columns, keys, indexes, constraints, defaults, ordering.
  They do not read a `where` clause inside a view body, a seeded value, or a
  comment that contradicts the DDL beneath it. A pass that read all 88 in full
  would be a different pass and would take considerably longer than this one.
- **The blast radius of Finding 1 in row terms** — how many soft-deleted athlete
  and account rows exist right now. That is a database question and this pass
  contacted no database.
- **Whether `pilot.document_ingest_audit.file_name` in practice contains
  children's names.** Its writers were not traced.
- **Nothing here was executed.** No migration was applied, no query was run, no
  test was invoked.

---

## For the index

Suggested rows for `README.md`'s findings table, continuing from F-23:

| ID | Severity | Finding |
|---|---|---|
| F-24 | HIGH | Soft delete is written to `deleted_at` on `pilot.athletes` and `pilot.accounts`, indexed for by two partial indexes, and filtered by **no read path** — 4 of 76 athlete statements and 3 of 61 account statements mention it, all inside `dataDeletion.ts`. A "deleted" child stays visible for two years; a "deleted" guardian keeps logging in. **Answers the question Pass 3 deferred to this pass.** |
| F-25 | HIGH | The retention hard-delete cannot succeed: `pilot_one_percent_nominations_athlete_fk` and `pilot.parents.account_id` have no `on delete` action, and both deletes share one transaction, so the whole purge aborts with `23503`. The pg suite is green because it seeds a bare athlete and never purges a guardian account |
| F-26 | MEDIUM | `pilot.video_sessions` has no FK to organization, athlete or uploader (documented as deliberate); the undocumented consequence is that deleting an athlete cascades away their publications and leaves the source video row and its blob path |
| F-27 | MEDIUM | The org-wide consent console runs 1 + 2N queries, unbounded (the unbounded half is a recorded #427 decision; the 2N is not) |
| F-28 | MEDIUM | Every emergency contact for a minor defaults to `is_primary = true`, no uniqueness constrains it, nothing demotes a sibling, and the roster export's tie-break therefore prints the oldest contact |
| F-29 | MEDIUM | `pilot.waivers.waiver_type` and `.status` are unconstrained text reached straight from a request body; every consumer fails closed, but the consent record cannot be relied on to say what consents exist |
| F-30 | LOW | `pilot_waivers_parent_fk`'s `on delete set null` targets a composite whose first column is `not null`, so the action raises `23502` instead of executing |
| F-31 | LOW | `pilot.organization_memberships.account_id` — the role-grant join — has no FK to `pilot.accounts` |
| F-32 | LOW | No SQLSTATE mapping in `jsonError`; `recordPersonClearance` documents that it relies on a DB CHECK, which would surface as an opaque 500 (zero callers today) |
| F-33 | LOW | `pilot.mixed_age_session_records.youth_athlete_id` has no athlete FK while its sibling in the same migration does (no write path today) |
| F-34 | LOW | `pilot.sparring_exposure.sparring_type` is the only vocabulary column in its table without a CHECK; `getSparringExposureCounts` would return `NaN` for an unknown value (no write path today) |
| F-35 | LOW | `pilot.activity_log` is filtered by `athlete_id` with no supporting index, unbounded by default |
| F-36 | LOW | `pilot.transfer_claims` has zero readers and its "display control" column defaults athlete-facing — same class as the three tables already dropped as dead schema |
