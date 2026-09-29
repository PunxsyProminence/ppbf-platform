# SHADOW research corpus — import runbook

**Status as of 2026-08-09:** the corpus is staged, complete, and proven to import. Nothing needs
gathering or building. What remains is operator work in three steps: **import**, then **backfill
embeddings**, then **index and approve**. Import must come first. The other two are independent of
each other and may be done in either order, but **both are required** — importing alone leaves the
corpus loaded and invisible, and that is the part most easily missed.

**Updated 2026-09-28.** Since this was written the corpus is split by `scope` (the platform
baseline in the reserved `__platform__` organization, PPBF's own policy documents in one gym
organization -- today `ppbf-default-org`, which is not the gym (OD-2026-09-28-007); moving them to
`punxsy_prominence` is a production write that waits for Jason's per-run approval), and the baseline
is approved by the `approve-library-baseline` workflow, not on `/evidence` (step 3).
`docs/PLATFORM_EVIDENCE_BASELINE_HANDOFF.md` records the 2026-08-12/13 production runs;
`gh run view` shows runs 31649800404, 31652990026, 31653129529 and 31653933104 as successful
(checked 2026-09-28; their inputs were not re-read). Use the steps below for any re-import.

Rehearsed end to end before this was written: `npm --prefix apps/web run rehearse:shadow:research`
runs the real importer with `--apply` over the real corpus against a disposable local Postgres. It
passed. Re-run it any time; it touches nothing remote.

---

## What the corpus actually is

`apps/web/seed-data/shadow-research/2026-08-07/` — also the importer's hardcoded `DEFAULT_SEED_DIR`.

| file | records | expected by importer |
|---|---|---|
| `seed_shadow_library_sources.csv` | 1,214 | 1,214 ✓ |
| `seed_shadow_library_documents.csv` | 14 | 14 ✓ |
| `seed_shadow_library_chunks.csv` | 1,193 | 1,193 ✓ |
| `seed_shadow_library_capability_map.csv` | 30 | 30 ✓ |
| `seed_shadow_research_requirements.csv` | 229 | 229 ✓ |

1,468,302 characters of retrievable text. Sources break down as 851 peer-reviewed, 169 other, 84
governing-body, 79 clinical guideline, 21 internal policy, 10 media, tiered by authority 1–5.

Those expected counts are hardcoded in `import-shadow-research.mjs` and it refuses to proceed if
reality disagrees — so a file edited without updating the constant fails loudly rather than
importing a partial corpus.

**This is not the same thing as the doctrine corpus.** `seed:shadow:library` loads two SHADOW
design documents from `shadow-library-seed-manifest.json` (authority model, event model; the AI
technical companion left the set on 2026-09-28, OD-2026-09-28-010 item 23) and needs an interactive admin session cookie. That teaches SHADOW
about itself. The research corpus below is the evidence base for coaching and safety claims. They
are different commands, different inputs, and different prerequisites. A single work-queue line
calling for "ingesting the corpus" conflates them.

---

## The three steps

### 1. Import — dispatch `import-shadow-research`

**Use the workflow. Do not run this from a shell.**

`.github/workflows/import-shadow-research.yml` resolves the connection string from the target
Container App via Azure OIDC, so no production connection string ever touches a laptop. That matters
here specifically: `scripts/lib/postgres-write-target.mjs` records that a 2026-07-18 exercise run
with a production connection string in an agent shell left **361 orphaned rows** across
`pilot.accounts`, `pilot.athletes`, `pilot.shadow_intake` and `pilot.audit_events`, and that is what
blocks the corrected multi-org FK migration. The guard exists because this already happened once.

Dispatch inputs:

| input | value |
|---|---|
| `target` | `staging` first, then `production` |
| `confirm_target` | retype the target exactly |
| `mode` | `dry-run` first, then `apply` |
| `confirm_import` | for apply mode, exactly `IMPORT RESEARCH` |
| `tables` | `all` (default) writes sources, documents, chunks, the capability map and requirements. `capability_map_only` writes just the capability map -- for backfilling `feeder_tracks` on a baseline that is already approved, where a full import would fail on the review-pair constraint. |
| `scope` | `platform_baseline` (default) imports everything except PPBF's own house documents, always into `__platform__`; a conflicting `organization_id` is refused. `ppbf_policy` imports only those house documents, for one gym. `whole_corpus` is the pre-split behaviour: everything into one organization. |
| `organization_id` | Not used for `platform_baseline` (any value other than `__platform__` is refused; the run is forced to `__platform__`). For gym content (`ppbf_policy` or `whole_corpus`), pass **`punxsy_prominence`** explicitly -- the gym's organization (OD-2026-09-28-007). Required for those scopes: a blank value is refused at the first step, before install and login, and there is no fallback to the app's default-org secret. OD-2026-09-28-007 records where the existing policy shelf sits. |
| `seed_account_id` | an **active** account whose role is `platform_owner`, `organization_admin` or `admin`, in the target organization unless it is a platform owner (`import-shadow-research.mjs`, `SEED_ACCOUNT_TENANT_MISMATCH`). Nobody belongs to `__platform__`, so `platform_baseline` needs a platform-owner account; for `ppbf_policy` use an `organization_admin` of `punxsy_prominence`. |

**Finding `seed_account_id`:** dispatch `check-database` with `check: seed-identity` (#283) and read
it off the log. It lists organizations and privileged accounts only — never athletes or parents —
marks inactive rows, and flags account ids that differ only by case.

That last part matters here: production's owner is `Admin@punxsyprominence.org` with a **capital A**
(#274/#275) and the lowercase row is retired, so the two differ by exactly one character and only one
of them works. The other fails `SEED_ACCOUNT_NOT_FOUND`. Copy the exact string.

The importer is transactional and self-verifying — it counts every table after writing and rolls
back the whole import if any count disagrees. It is also idempotent: the rehearsal ran it twice and
row counts did not change.

Run dry-run first. It validates the entire package and touches no database.

### 2. Backfill embeddings — `pilot:backfill-chunk-embeddings`

**This is the step that is easy to miss, and skipping it makes step 1 look broken.**

The importer reports `embeddings_generated: false` and means it. `searchShadowLibrary` requires
*both* of these (`shadowLibrary.ts:1087-1088` at `bbf299fe`):

```sql
and c.embedding is not null
and c.embedding_model = $4      -- the CURRENT deployment, not merely any model
```

So after step 1 the 1,193 chunks exist and **semantic search returns nothing from them**, approved
or not. The `embedding_model` equality is deliberate (#232): two different embedding models can
share a dimension count, so a stale-model vector would otherwise compare as a real-looking but
meaningless score and get cited as evidence.

Required environment:

- `AZURE_POSTGRES_CONNECTION_STRING`
- `PPBF_EXPECTED_POSTGRES_HOSTNAME` **and** `PPBF_EXPECTED_POSTGRES_DATABASE` — the script calls
  `assertDeclaredWriteTargetFromEnv` unconditionally (`pilot-backfill-chunk-embeddings.mjs:46`),
  and that guard throws when either is absent. An earlier draft of this runbook omitted them, so
  anyone following it exactly could not start this step even with everything else configured.
- `AZURE_AI_ENDPOINT`
- `AZURE_AI_KEY`
- `AZURE_AI_EMBEDDING_DEPLOYMENT_NAME` — **the embedding deployment must exist first.** The script
  fails with "create the embedding deployment first; nothing to backfill without it."
- optional `PPBF_BACKFILL_ORGANIZATION_ID` to scope it

**RUN IT REPEATEDLY UNTIL NOTHING REMAINS.** `BATCH_LIMIT = 500` and the script does not loop — its
inner `for` iterates the batch it fetched, it does not fetch again. One invocation therefore embeds
at most 500 of the 1,193 chunks, so a single run leaves **at least 693 chunks with no embedding and
excluded from semantic candidates**. Repeat until it reports no chunks needing work. A first pass
that exits cleanly is not the same as a finished backfill.

Also re-run it after any embedding-model change: the script re-embeds rows whose model has drifted,
not only `NULL` rows (#232).

### 3. Index, then approve — `approve-library-baseline` for the baseline, `/evidence` for a gym's shelf

Two corrections to what an earlier draft of this runbook said.

**For a gym's own shelf the controls are on `/evidence`** (`app/evidence/page.tsx`), which holds
both the indexing action and the evidence-approval action -- not `/admin/shadow`.

**The `__platform__` baseline cannot be approved there.** `/evidence` writes through
`PATCH /api/pilot/shadow/evidence/review`, which scopes every write to the signed-in account's
organization, and no account belongs to `__platform__`. Dispatch the `approve-library-baseline`
workflow instead: `dry-run` first, then `apply` with `APPROVE EVIDENCE`; a blank `organization_id`
there means `__platform__`. It indexes the pending documents and approves the pending sources and
documents in one transaction, recording one named platform owner as approver and verifier
(`apps/web/scripts/pilot-approve-library-baseline.mjs`).

**Indexing comes before approval, and it is not optional.** All 14 imported documents land
`ingest_state = 'pending'`, while `reviewShadowLibraryDocument` refuses approval until a document is
indexed with an `index_completed_at`, and retrieval enforces the same predicate
(`searchShadowLibrary`, `shadowLibrary.ts:1083` at `bbf299fe` — `and d.ingest_state = 'indexed'`). Skip it and every document is
permanently unapprovable and the corpus stays uncitable, with nothing obviously wrong on screen.

Every source and document lands `approval_state = 'pending_review'`, `verification_state =
'unverified'`. The rehearsal confirmed all 1,214 sources and 14 documents land that way, with none
leaking to another state.

The importer never approves and never indexes anything. That is by design, and it means **importing
is not publishing**.

---

## Order and what each step buys you

| after | chunks exist | semantic search finds them | citable |
|---|---|---|---|
| step 1 only | yes | **no** | no |
| step 1 + a single backfill run | yes | at most 500 of 1,193 | no |
| step 1 + backfill run to completion | yes | yes | no |
| all three, indexing included | yes | yes | yes |

Steps 2 and 3 are independent of each other and can be done in either order. Both are required, and
step 2 is not one command but a command repeated until it reports nothing left.

---

## Rehearsal evidence (2026-08-09, `b1839ee`)

`npm --prefix apps/web run rehearse:shadow:research`, against embedded Postgres with
`pilot_slice_postgres.sql` + `pilot_slice_postgres_shadow_evidence_migration.sql`:

- dry-run validation of the full package: **PASS**
- `--apply`: **SHADOW RESEARCH IMPORT PASS**, all five tables matching expected counts exactly
- review gate: 1,214 sources and 14 documents all `pending_review` / `unverified`, nothing else
- referential integrity: **0** chunks with no parent document, **0** with no parent source
- text intact: 1,468,302 characters, longest chunk 2,814 — matching the source file's maximum, so
  nothing was truncated by a column type
- idempotence: second `--apply` exited 0 and changed no row counts

The rehearsal deliberately does **not** apply `pilot_slice_postgres_shadow_chunk_embedding_migration.sql`,
which is how it surfaced step 2: with no `embedding` column there is visibly nothing for retrieval
to match on. Your real databases do have that column, and the values will be `NULL` until step 2
runs.

---

## Moving a gym's policy shelf — `move-policy-shelf`

Moves one organization's `internal_policy` sources, their documents and chunks, and the
citation-check and retraction-check rows about those sources to another named organization, in one
transaction (`apps/web/scripts/pilot-move-policy-shelf.mjs`). Built for OD-2026-09-28-011 item 6:
the shelf under `ppbf-default-org` goes to `punxsy_prominence`. It selects the rows the database
holds, not an import scope: every `internal_policy` source in the from-organization whatever its
approval state, with that state reported rather than filtered.

The move changes which organization owns the rows, not whether they can be retrieved. Retrieval
reads only sources that are active, approved and verified, and documents that are indexed, approved
and verified. `pilot-rescope-library-baseline.mjs` inserted its programme-source copy and document
copies as pending (:296, :311), so some of the shelf may still be pending; the dry run's
`state_tally` shows how many sources, documents and chunks are `ready` and `not_ready`, and each
document's `ingest_state`, `approval_state` and `verification_state`. Rows that are `not_ready`
stay out of retrieval after the move until they are reviewed.

Dispatch the `move-policy-shelf` workflow, `from_organization_id` = `ppbf-default-org`,
`to_organization_id` = `punxsy_prominence`, in this order:

1. `target` staging, `mode` dry-run. Read the plan: every source, document, chunk and check row it
   would move, their review state, the counts for both organizations, any blockers, and a
   `plan_fingerprint`.
2. `target` staging, `mode` apply, `confirm_move` = `MOVE POLICY SHELF`, `expected_fingerprint` =
   the `plan_fingerprint` from step 1.
3. `target` production, `mode` dry-run. Compare with OD-2026-09-28-007: 22 sources, 7 documents,
   49 chunks (counted 2026-09-28; the dry run is the current count), and read `state_tally`.
4. `target` production, `mode` apply, `expected_fingerprint` = the `plan_fingerprint` from step 3.
   The job runs in the `production` environment, which is where Jason approves the run; the
   `expected_fingerprint` input is what ties the approved run to the rows step 3 showed.
5. `check-database` with `library-scope`, to see the shelf under `punxsy_prominence`.

Apply moves only the reviewed plan. It re-plans inside its own transaction and, before its first
update, refuses (`PLAN_FINGERPRINT_MISMATCH`) if those rows do not give the expected fingerprint:
any source, document, chunk or check row added to or gone from the plan since the dry run changes
it. Run a fresh dry run and use its fingerprint.

A dry run exits non-zero when its plan has blockers. Apply also refuses on: an organization that
does not exist; from equal to to; `__platform__` on either side; a document or chunk of the shelf already in another organization; a moving chunk whose document or
source is not moving; any `shadow_evidence_items`, `shadow_research_submissions` or (outside the
target) `rabbit_holes` row pointing at a moving row; a document or chunk tied to an athlete
(`subject_id`); a url, content hash or check id the target already holds; more rows than
`PPBF_POLICY_MOVE_MAX` (500); and any update touching a different number of rows than planned. It
verifies the end state before committing and writes one `pilot.audit_events` row
(`entity_type = 'shadow_library_policy_move'`).

Not moved: capability rules (the dry run lists the from-organization's rules that ask for
`internal_policy` under `capability_rules_not_moved`), research requirements, and history rows in
`audit_events` and `shadow_events`.

---

## Known limitation this runbook does not fix

`import-shadow-research.mjs` writes the research corpus only. The 1,243-claim evidence registry
(`evidence_registry_boxing_learning.csv`, updated 2026-08-08 with the Penn State and combatives
additions from #277) is a separate artifact with its own path, and `pilot.transfer_claims` is
deliberately empty per #278 because its ids resolve against nothing and inventing provenance between
two techniques is worse than having no rows.
