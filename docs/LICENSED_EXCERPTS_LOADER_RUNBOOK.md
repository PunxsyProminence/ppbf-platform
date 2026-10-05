# Licensed Excerpts Loader Runbook

Loads licensed research excerpts from a private Azure blob container into the SHADOW Library.
Every chunk it writes is an **excerpt** (`text_kind = 'excerpt'`, with a locator); it never
writes full text.

| | |
|---|---|
| Rulings | OD-2026-10-03-002 §2 (screen **and** an operator workflow reading a private location); OD-2026-10-05-009 (a new private blob container in the existing storage account, read with the deploy identity); OD-2026-10-05-010 (any locator: page, section or timestamp) |
| Workflow | `.github/workflows/load-licensed-excerpts.yml` (dispatch only) |
| Script | `apps/web/scripts/pilot-load-licensed-excerpts.ts` → `apps/web/src/server/pilot/licensedExcerptLoader.ts` |
| Writes through | `createShadowLibraryDocument` and `createShadowLibraryChunk`, the functions the screen's routes call, so the database rights rule (#1238) applies |
| Tests | `licensedExcerptLoader.test.ts` (validation, hashing, fingerprint, refusals) and `licensedExcerptLoader.pg.test.ts` (real Postgres; a local folder stands in for the container) |

## The excerpt file

One JSON file per document. Put the files at the top level of the container or in folders inside it;
the folder path becomes part of the name the plan shows. Any file that is not `.json` blocks the run.
Whole PDFs stay in SharePoint and never go in this container.

```json
{
  "format": "ppbf-licensed-excerpts/1",
  "source_id": "src_...",
  "document_name": "Author, Title, chapter 4",
  "citation": "Author, A. (2024). Title. Publisher. ISBN ...",
  "excerpts": [
    { "locator": "p. 41", "text": "..." },
    { "locator": "00:12:30", "text": "..." }
  ]
}
```

| Field | Rule |
|---|---|
| `source_id` | An existing Library source **in the organization being loaded**. Register it first on /research. Excerpts are allowed under any rights marker; the plan shows the source's marker. |
| `document_name` | Required, 300 characters or fewer. |
| `citation` | Required, 1,000 characters or fewer. Stored in the document's and each chunk's metadata. |
| `locator` | Required, non-blank, 200 characters or fewer: a page, section or timestamp. |
| `text` | Required, 20,000 characters or fewer (the same limit as the screen). |
| other | No other fields, at most 500 excerpts, 2 MB per file and 1,000 files per run. |

## Running it

1. Upload the files to the container (Azure Portal → storage account `ppbfstor569749` → container
   `ppbf-licensed-excerpts` → Upload, signed in as admin@).
2. Actions → **load-licensed-excerpts** → Run workflow, with mode `dry-run`:
   - `organization_id`: use `__platform__` for the platform shelf, which only the platform owner
     account can load. A gym id such as `punxsy_prominence` loads that gym's shelf, which only an
     active organization admin of that gym can load.
   - `actor_account_id`: the exact account_id (it is case-sensitive).
3. Read the plan. Each file shows one of these statuses:

   | Status | Meaning |
   |---|---|
   | `new` | Nothing from this file is loaded yet. |
   | `resume` | An earlier apply stopped part way, and this run adds only the missing excerpts. |
   | `complete` | Already loaded. Nothing is written. |
   | `conflict` | The stored copy differs from the file. |
   | `invalid` | The file has problems, listed under it. |

   Any `conflict` or `invalid` file blocks the whole run. Copy the `plan_fingerprint`.
4. Run again with mode `apply`, `confirm_load` set to `LOAD EXCERPTS` and `expected_fingerprint`
   set to the fingerprint you copied. The fingerprint includes the database it was made against, so
   copy it from a dry run of the same target. On production, **both** runs (the dry run and the
   apply) wait for your approval click in GitHub, because the job runs in the production
   environment either way.
5. Review the loaded documents on /evidence. Loaded text waits for review just like text added
   on the screen.

Changing a file after it is loaded gives it a new hash, and the old document still names that
file. The next dry run therefore shows the file as `conflict` and blocks the run, so the change is
never loaded as a quiet second copy. To load the changed version, retract the old document on
the screen, then upload the changed file under a new name, for example `chapter-4-v2.json`.

## One-time setup (Jason runs these; nothing here has been run)

OBSERVED 2026-10-05 (read-only `az` queries):

- Both `app-ppbf-staging` and `app-ppbf-production` use storage account `ppbfstor569749` in
  resource group `ppbf-rg`. Its `allowBlobPublicAccess` is `False`, so no container in it can be
  made public.
- The production environment's OIDC identity is `sp-ppbf-autopilot` (object id
  `dfd90c7b-b15d-40bd-8543-496ae52ff861`; federated credential `github-production-env`).
- The staging environment's federated credential `github-staging-env` belongs to
  `sp-ppbf-staging` (object id `08b89ee5-b79c-4470-aaf5-b3f386c4885b`).
- Which client id each GitHub environment's `AZURE_CLIENT_ID` secret holds is UNVERIFIED, because
  secret values cannot be read. The commands therefore grant both identities read access.
- Neither identity holds a data-plane storage role today. Contributor does not let an identity
  read blobs.

Windows PowerShell 5.1, signed in with `az login` as admin@:

```powershell
$acct = "/subscriptions/d9a46ce8-9257-4ea1-b816-ed5dcf313d41/resourceGroups/ppbf-rg/providers/Microsoft.Storage/storageAccounts/ppbfstor569749"
$scope = "$acct/blobServices/default/containers/ppbf-licensed-excerpts"
```

1. Create the private container (Azure resource; management plane, so it needs no storage key
   and no data role):

```powershell
az storage container-rm create --storage-account ppbfstor569749 --resource-group ppbf-rg --name ppbf-licensed-excerpts --public-access off
```

2. Let both deploy identities read that one container (role assignments):

```powershell
az role assignment create --assignee-object-id dfd90c7b-b15d-40bd-8543-496ae52ff861 --assignee-principal-type ServicePrincipal --role "Storage Blob Data Reader" --scope $scope
```

```powershell
az role assignment create --assignee-object-id 08b89ee5-b79c-4470-aaf5-b3f386c4885b --assignee-principal-type ServicePrincipal --role "Storage Blob Data Reader" --scope $scope
```

3. Let admin@ upload excerpt files to that container (role assignment). Step 1 goes through
   Azure Resource Manager, so it needs no data role.

```powershell
az role assignment create --assignee-object-id (az ad signed-in-user show --query id -o tsv) --assignee-principal-type User --role "Storage Blob Data Contributor" --scope $scope
```

4. Set the GitHub environment variables (GitHub settings; both environments name the same
   container):

```powershell
gh variable set PPBF_EXCERPT_STORAGE_ACCOUNT --env staging --body ppbfstor569749 --repo PunxsyProminence/ppbf-platform
```

```powershell
gh variable set PPBF_EXCERPT_CONTAINER --env staging --body ppbf-licensed-excerpts --repo PunxsyProminence/ppbf-platform
```

```powershell
gh variable set PPBF_EXCERPT_STORAGE_ACCOUNT --env production --body ppbfstor569749 --repo PunxsyProminence/ppbf-platform
```

```powershell
gh variable set PPBF_EXCERPT_CONTAINER --env production --body ppbf-licensed-excerpts --repo PunxsyProminence/ppbf-platform
```

Run the blocks in one PowerShell window: the role assignments use `$scope` from the first block.

No new GitHub secret and no storage key are needed. Role assignments can take a few minutes to
apply. A missing reader role shows up as an authorization error at **Download Excerpt Files**.
(On staging it may surface one step earlier, at **Refuse A Public Container**. The production
identity is a subscription Contributor, so that step's management-level read succeeds even
without the role.)

Cost: one container in an existing account. Storage for text files is cents a month.

## Blind spots

- **Partial apply.** `createShadowLibraryChunk` writes through the shared pool, not one
  transaction, and it calls the embedding service. If an apply stops part way, some excerpts are
  stored and others are not. A dry run then shows the file as `resume`, and applying that plan adds
  only the missing excerpts. The loader does not refactor the function into a transaction.
- **Race with the screen.** Between the apply's fresh plan and its writes, a curator editing the
  same document on the screen could add a chunk. The unique `(document_id, ordinal)` key stops a
  clash, and the run fails loudly rather than overwriting. Runs of this workflow are serialized
  per target.
- **Embeddings.** The workflow sets no AI endpoint, so loaded chunks get no embedding at write time.
  `pilot:backfill-chunk-embeddings` fills them later. Keyword search works immediately.
- **Not exercised against real Azure.** Tests use a local folder. The `az storage` steps, the
  role assignments and the environment variables are proven only by the first staging dry run.
- **Who else can read the container.** The production identity also signs in for any job on
  `main` that has no environment (its `github-main` federated credential). Once it holds the
  reader role, such a job could read the excerpt files without an approval click. Loading still
  needs one. This is the cost of reading with the existing deploy identity (OD-2026-10-05-009).
- **Completeness gate.** The screen's rule that a manual-text document cannot be indexed until all
  its declared parts are stored (`MANUAL_TEXT_INTAKE_COMPLETE_SQL` in `shadowLibrary.ts`) does not
  cover loader documents. A loader document left part-loaded can be approved with the excerpts it
  has. Each excerpt carries its own locator, so nothing is cited as more than it is. A dry run
  shows it as `resume`. Extending the gate is outside this PR.
- **Same container for both targets.** A staging dry run reads the files production would load.
  This is deliberate, so staging rehearses production's exact input. A staging apply writes those
  excerpts into the staging database.
