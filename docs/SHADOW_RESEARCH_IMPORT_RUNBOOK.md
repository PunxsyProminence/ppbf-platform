# SHADOW research corpus — import runbook

**Status as of 2026-08-09:** the corpus is staged, complete, and proven to import. Nothing needs
gathering or building. What remains is operator work in three steps: **import**, then **backfill
embeddings**, then **index and approve**. Import must come first. The other two are independent of
each other and may be done in either order, but **both are required** — importing alone leaves the
corpus loaded and invisible, and that is the part most easily missed.

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

**This is not the same thing as the doctrine corpus.** `seed:shadow:library` loads four SHADOW
design documents from `shadow-library-seed-manifest.json` (authority model, specification, event
model, AI technical companion) and needs an interactive admin session cookie. That teaches SHADOW
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
| `organization_id` | **leave blank.** #284 makes the workflow resolve it from the target app's own `ppbf-pilot-default-org-id` secret, masked. Set it only to import for some other organization deliberately. |
| `seed_account_id` | an **active** account whose role is `platform_owner`, `organization_admin` or `admin`, in that organization |

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
*both* of these (`shadowLibrary.ts:1013-1014`):

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

### 3. Index, then approve — on `/evidence`, not `/admin/shadow`

Two corrections to what an earlier draft of this runbook said.

**The controls are on `/evidence`** (`app/evidence/page.tsx`), which holds both the indexing action
and the evidence-approval action.

**Indexing comes before approval, and it is not optional.** All 14 imported documents land
`ingest_state = 'pending'`, while `reviewShadowLibraryDocument` refuses approval until a document is
indexed with an `index_completed_at`, and retrieval enforces the same predicate
(`shadowLibrary.ts:561` — `and d.ingest_state = 'indexed'`). Skip it and every document is
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

## Known limitation this runbook does not fix

`import-shadow-research.mjs` writes the research corpus only. The 1,243-claim evidence registry
(`evidence_registry_boxing_learning.csv`, updated 2026-08-08 with the Penn State and combatives
additions from #277) is a separate artifact with its own path, and `pilot.transfer_claims` is
deliberately empty per #278 because its ids resolve against nothing and inventing provenance between
two techniques is worse than having no rows.
