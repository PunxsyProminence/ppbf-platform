# Deploy runbook — folder 06–09 work (PR #238)

Written 2026-08-08 for the six migrations and three coach surfaces added on
`claude/remaining-capabilities-ab0q7d`. Every step below is one you run; none
of it happens automatically on merge.

**Read this first.** `deploy-production.yml` cannot verify that a migration was
applied. Its `migrations_complete` input is an attestation you type, not a
check against the database. Deploying code before its migration exists means
every request touching the new tables fails. The order below is not a
suggestion.

---

## What this ships

Six migrations, none of which touch an existing table's data:

| # | Migration | Creates | Depends on |
|---|---|---|---|
| 1 | `drill-vocabulary-widening` | nothing — widens two CHECKs | `drill-library-v3` (already applied) |
| 2 | `multidiscipline` | `disciplines`, `grappling_exposure`, `athlete_discipline_participation`, `mixed_age_session_records`, + 4 additive `drill_library` columns | `drill-library-v3` |
| 3 | `session-scripts` | `session_scripts`, `session_script_blocks`, `session_script_renderings`, `session_script_runs` | `drill-library-v3` (blocks FK `drill_library`) |
| 4 | `transfer-claims` | `transfer_claims` | `drill-library-v3` |
| 5 | `competence-cohorts` | `competence_levels`, `athlete_competence`, `cohort_definitions`, `v_athlete_tenure` | `activity-log` (view reads it) |
| 6 | `method-naming` | `methods` | none |

Three coach surfaces, all read-only: `/coach/session-scripts`,
`/coach/cohorts`, `/coach/disciplines`.

**The floor-hours clock stays at zero.** No attendance backfill is included and
none should be added — synthetic history would corrupt every retention figure
downstream.

---

## Order

### 0. Merge

PR #238 must be green and merged to `main`. Record the resulting merge SHA on
`main` — every later step refers to it.

```
git rev-parse origin/main
```

### 1. Staging: apply migrations

Dispatch `apply-migrations` against **staging**, once per migration, in this
order. Order 1 → 6 matters: the widening must precede the drill-library seed,
and `session-scripts` will fail outright if `drill-library-v3` is absent.

```
drill-vocabulary-widening
multidiscipline
session-scripts
transfer-claims
competence-cohorts
method-naming
```

Each runner opens its own transaction and asserts readiness before committing,
so a failure rolls back cleanly and leaves nothing half-applied. Confirm each
one prints its `... MIGRATION PASS` line before starting the next.

Every migration is catalog-guarded and re-runnable — if you lose track of which
completed, re-running is a proven no-op, not a risk.

### 2. Staging: load seed data

Dispatch `seed-reference-data` once per dataset. Run each in `dry-run` first —
that performs every insert for real inside a transaction and rolls back, so it
proves the data fits the live schema rather than only that the files parse.

| dataset | loads |
|---|---|
| `drill-library` | 119 drills, 357 scale levels, 674 stop rules, 258 cues |
| `disciplines` | 5 disciplines |
| `competence-cohorts` | 6 levels, 6 cohort definitions |

`drill-library` requires `seed_account_id` and requires step 1's widening to
have run first; without it, 228 scale-level rows and 63 stop-rule rows are
rejected and the whole transaction aborts.

Each loader is idempotent — re-running produces no duplicates.

**Leave `organization_id` blank.** The workflow resolves the owning organization
from the target app's own `ppbf-pilot-default-org-id` secret — the same value
the app reads to answer requests, and the same one the SHADOW E2E gate uses. It
is masked in the log and never printed into the run summary.

Asking an operator to type it was the wrong shape to begin with: the value is a
secret they cannot see from the Actions form, so supplying it meant copying it
out of Azure by hand, and a typo seeds a real database under an organization
that does not exist. Set it only to seed some *other* organization deliberately.

`seed_account_id` is still yours to supply, and only `drill-library` needs it.
It is an account id you already know, not a secret.

That last point is a behaviour change. Until 2026-08-08 the workflow exported
`PPBF_ORG_ID`/`SEED_ACCOUNT_ID` while every loader read
`PPBF_SEED_ORG_ID`/`PPBF_SEED_ACCOUNT_ID`, so the operator's typed
`organization_id` reached nothing and each loader silently defaulted to the
fixture organization `ppbf-default-org`. A production dispatch would have
written every row under that fixture org and reported success. The names now
match, the defaults are gone, and `seedWorkflowContract.test.ts` fails if either
side drifts again.

Do NOT run the npm scripts directly against a real database. The workflow reads
the connection string from the Container App's own secret and masks it; running
locally means putting a production connection string on a laptop to do
something the pipeline does properly.

### Two seed loaders you must NOT run

Both fail against the shipped schema, and both fail *whole*: each loader runs
in a single transaction, so one bad row rolls back everything else in the same
call. There is no partial load to salvage.

**`npm run seed:session-scripts`** — two Friday-sparring blocks
(`blk_df4fb688e5b181` "Sparring Drill Rounds", `blk_01b502a7e7336d` "Open
Sparring") are `block_kind='instruction'` with all four `what_to_*` fields
empty, which the loader converts to NULL, which violates `pilot_ssb_content`.
The CSV holds 3 scripts / 65 blocks / 4 renderings; **0 of them load.** A
real-Postgres test pins exactly this (`sessionScriptsTransfer.pg.test.ts`).

Consequence: `/coach/session-scripts` renders "No session scripts yet" until
those two blocks are given content or reclassified. The page and its tables are
correct and deployed — there is simply nothing in them.

**`npm run seed:transfer-claims`** — all 173 rows reference a generation of
`drl_*` ids that resolves against neither the archive's own drill library nor
the 119 drills shipped here, so every row violates `pilot_transfer_drill_fk`.
Needs a decision about which drill-id generation is authoritative.

Consequence: `pilot.transfer_claims` ships empty.

### 3. Staging: verify before going further

- `/coach/session-scripts` renders "No session scripts yet" — expected, see the
  seed exclusion above. It is not evidence of a broken page.
- `/coach/cohorts` lists 6 cohorts and the 6-rung ladder. Look up a real
  athlete id — an athlete with no logged training must read "No logged training
  yet", not zero hours.
- `/coach/disciplines` lists 5 disciplines. Any age policy shown must carry its
  cited source.

### 4. Staging: deploy code

Dispatch `deploy-staging` with `expected_sha` = the merge SHA and
`schema_migrations_complete` = `CONFIRMED`.

**Capture the image digest this run produces** (`sha256:...`). Production will
not accept a deploy without it.

### 5. Production: apply the same six migrations

Same order as step 1, against production. This is the step
`deploy-production.yml` cannot check for you.

Take a backup first if `backup.yml` has not run recently.

### 6. Production: load seed data

Same three `seed-reference-data` dispatches as step 2, with the same two
datasets absent (session-scripts, transfer-claims).

### 7. Production: deploy code

Dispatch `deploy-production` with:

| Input | Value |
|---|---|
| `confirm_sha` | the merge SHA from step 0 |
| `release_digest` | the digest captured in step 4 |
| `migrations_complete` | `CONFIRMED` — only if steps 5 and 6 actually finished |
| `allow_rollback` | `NO` |

This requires the production environment approval. That click is yours and is
not delegable.

---

## Rollback

Application code rolls back by dispatching `deploy-production` with an older
SHA and digest and `allow_rollback: YES`.

**The migrations do not roll back, and do not need to.** All six are additive —
new tables, new columns, and two widened CHECK vocabularies. Older application
code ignores tables it does not know about, and the widened CHECKs accept
everything the narrow ones did. Rolling the code back while leaving the schema
forward is safe.

The one thing that is *not* reversible by redeploying is seeded data. If a seed
load goes wrong, the fix is to correct the CSV and re-run the loader (they are
idempotent), not to roll back the schema.

---

## Still open — decide before these matter

1. **`pilot_transfer_drill_fk`** — all 173 transfer claims reference an
   unresolvable drill-id generation. Blocks `seed:transfer-claims` entirely.
   The `transfer_claims` table ships empty until this is settled.
2. **`pilot_ssb_content`** — two Friday-sparring blocks are
   `block_kind='instruction'` with all four `what_to_*` fields empty. This
   blocks the ENTIRE session-scripts seed, not just those two rows: 0 of 65
   blocks and 0 of 3 scripts load. `/coach/session-scripts` stays empty until
   it is resolved.
3. **The 8 combatives claims** in `evidence_fragment_CB.csv` are still not
   merged into the 1,235-claim registry.
4. **Seven orphaned admin surfaces** (`/admin/export`, `/admin/import`,
   `/admin/gear`, `/admin/gear/vendors`, `/admin/athletes`,
   `/admin/organizations/test`, `/admin/platform/overview`) have no door in the
   building map. Unrelated to this deploy, but recorded in
   `buildingMapCoverage.test.ts`'s `PENDING_TRIAGE`.
5. **Grappling exposure has no write path.** The tables and the read surface
   ship; what a coach is prompted to enter when a choke was completed on a
   child is a safeguarding-practice decision that has not been made.
