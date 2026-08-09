# SHADOW research corpus — import runbook

**Status as of 2026-08-09:** the corpus is staged, complete, and proven to import. Nothing needs
gathering or building. What remains is three operator actions, in order, and **the third one is the
one everybody forgets** — without it the corpus is loaded and invisible.

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
| `organization_id` | the owning organization — resolvable from the Container App secret `ppbf-pilot-default-org-id` |
| `seed_account_id` | an **active** account whose role is `platform_owner`, `organization_admin` or `admin`, in that organization |

**`seed_account_id` gotcha:** production's owner is `Admin@punxsyprominence.org` with a **capital A**
(recorded in #274/#275). The lowercase row is retired. Using it fails `SEED_ACCOUNT_NOT_FOUND`.

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
- `AZURE_AI_ENDPOINT`
- `AZURE_AI_KEY`
- `AZURE_AI_EMBEDDING_DEPLOYMENT_NAME` — **the embedding deployment must exist first.** The script
  fails with "create the embedding deployment first; nothing to backfill without it."
- optional `PPBF_BACKFILL_ORGANIZATION_ID` to scope it

Re-run it after any embedding-model change: the script re-embeds rows whose model has drifted, not
only `NULL` rows (#232).

### 3. Approve — `/admin/shadow`

Every source and document lands `approval_state = 'pending_review'`, `verification_state =
'unverified'`. The rehearsal confirmed all 1,214 sources and 14 documents land that way, with none
leaking to another state. Retrieval stays human-gated until someone approves them.

The importer never approves anything. That is by design, and it means **importing is not
publishing**.

---

## Order and what each step buys you

| after | chunks exist | semantic search finds them | citable |
|---|---|---|---|
| step 1 only | yes | **no** | no |
| steps 1 + 2 | yes | yes | no |
| steps 1 + 2 + 3 | yes | yes | yes |

Steps 2 and 3 are independent of each other and can be done in either order. Both are required.

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
