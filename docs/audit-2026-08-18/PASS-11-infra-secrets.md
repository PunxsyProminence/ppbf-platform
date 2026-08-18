# Pass 11 — Build, infrastructure & secrets

**Scope.** `Dockerfile`, `Dockerfile.migration`, `Dockerfile.research-bridge`,
`.dockerignore`, `.gitignore` (and every nested one), `.github/workflows/**`,
`.github/dependabot.yml`, `infra/**`, `staticwebapp.config.json`,
`firebase.json`, `package.json` + `package-lock.json`, `.env.example`,
`scripts/**`, `migration-runner.js`, the root `*.ps1` scripts, and the odd
top-level file `ersjasonppbf-platformappsweb`.

**Pinned to** `origin/main` at `04dd116b`. Branch `docs/full-spectrum-audit-2026-08-18`.
Read-only pass: nothing was built, deployed, migrated, or modified. The single
write is this file.

**The headline, up front.** Two literal credentials are still publicly readable
in this repository's git history. They were removed from `main` by a deliberate
security fix (#84) that rewrote the file — but the branches carrying the
pre-fix commits were never deleted from `origin`, and the repository is public
(confirmed against the GitHub API: `"private": false`, `"visibility": "public"`,
`"allow_forking": true`). **Their values are withheld from this document.**

---

## Method

### What was searched, and how

**The tracked tree at HEAD** (2,142 files, `git ls-files`):

- `git grep` for connection strings carrying an inline password
  (`(postgres|postgresql|mysql|mongodb|redis)://…:…@`), then filtered to
  non-`localhost` hosts.
- `AccountKey=`, `DefaultEndpointsProtocol=`, `SharedAccessSignature`,
  `BlobEndpoint=`.
- `-----BEGIN … PRIVATE KEY` / `CERTIFICATE`.
- Azure SAS shapes (`sv=YYYY-MM-DD&s?=`, `?sig=` / `&sig=` with ≥20 chars of
  base64).
- JWT shape (`eyJ…​.…​.`).
- Azure AD client-secret shape (a short prefix, `8Q~`, then 25+ chars).
- 32-char lowercase hex (Azure Cognitive Services key shape).
- Quoted base64 runs of 40+ characters.
- Literal assignment of any identifier matching
  `*(KEY|SECRET|CONNECTION_STRING|PASSWORD|TOKEN|API_KEY|PIN)` to a value of 12+
  characters, excluding `process.env`, `${{ … }}`, `secrets.*`, and
  `secretref:`.
- Real Azure resource hostnames
  (`*.postgres.database.azure.com`, `*.blob.core.windows.net`,
  `*.openai.azure.com`, `*.azurecr.io`, `*.azurecontainerapps.io`,
  `*.vault.azure.net`, `*.search.windows.net`).

**The full git history.** `git log -p` is too large to read, so history was
searched three independent ways:

1. **Every file ever added, on every ref** —
   `git log --all --diff-filter=A --name-only`, filtered for `.env*`, `.pem`,
   `.pfx`, `.p12`, `.key`, `.jks`, `.keystore`, `.ppk`, `id_rsa`,
   `id_ed25519`, `.npmrc`, `.pgpass`, `*.publishsettings`, `azureauth`,
   `secrets.{json,yaml,yml,txt}`, and `node_modules/`.
2. **Every blob in the object database, by content.** The repository holds
   **6,562 blobs / 114,785,631 bytes uncompressed**, small enough to stream in
   full: `git cat-file --batch-all-objects --batch` piped through the pattern
   set above. This reaches blobs on deleted branches, on unmerged branches, and
   on commits reachable from no branch at all — the class a `HEAD` grep and a
   `main`-only history walk both miss. 332 raw hits were triaged to their
   distinct matched substrings and classified by hand.
3. **Per-ref file history for the one file the repository itself names as
   having leaked.** Every historical version of
   `.github/workflows/deploy-staging.yml` across `git rev-list --all` was
   rendered and grepped for literal `*_PIN:` assignments, then each hit's
   commit was tested for reachability with `git merge-base --is-ancestor` and
   `git branch -r --contains`.

**Cross-checks that were run, and their results:**

- `git check-ignore -v` against `.env`, `.env.local`, `apps/web/.env`,
  `apps/web/.env.local` — all four ignored, by two different rules.
- `pg-connection-string`'s parser executed directly under `node` to test the
  migration guards' host-parse assumption (finding M-03). This is the only
  executable check in this pass; it touches no database and no network.
- The GitHub API, read-only, for repository visibility and the live branch
  list, so the exposure claim is made against the real remote rather than
  against a possibly stale local mirror.

**De-duplication.** Checked against `docs/capabilities/NETWORK_STATUS.md` (read
from `origin/docs/agent-handoff-briefs`), `git log --oneline origin/main -40`,
and the sibling passes already written in this directory. Three specific
overlaps and how they are handled:

- `PASS-15-egress.md:493` already records that `staticwebapp.config.json` sets
  no security headers. **Not re-reported.** Finding H-02 is about a different
  property of that file — its rewrite targets do not exist and its fallback
  points at a legacy unauthenticated page.
- `PASS-15-egress.md:334` (E-03) already records the `POST /api/document-ingest`
  egress to Google Drive, SharePoint and Dataverse. **Not re-reported.** Finding
  S-03 is the secrets-management half only: those destinations' credentials are
  absent from the repository's own secret inventory.
- `PASS-10-tests-ci.md` already establishes what gates a merge (`ci.yml`'s
  `validate`, `research-bridge-ci.yml`, everything else `workflow_dispatch`).
  **Not re-reported.** Finding C-01 is a gap inside that established picture:
  no gate builds any image.

### What was NOT searched

Stated plainly, because an admitted hole beats a plausible number:

- **Whether the two exposed credentials still authenticate.** That needs a
  request against the live staging login, which this pass will not make. See
  "Could not establish".
- **GitHub repository settings** beyond visibility and the branch list — branch
  protection rules, required reviewers on the `production` environment, the
  federated-credential subjects on `AZURE_CLIENT_ID`, and the values behind
  `secrets.*` / `vars.*` are all outside the tree. The workflows *assert* facts
  about them (`deploy-production.yml:104-108` names both federated credentials);
  those assertions are quoted, never treated as verified.
- **Azure-side state**: actual RBAC assignments, whether Defender for Storage
  malware scanning is on, whether the `ppbf-pilot-backups` container is in fact
  private, and whether the production Postgres firewall admits arbitrary IPs.
- **`npm audit` / any CVE database.** Explicitly out of scope by instruction.
  Dependency review below is a read of `package.json` and `package-lock.json`
  only, and says nothing about known vulnerabilities.
- **Any Docker build.** No daemon, and building is a mutation. Every claim about
  what an image contains is read from the Dockerfile, and where a claim depends
  on the contents of a base image's package repository it is marked as
  inference.
- `docs/` was read only where it bears on infrastructure. `PASS-12-docs-vs-code.md`
  owns documentation drift.

---

## Secret exposure

### The tracked tree at HEAD: clean

Every one of the pattern searches above returned either nothing or test
fixtures. The complete set of surviving hits, after triage:

| What matched | Where | Verdict |
|---|---|---|
| `postgres://…:…@localhost:…` | 60+ `*.pg.test.ts` files | Local test databases spun up by `embedded-postgres`. Not credentials. |
| `postgres://user:supersecret@host/db` | `apps/web/app/api/pilot/ops/readiness/route.test.ts:66` | Fixture. Hostname `host` is not resolvable. |
| `postgres://ppbf_app:super-secret-password@prod-db.internal:5432/pilot` | `apps/web/src/server/pilot/db.test.ts:195,302` | Fixture. `prod-db.internal` is not a real host. |
| `postgres://u:p@ppbf-pg-staging.postgres.database.azure.com…` | `apps/web/src/server/pilot/postgresWriteTarget.test.ts:32-35` | Real hostname, placeholder credentials `u`/`p`. |
| `/AccountKey=([^;]+)/` | `apps/web/src/server/pilot/blob.ts:106` | A regex that *extracts* a key. Not a key. |
| `ppbf-session-3f9a1c2b4d5e6f708192a3b4c5d6e7f8` | `apps/web/app/api/pilot/admin/export/roster/route.test.ts:38` | Fixture session token, matching the 32-hex shape by construction. |
| `PPBF_PILOT_BOOTSTRAP_KEY=secretref:…` (65 blobs), `AZURE_AI_KEY=secretref:…` (48 blobs), etc. | `deploy-*.yml`, all historical versions | Azure Container Apps **secret references**. They name a secret; they do not carry one. |

No PEM key, no SAS token, no JWT, no storage connection string, and no `.env`
file has ever existed in this repository. The only `.env`-shaped paths that have
*ever* been added, across all refs, are three:

```
.env.example
apps/coach-review/.env.local.example
apps/web/.env.local.example
```

All three were read in every historical version. The two `*.local.example`
files (from a since-removed Supabase era) contain two variable names and no
values. `.env.example` at HEAD contains 27 variable names; **17 have no value
and the 10 that do are runtime tuning constants**, which the file says outright
at `.env.example:52-54`:

> ```
> # Runtime tuning and feature gates. The values below are what staging and
> # production both run; they are defaults, not secrets.
> ```

`node_modules/` has never been tracked (0 additions across all refs).
`package-lock.json` resolves 1,136 packages, every one from
`https://registry.npmjs.org`, every one carrying an `integrity` hash; the only
two entries without `resolved`/`integrity` are the two workspace links
(`node_modules/web`, `node_modules/research-bridge`). No `git+`, `file:`,
`link:` or bare-`http:` dependency.

### The git history: NOT clean

**S-01 below is the finding.** Two literal credentials sit in the history of a
public repository. Both were removed from `main`; neither was removed from
`origin`.

The repository's own files name the incident. `.gitignore:30-36`:

> ```
> # Local verification harness (agent/developer scratch). Deliberately ignored:
> # .localdev/sessions.json holds live pilot.session_tokens values and the local
> # Postgres password, and this repository is public -- see audit PPBF-SEC-002 for
> # what committing a working credential here has cost before.
> ```

and `apps/web/src/server/pilot/workflowCredentialHygiene.test.ts:5-8`:

> ```
>  * A literal athlete PIN once sat in deploy-staging.yml -- in a PUBLIC
>  * repository, against a publicly reachable staging login, on an account the
>  * fixture provisioner writes as active. That is a working credential published
>  * in source (audit finding PPBF-SEC-002).
> ```

The fix was real and is still in force. What the fix did not do is remove the
credential from the places a `git clone` still reaches.

---

## What ships in the images

Three Dockerfiles. None is built by any CI gate (finding C-01); `Dockerfile` is
built once, by `deploy-staging.yml`, at deploy time.

### `Dockerfile` — the app image (the live one)

Three stages: `base` (`node:22-alpine`, `npm ci` from the committed lockfile),
`builder` (`node:22-alpine`, `COPY . .`, `next build`), `runner`
(**`alpine:3.19`**, `apk add --no-cache nodejs ffmpeg`).

**Does it run as root?** No. `Dockerfile:41` creates a system user and
`Dockerfile:49` switches to it before `CMD`:

> ```
> RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
> …
> USER nextjs
> ```

**Is it multi-stage, or does it ship the toolchain?** Genuinely multi-stage. The
runner starts from bare `alpine`, not from the Node builder, and copies four
paths only:

> ```
> COPY --from=builder /app/apps/web/.next/standalone ./
> COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
> COPY --from=builder /app/apps/web/public ./apps/web/public
> COPY --from=builder /app/infra/azure ./infra/azure
> ```
> — `Dockerfile:44-47`

`npm`, the TypeScript compiler, the test suites, `node_modules`, `docs/`, and
`scripts/` are all left behind in the builder. That is the right shape.

**Does it copy `scripts/data/` or `.env` files?** Not into the final image — the
four `COPY --from=builder` lines above are the whole runtime filesystem, and
none of them reaches `scripts/`. `.env*` is excluded from the build context
outright (`.dockerignore:14`, `**/.env*`), verified to cover both `.env.local`
at the root and `apps/web/.env.local`.

Into the *builder* stage, however, `Dockerfile:21` is an unqualified
`COPY . .` — and `.dockerignore` does not exclude the directories the
repository's own ignore files identify as dangerous. That is finding I-02.

**What it ships that nothing reads:** `infra/azure` is 105 files of SQL DDL. The
only readers of that directory are `apps/web/scripts/pilot-apply-*.mjs`
(60+ files) and `apps/web/scripts/import-shadow-research.pg.test.ts`, none of
which the runner stage copies. Finding I-04.

**ffmpeg is not dead weight** — the Dockerfile's comment saying so is stale.
`apps/web/app/api/pilot/shadow/film-study/diagnostic/route.ts` shells out to it
in-container, and `deploy-staging.yml:282` sets
`PPBF_FILM_STUDY_DIAGNOSTIC_ENABLED=true`. That makes the base-image age
question (I-01) sharper, not softer: ffmpeg is invoked.

### `Dockerfile.research-bridge` — sound

Four stages, `USER node`, `--ignore-scripts` on both installs, `npm prune
--omit=dev` for the runtime `node_modules`, and only `dist/` + pruned
dependencies in the final image. Its `node:24-alpine` base is *deliberately*
ahead of the web app's Node 22 and is matched by its own CI
(`research-bridge-ci.yml:60-62` says so explicitly). Nothing to report.

### `Dockerfile.migration` — dead, and built badly

12 lines. Single stage on `node:22-alpine` (the full toolchain ships), no
`USER` line so it runs as root, and `Dockerfile.migration:9`:

> ```
> RUN npm install pg
> ```

— an unpinned install with no lockfile, resolving fresh from the registry on
every build, in a repository whose main Dockerfile explains at length
(`Dockerfile:11-13`) why it uses `npm ci` instead. Its `CMD` runs
`migration-runner.js`, whose guard refuses every host except `localhost` /
`127.0.0.1` / `::1` — which, inside a container, is the container. Finding I-03.

---

## CI/CD exposure

### The trigger surface

**No workflow anywhere uses `pull_request_target`.** Verified:
`grep -rn "pull_request_target" .github/` returns nothing. Only two workflows
run on `pull_request` at all — `ci.yml` and `research-bridge-ci.yml` — and both
declare `permissions: contents: read` and reference no `secrets.*` beyond the
implicit token. **A fork PR reaches no secret.** This is the single most
important thing to get right in a public repository, and it is right.

The other thirteen workflows are `workflow_dispatch` (two also on `schedule`:
`backup.yml` at `10 7 * * *`, `retention-cleanup.yml` at `40 7 * * *`).

### Secret handling

**No secret is ever echoed to a log, and none is passed as a build arg.**

- `grep -rn "build-args\|--build-arg\|^ARG " .github/workflows/ Dockerfile*` →
  nothing. No secret can persist in an image layer, because no secret enters
  the build.
- Every one of the eleven `echo "…=$CONN" >> "$GITHUB_ENV"` sites was checked
  individually. All eleven are preceded by `echo "::add-mask::$CONN"` on the
  line immediately above or within five lines. `add-mask` appears 17 times
  across the workflow set — masking is applied to org ids and gate PINs too, not
  only connection strings.
- Secrets reach the running app as Azure Container Apps **secret references**
  (`AZURE_POSTGRES_CONNECTION_STRING=secretref:azure-postgres-connection-string`,
  `deploy-staging.yml:265`), never as literals in the workflow.
- `deploy-staging.yml:296-307` then *verifies* the reference resolved to the
  intended secret name and fails the run if not.
- No `set -x` / `set -o xtrace` anywhere.

### What gates a deploy

Strong, and unusually so. `deploy-production.yml` requires **four** guards to
pass in a separate `guard` job before the deploy job starts: dispatch from
`refs/heads/main`; `confirm_sha` exactly equal to the checked-out SHA;
`migrations_complete` exactly `CONFIRMED`; and `release_digest` matching
`^sha256:[0-9a-f]{64}$`. The deploy job then declares `environment: production`
(so a required-reviewer rule can gate it) and — the part worth singling out —
**checks the attestation instead of trusting it**, at
`deploy-production.yml:145-166`, because it had been given falsely before:

> ```
> # `migrations_complete` is the only gate here nothing verifies, and the
> # header of this file says so outright. It has now been attested ahead of
> # the migration twice in two days -- and on 2026-08-07 a production deploy
> # SUCCEEDED that way, shipping code whose audit constraint had not been
> # widened.
> ```

Authentication is Azure OIDC (`azure/login@v3` with `client-id` / `tenant-id` /
`subscription-id`); there is no long-lived Azure credential in GitHub secrets on
any path examined.

### The gaps

- **Nothing builds an image before deploy** (C-01).
- **Actions are pinned to mutable major tags**, not SHAs — `actions/checkout@v7`
  (15 uses), `actions/setup-node@v7` (14), `azure/login@v3` (11),
  `docker/build-push-action@v7`, `Azure/static-web-apps-deploy@v1`. All are
  first-party or Microsoft-published, which bounds the risk, but
  `dependabot.yml` covers `npm` only, so nothing tracks them (C-02).
- **`cache-to: type=gha,mode=max`** (`deploy-staging.yml:126`) exports *every*
  stage's layers to the Actions cache, including the builder stage that ran
  `COPY . .`. In CI the context is a clean `actions/checkout`, so there is
  nothing local in it — see the refutation under I-02.
- **No secret scanning.** The GitHub Advanced Security API returns
  `Repository does not have GitHub Advanced Security enabled` for this
  repository (S-02).

---

## Findings

### [HIGH] S-01 — Two literal credentials are still publicly readable in this repository's git history, on branches `origin` never deleted

**What is wrong.** `.github/workflows/deploy-staging.yml` twice carried a
credential as a literal. Both were fixed on `main`. Neither fix removed the
credential from `origin`, because `main`'s history was rewritten by squash-merge
while the pre-fix branch commits were left in place — and the repository is
public, so a `git clone` fetches them.

1. **A 5-digit numeric literal** assigned to `PILOT_ADMIN_PIN` at
   `deploy-staging.yml:100`, in commit `4422ba35` (2026-07-18, "Add Microsoft
   auth and org admin workflows"). Removed on `main` by `7745489c` (2026-07-18,
   "Remove hardcoded PIN paths and enforce Microsoft-first login UI"), which
   replaced it with `${{ secrets.PILOT_ADMIN_PIN }}`.
2. **A 6-digit numeric literal** assigned to `PILOT_SHADOW_ATHLETE_PIN`,
   appearing at `deploy-staging.yml:228` / `:234` / `:246` / `:254` / `:259` /
   `:279` / `:283` / `:290` / `:303` / `:310` across commits `07df1b92`,
   `3e29fa93`, `909a1e4f`, `b4180e7f`, `3febdd29`, `7d43d594` (2026-07-29 →
   2026-07-30). Removed on `main` by `79a18771` (2026-07-30,
   "fix(security): the gate athlete PIN was a literal in a public repo (#84)"),
   which replaced it with `${{ env.GATE_ATHLETE_PIN }}`.

**Quote-or-shape, with `path:line`.** **The values are withheld and are not
reproduced anywhere in this document, not even partially.** Both are all-digit
numeric strings — the first five digits long, the second six — appearing as
double-quoted YAML scalars in the `env:` block of a `run:` step, in the exact
form `<VARIABLE_NAME>: "<digits>"`. The variable names, file, line numbers and
commit SHAs above are sufficient for the owner to retrieve and rotate them; a
reader without repository access learns nothing usable from this paragraph,
which is the intent.

For the shape of the *fix*, which is safe to quote —
`deploy-staging.yml:411-419`:

> ```
> # The gate athlete's PIN is generated fresh for each run and never
> # committed. It previously sat in this file as a literal -- in a PUBLIC
> # repository, against a publicly reachable staging login, on an account
> # the provisioner writes as active with must_change_pin=false. That is a
> # working credential published in source (audit PPBF-SEC-002).
> ```

**Refutation attempted — four ways, three failed.**

1. *Are these commits reachable from `origin/main`?* **No** —
   `git merge-base --is-ancestor` returns false for all six, and
   `git log origin/main -S'<literal>'` finds nothing. Reading `main` alone, the
   repository looks clean. **This is why the finding is easy to miss, not why it
   is wrong.**
2. *Are the commits reachable from anything on `origin`?* **Yes.**
   `git branch -r --contains 4422ba35` returns **11 remote branches**;
   `git branch -r --contains 07df1b92` returns **6**. Named examples:
   `origin/v1-login-launch`, `origin/security/session-expiry-revocation`,
   `origin/fix/confirmed-defects-p0`, `origin/feat/henry-dual-track-import`,
   `origin/archive/p1-1-control-plane-intent`,
   `origin/claude/ppbf-platform-audit-w3va0j`,
   `origin/claude/github-canvas-visuals-my5bdg-v2` (which still carries the
   literal at its **tip**, not merely in its history).
3. *Is the local mirror stale — were those branches deleted since?* **No.**
   Checked against the live GitHub API branch list: `fix/confirmed-defects-p0`,
   `claude/ppbf-platform-audit-w3va0j`, `claude/shadow-chats-audit-avzt69`,
   `claude/branch-status-open-items-y4ycos`, `claude/admin-athlete-id-autofill`,
   `archive/p1-1-control-plane-intent`, `claude/github-audit-sections-nhuxtr`,
   `feat/henry-dual-track-import` and
   `claude/github-canvas-visuals-my5bdg-v2` (tip `0c15a78f`, matching the local
   mirror exactly) are all present on the remote right now. **143 remote
   branches exist in total.**
4. *Is the repository actually public?* **Yes.** GitHub API:
   `"private": false`, `"visibility": "public"`, `"allow_forking": true`,
   `"forks_count": 0`. The repository's own `.gitignore` asserts the same thing
   three separate times.

**What partially succeeds as mitigation**, recorded honestly:
`deploy-staging.yml:579-598` now deactivates the gate athlete after every run,
`always()` and `continue-on-error`, clearing `pin_hash` and setting
`active_flag = false`; `apps/web/scripts/pilot-provision-gate-fixtures.mjs:132`
is the SQL that does it. Staging PostgreSQL was also recreated on 2026-07-26
(`deploy-staging.yml:406-410`). So it is *likely* neither credential
authenticates today. **Likely is not verified**, and this pass will not make the
request that would settle it.

**Severity.** Recorded as **HIGH**, not CRITICAL, on one narrow ground: this
pass could not establish that either credential is *live*, and the audit's rule
reserves CRITICAL for a live credential. If the owner confirms that either
`org_admin_shadow` or `gate_shadow_athlete` still carries a PIN hash set before
2026-07-30, **this becomes CRITICAL immediately** — `org_admin_shadow` is an
organization administrator, and the athlete fixture is written
`must_change_pin=false`, meaning a session opened with it is not confined to the
PIN-change route.

**Consequence.** The remediation is incomplete in a way that reads as complete.
Anyone auditing `main` — including the hygiene test that was written to prevent
recurrence — sees a clean file. The credential is one `git clone` away for
anyone on the internet, and it will stay there until the carrying branches are
deleted from `origin` (and, for the tip case, force-updated), *and* the
underlying accounts are rotated regardless. Deleting branches does not rewrite
history that a third party may already have cloned or that GitHub may still
serve by SHA, so **rotation, not branch deletion, is the load-bearing fix.**

---

### [MEDIUM] S-02 — A public repository that has already published a working credential has no secret scanning, and the one guard it does have inspects a single directory

**What is wrong.** The only automated defence against a credential re-entering
this repository is `apps/web/src/server/pilot/workflowCredentialHygiene.test.ts`,
and its scope is one directory. Nothing scans the other 2,100 tracked files, and
GitHub's own secret scanning is not enabled.

**Quote, `apps/web/src/server/pilot/workflowCredentialHygiene.test.ts:14`:**

> ```
> const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');
> ```

and its matcher, `:34`:

> ```
> const match = /^\s*([A-Z0-9_]*(?:PIN|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|KEY))\s*:\s*(.+?)\s*$/.exec(line);
> ```

That is a YAML-shaped regex over `.yml`/`.yaml` files in `.github/workflows`
only. A literal in a `.ts` file, a `.mjs` script, a `.ps1` script, a `.sql`
migration, a `.md` runbook, or a `.json` config is not examined by it.

**GitHub-side, verbatim from the API:**

> `Repository does not have GitHub Advanced Security enabled.`

No secret-scanning alerts, and — the part that matters more — **no push
protection**, so a commit containing a recognised credential format is not
blocked at push time.

**Refutation attempted.** Three ways.

1. *Does some other CI step scan for secrets?* No. `ci.yml`'s `validate` job
   runs, in order: entrypoint-contract check, classifier self-test, path
   classification, `npm ci`, `typecheck`, `lint`, `npm test`,
   conditionally `test:migrations` and two Playwright suites, then
   `npm run build`. There is no `gitleaks`, `trufflehog`, `detect-secrets`, or
   equivalent step in any of the fifteen workflows.
2. *Does the hygiene test at least run on every PR that could reintroduce the
   problem?* **Yes — this half of the concern is refuted.** `docsOnly` in
   `scripts/ci-classify-paths.mjs:55-57` is true only when *every* changed file
   starts with `docs/` or ends with `.md`; a `.yml` change fails that, so
   `unknownCode` is set and the full suite including the hygiene test runs. The
   test is not skippable by touching only workflow files.
3. *Is the test itself vacuous?* No — it guards against that explicitly, at
   `:24-26`: `test('the workflow directory is found (guard against a silently
   vacuous test)')`. This is careful work; the problem is its blast radius, not
   its quality.

**Consequence.** The control was scoped to the file where the incident happened
rather than to the class of incident. PPBF-SEC-002 was a PIN in a workflow; the
next one will be an Azure key in a `.mjs` operator script or a connection string
pasted into a runbook, and nothing in this repository would notice. For a public
repository holding the operational surface of a system of record for minors,
enabling GitHub's free secret scanning + push protection for public
repositories is a settings change, not an engineering project.

---

### [MEDIUM] S-03 — Eleven credential-shaped environment variables are read by runtime code and appear in no secret inventory, while `.env.example` claims to be the mirror of that inventory

**What is wrong.** `.env.example` states that it mirrors the authoritative list
of what a running instance is given. It does not. Eleven variables that gate
real credentials are read by application code and are absent from `.env.example`,
from `deploy-staging.yml`'s `--set-env-vars` block, and from
`deploy-production.yml`'s.

**Quote, `.env.example:6-9`:**

> ```
> # The authoritative list of what a RUNNING instance is given is the
> # `--set-env-vars` block in .github/workflows/deploy-staging.yml. This file
> # mirrors it. When that block gains a variable, add it here too, or the next
> # person to set up a machine finds out by hitting a runtime failure.
> ```

**The eleven**, each with the file that reads it:

| Variable | Read at |
|---|---|
| `DATAVERSE_TENANT_ID` | `apps/web/src/server/document-intake/config.ts:24` |
| `DATAVERSE_CLIENT_ID` | `…/config.ts:25` |
| `DATAVERSE_CLIENT_SECRET` | `…/config.ts:26` |
| `GRAPH_TENANT_ID` | `…/config.ts:29` |
| `GRAPH_CLIENT_ID` | `…/config.ts:30` |
| `GRAPH_CLIENT_SECRET` | `…/config.ts:31` |
| `SHAREPOINT_SITE_ID` | `…/config.ts:32` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `…/config.ts:37` |
| `PAYMENT_CONNECT_CLIENT_ID` | `apps/web/src/server/pilot/paymentConnect.ts:44` |
| `PAYMENT_PLATFORM_SECRET_KEY` | `…/paymentConnect.ts:45` |
| `PAYMENT_PLATFORM_WEBHOOK_SECRET` | `…/paymentConnect.ts:46` |

`GOOGLE_SERVICE_ACCOUNT_JSON` is the sharpest of these — it is not an id or an
endpoint but a **private key in a JSON envelope**, parsed at
`apps/web/src/server/document-intake/googleDrive.ts:23-29`:

> ```
> function parseServiceAccount(json: string): ServiceAccount {
>   const parsed = JSON.parse(json) as ServiceAccount
>   if (!parsed.client_email || !parsed.private_key) {
>     throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key')
>   }
> ```

A twelfth, `PPBF_MOCK_INGEST_SESSION_TOKEN`, is documented in
`apps/web/README.md:43` as needing "an active organization-admin session token"
and is likewise absent from `.env.example`. It is a developer-script variable
rather than a runtime one, so it is listed separately.

**Refutation attempted.** Three ways, all failed.

1. *Is the search complete?* The comparison was built from three extraction
   patterns, not one — `process.env.NAME`, `process.env['NAME']`, and the
   `required('NAME')` wrapper that `config.ts` uses (which a `process.env` grep
   alone would have missed entirely). 128 distinct variables were extracted from
   `apps/web`, `packages` and `scripts` and diffed against the 27 in
   `.env.example`.
2. *Are these dead code paths, so the omission is harmless?* No.
   `getPipelineConfig()` is called by `apps/web/app/api/document-ingest/route.ts`,
   a live role-gated route; `PASS-15-egress.md:334` (E-03) documents that same
   route shipping whole uploaded PDFs to all three destinations. `paymentConnect.ts`
   is read by `apps/web/app/api/pilot/payments/connect/start/route.ts:38` and
   surfaced to admins in `apps/web/app/admin/payments/page.tsx:212-213`.
3. *Are they deliberately staging-only, like the research-bridge block that
   `.env.example:63-77` documents as such?* No — that block is present in
   `.env.example` **with an explanatory comment**, which is exactly the pattern
   these eleven do not follow. The file demonstrates it knows how to record a
   conditionally-set variable.

**Consequence.** Two, and the second is the serious one. First, a new machine
configured from `.env.example` fails at runtime, which is the failure mode the
file's own comment warns about. Second, and this is the reason it is filed under
secrets rather than documentation: **the repository has no complete list of the
credentials the platform holds.** After S-01, "rotate everything" is a
foreseeable instruction, and it cannot be executed correctly against an
inventory that omits a Google service-account private key, two Entra client
secrets, and a payment platform secret key.

---

### [MEDIUM] I-01 — The runtime image's Node comes from an Alpine release branch that is past end-of-life, and is pinned to nothing

**What is wrong.** The build stages are pinned to `node:22-alpine`, matching CI
and `engines.node`. The **runtime** stage is not: it starts from a distro image
and installs Node from that distro's package repository.

**Quote, `Dockerfile:27` and `Dockerfile:35`:**

> ```
> FROM alpine:3.19 AS runner
> …
> RUN apk add --no-cache nodejs ffmpeg
> ```

against `package.json:5-7`:

> ```
>   "engines": {
>     "node": "22.x"
>   },
> ```

and the Dockerfile's own opening claim, `Dockerfile:2-7`:

> ```
> # Matches ci.yml/apply-migrations.yml's node-version: 22 -- this was 20,
> # meaning the build CI validates (npm run typecheck/test/build under 22) and
> # the build that actually ships (this stage's npm ci + npm run build) ran
> # under different Node majors. 22 is proven working for this exact codebase
> # by every CI run
> ```

That comment is attached to `FROM node:22-alpine AS base` and is true of the
*builder*. It does not describe the runner, which is where the code actually
executes.

**Two separate problems.**

1. **Version decoupling.** `apk add nodejs` on `alpine:3.19` yields whatever
   Node major that branch carries — which is not 22, and is not `engines.node`,
   and is not what any test ran under. The image is built by one Node major and
   served by another, which is precisely the defect the Dockerfile's own comment
   says was fixed.
2. **Patch supply.** Alpine 3.19 was released 2023-12-07 and carries the
   standard two-year support window, placing its end-of-life at approximately
   2025-11-01 — roughly nine months before this audit's date of 2026-08-18.
   After EOL a branch stops receiving security updates, so `apk add --no-cache`
   installs the last-published `nodejs` and `ffmpeg` from that branch and no
   later fix ever lands. `ffmpeg` is the one to care about: it is a large
   media-parsing surface with a high historical CVE rate, and it is **invoked**
   in this container (`apps/web/app/api/pilot/shadow/film-study/diagnostic/route.ts`,
   enabled in staging by `deploy-staging.yml:282`).

**Refutation attempted.** Four ways; two succeeded partially and are recorded.

1. *Is `nodejs` pinned somewhere I missed?* No. `grep -n "nodejs" Dockerfile`
   returns line 35 only, with no `=version` suffix and no `--repository` flag.
2. *Does something else pin the runtime Node — a `.nvmrc`, an `engines` check at
   startup, a healthcheck?* No `.nvmrc` is tracked; there is no `HEALTHCHECK`
   instruction; `engines` is advisory to `npm`, and `npm` is not in the runner.
3. *Is `ffmpeg` actually unused, as `Dockerfile:33` claims ("Nothing calls it
   yet")?* **This refutation succeeded against the Dockerfile, not against the
   finding.** The comment is stale — the film-study diagnostic route shells out
   to ffmpeg today. That makes the finding stronger, and separately means
   `Dockerfile:29-34` now misdescribes the image (a documentation-drift item
   that belongs to `PASS-12-docs-vs-code.md` if it wants it).
4. *Is the Alpine EOL date right?* **Partially unverified, and marked as
   such.** The release date and Alpine's two-year policy are stable public
   facts, but this pass has no package-index access and did not query
   `pkgs.alpinelinux.org`. The *structural* claim — an unpinned distro package
   from a fixed old release branch, decoupled from the builder — is read
   directly from `Dockerfile:27,35` and does not depend on the date. **The
   specific Node major and the exact EOL date are inference and should be
   confirmed by running `apk policy nodejs` in the built image before acting.**

**Consequence.** The platform's HTTP surface, its PDF parser, and its ffmpeg
invocation all execute on a runtime whose security patches stopped arriving, on
a Node major nothing tested. The remedy is one line — make the runner
`FROM node:22-alpine` and `apk add --no-cache ffmpeg` — which also collapses the
version question entirely.

---

### [MEDIUM] I-02 — `.dockerignore` excludes the developer directories that are merely large, and not the four the repository itself flags as holding live tokens, real children's rosters, and licensed content

**What is wrong.** `Dockerfile:21` is `COPY . .` into the builder stage, so the
build context is the whole working tree minus `.dockerignore`. That file
excludes build output and one agent directory. It does not exclude the four
paths `.gitignore` and the nested ignore files single out as sensitive.

**Quote, `.dockerignore:14-18` (the tail of the file, in full):**

> ```
> **/.env*
> # Agent worktrees are full second copies of the repo -- 13MB of build
> # context that no Dockerfile stage copies from.
> .claude
> **/.worktrees
> ```

The author enumerated the context and reasoned about it — the comment proves
that — and the reasoning applied was **size**, not sensitivity. What is missing,
with the repository's own description of each:

| Not in `.dockerignore` | What the repository says it holds |
|---|---|
| `.localdev/` | `.gitignore:31-33`: "`.localdev/sessions.json` holds live `pilot.session_tokens` values and the local Postgres password" |
| `scripts/data/` | `scripts/data/.gitignore:1-4`: "where a real one will eventually land. A real roster is a list of children: names, dates of birth, and who to call in an emergency." |
| `punxsy-corpus/` | `.gitignore:21-24`: "Cornerstone Library corpus: licensed/internal content" |
| `intake/drops/` | `intake/drops/.gitignore:1-4`: "Drop zone for chat-only AI output. Nothing in here is ever committed" |

`apps/web/page-shots/` and `ppbf_proposed_migrations/` are likewise absent, at
lower stakes.

**Refutation attempted. This one substantially succeeds, and the finding is
filed at MEDIUM because of it.**

1. *Do these files reach the shipped image?* **No.** The runner stage copies
   four paths (`Dockerfile:44-47`), none of which is `scripts/`, `.localdev/`,
   `punxsy-corpus/` or `intake/`. Nothing sensitive ships.
2. *Do they reach CI's build at all?* **No.** `deploy-staging.yml:37-38` is a
   plain `actions/checkout@v7`, so the context is a clean clone containing only
   tracked files — and all four paths are gitignored, so none exists there. The
   CI build is unaffected.
3. *Does `cache-to: type=gha,mode=max` (`deploy-staging.yml:126`) export the
   builder layer anywhere reachable?* It exports to the GitHub Actions cache,
   which is scoped to the repository and requires an Actions token to read — and
   per (2) that layer contains nothing local anyway.

**What survives refutation** is the local-build case, and it is narrow but real:
an operator or agent running `docker build .` on a machine that has followed
`SEED_GUIDE.md` (which directs a real roster into `scripts/data/`) or has used
the local verification harness produces a **builder image layer containing
children's names, dates of birth, emergency contacts, live session tokens and a
Postgres password**. That layer is not shipped, but it exists in the local
image store, is included by `docker save`, and would be pushed by anyone who
tags an intermediate stage or runs a `--target builder` build.

**Consequence.** The defence-in-depth is one line thick. Today the only reason
a roster of minors does not enter a build layer is that the final stage happens
not to copy `scripts/`. Adding four lines to `.dockerignore` makes it
structural instead of incidental, costs nothing, and matches the care already
taken in `scripts/data/.gitignore` — whose own comment says it best: *"'we
remembered not to add it' is not a control."*

---

### [MEDIUM] C-01 — No CI gate builds any image; the only build of the shipped Dockerfile happens during a staging deploy, and the Dockerfile says otherwise

**What is wrong.** `docker/build-push-action` appears exactly once in the
repository, in `deploy-staging.yml`. `ci.yml` — the required `validate` context —
runs `npm run build` (a Next.js build on the runner) and never touches a
Dockerfile. A change to `Dockerfile`, `Dockerfile.migration` or
`Dockerfile.research-bridge` therefore passes every merge gate without being
built.

**Quote — the whole of `ci.yml`'s build step, `ci.yml:153-155`:**

> ```
>       - name: Build production application
>         if: steps.changes.outputs.docs_only != 'true'
>         run: npm run build
> ```

against `Dockerfile:5-7`, which asserts the opposite:

> ```
> # 22 is proven working for this exact codebase
> # by every CI run; not build-tested locally (no docker daemon in this
> # sandbox), so CI's own image build is the real verification.
> ```

and `Dockerfile.migration:1-3`, which repeats it:

> ```
> # Matches ci.yml/apply-migrations.yml's node-version: 22; was 20. Not
> # build-tested locally (no docker daemon in this sandbox) -- CI's own image
> # build is the real verification.
> ```

There is no such CI image build. The verification these comments defer to
occurs, if at all, at `deploy-staging.yml:117-126` — inside a production-track
deploy, after the OIDC login and the staging schema check have already run.

**Refutation attempted.** Three ways, all failed.

1. *Does another workflow build it?*
   `grep -rhoE 'uses: [^ ]+' .github/workflows/ | sort | uniq -c` returns
   `docker/build-push-action@v7` once and `docker/setup-buildx-action@v4` once,
   both in `deploy-staging.yml`. `deploy-production.yml` consumes an existing
   digest (`release_digest`, validated to `^sha256:[0-9a-f]{64}$`) and builds
   nothing.
2. *Is a Dockerfile change perhaps classified as needing extra gates?*
   `scripts/ci-classify-paths.mjs` has no Docker branch. A Dockerfile-only PR is
   not `docsOnly`, not `migrations`, not `boardE2e`, not `homepageE2e` — so
   `unknownCode` is true and the standard suite runs. That suite does not
   include a build of the file that changed.
3. *Does it matter, given the deploy would catch it?* It catches a syntax error,
   yes. It does not catch it *before* an operator has attested `expected_sha`
   and `schema_migrations_complete=CONFIRMED`, authenticated to Azure, and
   verified the staging schema — and a base-image or `apk` regression that
   builds fine but misbehaves at runtime is not caught at all.

**Consequence.** Two Dockerfiles carry a written claim of verification that does
not exist, which is worse than carrying no claim: the next person editing them
reasonably believes CI has their back. In practice the image is validated for
the first time in the middle of a deploy, which is the most expensive place to
discover a build problem and the least appropriate place to discover a runtime
one. A `docker build --target runner .` step in `ci.yml`, gated on the same
`docs_only != 'true'`, would make the comment true.

---

### [MEDIUM] H-01 — `firebase.json` publishes the entire repository root as static hosting, including the directory the seed guide names as the destination for a real roster of children

**What is wrong.** The Firebase Hosting config sets the public directory to the
repository root and ignores only three things.

**Quote, `firebase.json:1-8` (the config, in full):**

> ```
> {
>   "hosting": {
>     "public": ".",
>     "ignore": [
>       "firebase.json",
>       "**/.*",
>       "**/node_modules/**"
>     ],
> ```

`"public": "."` means every file under the repository root is a candidate for
publication. The `ignore` list removes the config itself, dotfiles, and
`node_modules`. It does **not** remove `scripts/`, `docs/`, `infra/`, `apps/`,
`packages/` or `intake/`.

The specific exposure that raises this above tidiness: `scripts/data/` is where
`SEED_GUIDE.md` tells an operator to place the roster, and
`scripts/data/.gitignore:1-4` describes what that is:

> ```
> # This folder is where the seed guide tells an operator to put a roster, so it
> # is where a real one will eventually land. A real roster is a list of children:
> # names, dates of birth, and who to call in an emergency. It must never become a
> # commit, and "we remembered not to add it" is not a control.
> ```

Being gitignored keeps it out of commits. It does **not** keep it out of a
`firebase deploy`, which publishes the working directory, not the index.
`infra/azure/*.sql` — 105 files of complete schema DDL — would likewise be served
as plain text.

**Refutation attempted. This is why the finding is MEDIUM and not CRITICAL.**

1. *Is Firebase Hosting actually wired up?* **No.** No workflow references
   `firebase`; `git grep -rn "firebase"` outside the lockfile returns three
   hits, of which two are in `docs/archive/SESSION_WORK_SUMMARY.md` and one is
   `firebase.json` naming itself.
2. *Is there a project binding?* **No `.firebaserc` exists**, tracked or on
   disk. `firebase deploy` from this directory would prompt for or refuse a
   project rather than silently publishing.
3. *Is it recent?* No — `docs/archive/SESSION_WORK_SUMMARY.md:34` describes it
   as already-configured legacy, and the live deployment path is Azure
   Container Apps.

So the correct characterisation is a **latent** misconfiguration requiring a
human to install the Firebase CLI, bind a project, and run a deploy — not a
live public exposure. It does not meet this audit's CRITICAL bar ("config making
a minor's data publicly reachable"), because nothing makes it reachable today.

**Consequence.** A four-line file with no owner and no deploy path sits in the
root of a public repository, and if anyone ever runs the one obvious command
against it, the result is a public web server over the working tree — including,
by design of the seed workflow, a CSV of children's names, dates of birth and
emergency contacts. The safe action is deletion; if it must stay, `"public"`
should name a directory that contains only publishable assets. The same reasoning
that produced `scripts/data/.gitignore` applies here and has not been applied.

---

### [MEDIUM] M-01 — `scripts/migrate-master-shadow.sh` applies DDL to whatever database the environment points at, with no guard — and it is the twin of a file that was given exactly that guard

**What is wrong.** Two files in this repository apply the same DDL statement.
One refuses any non-local target. The other refuses nothing.

**Quote, `scripts/migrate-master-shadow.sh:1-8` (the file, in full):**

> ```
> #!/bin/bash
> set -e
>
> # Migration script to add has_master_shadow_access column
> psql "$AZURE_POSTGRES_CONNECTION_STRING" <<EOF
> ALTER TABLE pilot.accounts ADD COLUMN IF NOT EXISTS has_master_shadow_access boolean NOT NULL DEFAULT false;
> SELECT 'Migration completed successfully' as result;
> EOF
> ```

Against its twin, `migration-runner.js:3-4,19-22`, which applies the *identical*
`ALTER TABLE`:

> ```
> // Legacy one-off script retained for local/dev recovery only.
> // Production and staging migrations must run through controlled pilot:apply-* scripts.
> …
>   const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
>   if (!localHosts.has(host)) {
>     throw new Error('Refusing non-local target. Use controlled pilot:apply-* migration scripts for shared environments.');
>   }
> ```

The `.js` file states the policy — shared environments go through
`pilot:apply-*` — and enforces it. The `.sh` file states nothing and enforces
nothing.

**Refutation attempted.** Four ways, three failed.

1. *Is this the sanctioned path, making a guard unnecessary?* No. The sanctioned
   path is `apply-migrations.yml` → `npm run pilot:apply-<name>`, and those
   runners share `apps/web/scripts/lib/postgres-write-target.mjs`, which throws
   `MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME` when unconfigured — fails closed,
   deliberately (`postgres-write-target.mjs:78-82`).
2. *Is the script referenced by anything, so its use is at least visible?*
   **No.** `git grep -rn "migrate-master-shadow"` returns exactly one hit: the
   file's own path. No `package.json` script, no workflow, no runbook.
3. *Is the DDL harmless, being `IF NOT EXISTS` and additive?* Largely, yes — a
   `NOT NULL DEFAULT false` column addition is about as benign as DDL gets. But
   the finding is not about this statement; it is about an
   `$AZURE_POSTGRES_CONNECTION_STRING`-consuming DDL executor with no target
   declaration sitting in the tree as a copyable pattern. The next person to
   need a quick column edits this file.
4. *Would an operator plausibly have production credentials in the shell?*
   **Yes — the repository tells them to put them there.** `.env.example:11-13`:
   `az containerapp secret list --name app-ppbf-staging … --show-values -o tsv`,
   and the equivalent production lookup appears in five workflows. The exact
   scenario that `postgres-write-target.mjs:21-26` was written for — *"a run
   from a laptop or an agent shell that happens to hold a production connection
   string in the environment — which is precisely what happened"* — is the
   scenario this script is unguarded against.

**Consequence.** A hardening decision was applied to one of two identical files.
The `.sh` twin is unreferenced dead code whose only remaining function is to
provide an unguarded template for the next ad-hoc migration. The column it adds
was delivered properly on `main` by `cb21fae7` (#449); both this file and
`migration-runner.js` are leftovers of that work and are candidates for deletion
rather than for a new guard.

---

### [MEDIUM] M-02 — `npm run seed:data` overwrites athlete, goal and session rows against any database, with no expected-target guard — the exact case the repository's guard module was written for

**What is wrong.** `scripts/seed-data.ts` performs `on conflict … do update`
writes against athletes, goals and sessions. It gates *destructiveness* behind
an opt-in. It does not gate *which database* — and the module written to do that
exists, is used by 60+ sibling scripts, and describes this precise scenario.

**Quote, `apps/web/scripts/lib/postgres-write-target.mjs:1` — the module's first
line:**

> ```
> // Refuses a fixture/seed write against a database the operator did not name.
> ```

`scripts/seed-data.ts` does not import it. Verified:
`grep -n "postgres-write-target\|assertDeclaredWriteTarget\|EXPECTED" scripts/seed-data.ts`
returns nothing. It reaches the database directly, `scripts/seed-data.ts:22`:

> ```
> import { query } from '../apps/web/src/server/pilot/db';
> ```

and `db.ts` carries no target guard of its own (`grep -n "EXPECTED\|hostname"
apps/web/src/server/pilot/db.ts` returns one comment about TLS and nothing
else).

**The guard it does have, and its hole — `scripts/seed-data.ts:456-463`:**

> ```
> function destructiveSeedAllowed(dryRun: boolean, cliOverride = false): boolean {
>   return (
>     dryRun
>     || cliOverride
>     || process.env.PPBF_ALLOW_DESTRUCTIVE_SEED === 'true'
>     || process.env.NODE_ENV === 'test'
>   );
> }
> ```

`NODE_ENV === 'test'` disables the confirmation entirely. That is an ambient
value on many developer machines and in many shells; it is not an expression of
intent about *this* database, and it sits in an `||` chain with a variable whose
whole purpose is to be an expression of intent.

**Refutation attempted.** Four ways, two succeeded partially.

1. *Is the destructive guard robust?* Largely yes, and it is thoughtfully
   placed — the header at `:451-455` explains it is checked in the CLI section
   *before the config file is imported*, so refusal precedes any `INSERT`, and
   the in-function copy exists so a programmatic caller gets it too. Good work.
   The `NODE_ENV` clause is the hole.
2. *Does the config file naming an organization id act as a target declaration?*
   No — an organization id names a tenant *within* a database, not the database.
   Pointing a staging config at a production connection string is exactly the
   confusion the host guard exists to catch.
3. *Is `seed:data` a niche path?* No. It is a top-level script,
   `package.json:24`, alongside its dry-run twin at `:25`, and `SEED_GUIDE.md`
   is a tracked 11KB operator document built around it.
4. *Is the risk theoretical?* **No, and this is the part that decides the
   severity.** `postgres-write-target.mjs:5-19` records the outcome of the same
   class of mistake, measured: *"The result, measured against production on
   2026-07-30: 361 rows across pilot.accounts (43), pilot.athletes (14),
   pilot.shadow_intake (31) and pilot.audit_events (273) whose organization_id
   resolves to no organization."*

**Consequence.** The one script most likely to be run by a non-engineer, holding
a CSV of real children, is the one script exempt from the control built after a
production data incident. Two changes close it: import
`assertDeclaredWriteTargetFromEnv` the way the 60+ `pilot-apply-*` runners do,
and drop `NODE_ENV === 'test'` in favour of the explicit
`PPBF_ALLOW_DESTRUCTIVE_SEED` that already exists beside it.

---

### [MEDIUM] M-03 — Every production-target guard in this repository parses the host with `new URL()`, and `pg` does not; a `?host=` parameter satisfies the guard and connects elsewhere

**What is wrong.** The repository's target guards decide "which database am I
about to write to" by reading `new URL(connectionString).hostname`. The
PostgreSQL driver they hand the same string to resolves the host differently: a
`host` query parameter takes precedence over the URL's own hostname. The guard
and the connection can therefore disagree.

**Quote, `apps/web/scripts/lib/postgres-write-target.mjs:49-67`:**

> ```
> export function parseConnectionTarget(connectionString) {
>   let parsed;
>   try {
>     parsed = new URL(connectionString);
>   } catch {
>     throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
>   }
>   …
>   const hostname = parsed.hostname.toLowerCase();
> ```

and the same assumption in `migration-runner.js:17`:

> ```
>   const host = (parsed.hostname || '').toLowerCase();
> ```

The driver's parser, `node_modules/pg-connection-string/index.js:40-42` then
`:53-56`:

> ```
>   for (const entry of result.searchParams.entries()) {
>     config[entry[0]] = entry[1]
>   }
>   …
>   const hostname = dummyHost ? '' : result.hostname
>   if (!config.host) {
>     // Only set the host if there is no equivalent query param.
>     config.host = decodeURIComponent(hostname)
>   }
> ```

Query parameters are copied onto the config first; the URL hostname is applied
**only if `config.host` is still unset**.

**Demonstrated, not inferred.** Executed under `node` in this sandbox, no
network and no database touched:

```
$ node -e "…parse('postgres://u:pw@localhost:5432/postgres?host=ppbf-pg-195892.postgres.database.azure.com')…"
URL.hostname       = localhost
pg config.host     = ppbf-pg-195892.postgres.database.azure.com
pg config.database = postgres
```

`migration-runner.js`'s `assertLocalTarget` sees `localhost` and permits the
run; `pg` connects to the Azure host. The same divergence satisfies
`assertDeclaredWriteTarget` for any declared hostname.

`database` is **not** affected — `pg-connection-string/index.js:66-67`
overwrites it from the pathname unconditionally, so only the host is divergent.

**Refutation attempted. This one substantially succeeds on threat model, and
the severity reflects that.**

1. *Would such a string arise by accident?* Almost certainly not. `?host=` is
   not idiomatic in an Azure Postgres connection string, and the guards'
   documented threat model is accident, not adversary —
   `postgres-write-target.mjs:22-24`: *"The exposure is a run from a laptop or
   an agent shell that happens to hold a production connection string."* A
   crafted `?host=` is not that.
2. *Does keyword-form (`host=… dbname=…`) input slip through?* No — `new URL()`
   throws on it and the guard returns `INVALID_POSTGRES_CONNECTION_STRING`.
   Fails closed.
3. *Is the guard tested against this?* No.
   `apps/web/src/server/pilot/postgresWriteTarget.test.ts` is a careful,
   refusal-focused suite (its header at `:2-6` explains why: *"The guard's whole
   value is that it FAILS"*), and its case list contains no `?host=` case. The
   gap is untested rather than knowingly accepted.
4. *Is the CI-side guard independently strong?* **No, and this compounds it.**
   `apply-migrations.yml:236-249` derives the expected host from the very
   connection string it then validates, and says so:
   *"Parse exactly as the runner does (URL, lowercased host, decoded path) so a
   derived value can never disagree with the runner's own parse of the same
   string."* Unless `vars.PPBF_EXPECTED_POSTGRES_HOSTNAME` is configured, the
   workflow-side check is tautological by construction — so if a stored Container
   App secret ever contained `?host=`, the run would report one target in the
   log and write to another, with no layer catching it.

**Consequence.** Filed at MEDIUM, not HIGH: there is no accidental path to a
`?host=` string, so this is guard-completeness rather than a live exposure. It
matters because these guards are the last line between an operator shell and a
production database holding minors' records, they are relied on by 60+ scripts
and every database workflow, and the fix is small — compare against the parsed
`config.host` that `pg` will actually use, or reject a connection string
carrying a `host` parameter outright.

---

### [LOW] I-03 — `Dockerfile.migration` runs as root, installs unpinned, and its entrypoint refuses every target the image can reach

**What is wrong.** Three defects in twelve lines, and the third makes the image
useless.

**Quote, `Dockerfile.migration:4-15`:**

> ```
> FROM node:22-alpine
>
> WORKDIR /app
>
> # Install pg package
> RUN npm install pg
>
> # Copy migration script
> COPY migration-runner.js .
>
> # Run migration
> CMD ["node", "migration-runner.js"]
> ```

1. **No `USER` line** — the container runs as root, unlike `Dockerfile:49`
   (`USER nextjs`) and `Dockerfile.research-bridge:27` (`USER node`).
2. **`npm install pg`, not `npm ci`** — no lockfile in the image, so the
   dependency is re-resolved from the registry on every build. `Dockerfile:11-13`
   argues the opposite position for the app image: *"Install from the committed
   root workspace lockfile with `npm ci` so the production image is a
   reproducible, locked install -- not a fresh resolve against the registry on
   every build."*
3. **Single stage on `node:22-alpine`** — the full Node toolchain ships in what
   is meant to be a one-shot job image.
4. **It cannot work.** `CMD` runs `migration-runner.js`, whose
   `assertLocalTarget` (`migration-runner.js:19-21`) throws unless the host is
   `localhost` / `127.0.0.1` / `::1`. Inside a container that is the container
   itself, which runs no database.

**Refutation attempted.** Two ways, both failed. *Is it referenced by a
workflow or an Azure Container App job?* No —
`git grep -rn "Dockerfile.migration"` returns only the file's own two internal
lines; `infra/modules/container-app-job.bicep` belongs to the research-bridge
stack and names a sync job, not a migration one. *Was the guard added after the
Dockerfile, making this an unnoticed consequence?* Consistent with the evidence,
and it is the most likely history — but it does not change that the artifact is
now non-functional and tracked.

**Consequence.** Low, precisely because it cannot run. It is dead weight that
still reads as a supported migration path to anyone scanning the root directory,
and it contradicts the reproducibility standard the neighbouring Dockerfile
argues for at length. Deletion is the proportionate response.

---

### [LOW] I-04 — The runtime image ships 105 SQL DDL files it contains no reader for

**What is wrong.** `Dockerfile:47` copies the entire migration directory into
the final image:

> ```
> COPY --from=builder /app/infra/azure ./infra/azure
> ```

**Refutation attempted, and the result.** *Is there a runtime reader?* Every
reader of that path was enumerated: `apps/web/scripts/pilot-apply-*.mjs` (60+
files), `apps/web/scripts/import-shadow-research.pg.test.ts`, and one prose
reference in a code comment (`apps/web/app/api/pilot/scheduler/route.ts:120`).
**None of those scripts is copied into the runner stage** — the four
`COPY --from=builder` lines reach `.next/standalone`, `.next/static`,
`public`, and `infra/azure` only, and Next.js standalone output traces server
dependencies, not the sibling `scripts/` directory.

*Is it there for `az containerapp exec` — running a migration from inside the
container?* Plausible as intent, but the runner. contains neither the `pilot-apply-*`
scripts nor `npm`, so that workflow cannot complete. If that is the intent, the
image is missing the other half.

**Consequence.** Minor. 105 files of complete schema DDL — table definitions,
constraint names, index names — sit in a running container that cannot use them,
enlarging both the image and the amount of structural information available to
anyone who obtains a shell in it. Either drop the line or add the scripts that
would make it purposeful.

---

### [LOW] C-02 — Dependabot watches npm only, so the mutable action tags every workflow depends on are tracked by nothing

**What is wrong.** `.github/dependabot.yml:1-9` (the file, in full):

> ```
> version: 2
> updates:
>   - package-ecosystem: "npm"
>     # Single npm workspace root (package-lock.json lives here; apps/web and
>     # packages/* are workspace members Dependabot resolves from this one file
>     # -- pointing it at a member directory instead would miss the lockfile).
>     directory: "/"
>     schedule:
>       interval: "weekly"
> ```

The npm configuration is correct and its comment shows the workspace question
was thought through. There is no `github-actions` ecosystem entry, so the 43
`uses:` references across the fifteen workflows are never proposed for update.

Every one of them is pinned to a **major tag**, not a commit SHA:
`actions/checkout@v7` (15), `actions/setup-node@v7` (14), `azure/login@v3` (11),
`docker/setup-buildx-action@v4`, `docker/build-push-action@v7`,
`actions/upload-artifact@v7`, `actions/github-script@v7`,
`Azure/static-web-apps-deploy@v1`. A major tag is mutable: whatever the
publisher moves it to is what runs, in workflows that hold `id-token: write` and
read production database secrets.

**Refutation attempted.** Two ways, one partially succeeds. *Is the risk
material given the publishers?* All eight are GitHub-owned, Microsoft-owned or
Docker-owned — the highest-trust tier available, which genuinely bounds this.
*Do fork PRs reach these?* No — see "CI/CD exposure"; no `pull_request_target`,
and the two `pull_request` workflows hold `contents: read` and no secrets. So
the exposure requires a compromise at the publisher, not at a contributor.

**Consequence.** Low, and listed mainly because the fix is four lines of YAML
and because the workflows this protects are the ones holding production
credentials. Adding a `github-actions` ecosystem entry at minimum surfaces the
updates; SHA-pinning the eight actions is the stronger form.

---

### [LOW] C-03 — The production deploy falls back to the staging resource-group name

**What is wrong.** `deploy-production.yml:117`:

> ```
>       RESOURCE_GROUP: ${{ secrets.AZURE_PRODUCTION_RESOURCE_GROUP || 'rg-ppbf-enterprise-staging' }}
> ```

If the production resource-group secret is unset, the production deploy — and
its `az containerapp secret show` lookup of the production database connection
string — is directed at a resource group named for staging.

**Refutation attempted, and it largely succeeds.** *Is this a mistake?* No, it
is deliberate and commented one line above: *"Preferred: explicit production RG
secret. Fallback keeps current behavior for repositories that have not populated
the new secret yet."* *Is the fallback wrong?* Apparently not, factually:
`docs/current/PRODUCTION_STATE.json` and
`docs/archive/PHASE2_PRODUCTION_VERIFICATION_2026-07-18.md:127` both record
production Container App operations against
`--resource-group rg-ppbf-enterprise-staging`. **Production and staging share
one resource group.** The fallback describes reality.

**Consequence.** The finding is therefore not the fallback but what it reveals:
staging and production Container Apps live in one resource group, so any RBAC
grant scoped to that group spans both, and a `--name` typo in any of the eleven
`az containerapp` invocations crosses the environment boundary rather than
failing. Whether that matters depends on the actual role assignments, which this
pass cannot see (see "Could not establish"). Recorded at LOW so it is visible to
whoever *can* see them.

---

### [LOW] H-02 — The root `staticwebapp.config.json` rewrites to nine HTML files that do not exist, and its fallback points at a legacy unauthenticated page presenting athlete-shaped health notes

**What is wrong.** Two problems in one file, both stale rather than dangerous.

**First, the rewrite targets do not exist.** `staticwebapp.config.json:2-42`
defines ten routes rewriting to `/public.html`, `/board.html`,
`/board/president.html`, `/board/chair.html`, `/board/vice-chair.html`,
`/board/treasurer.html`, `/board/secretary.html`, `/board/safety-director.html`,
`/board/community-director.html` and `/board/at-large.html`. `git ls-files
'*.html'` returns 20 files: 19 under `design-system/` and `index.html`. **None
of the ten targets is tracked.** Every one of those routes would 404 or fall
through.

**Second, the fallback.** `staticwebapp.config.json:44-47`:

> ```
>   "navigationFallback": {
>     "rewrite": "/index.html",
>     "exclude": ["*.{css,scss,js,png,gif,ico,jpg,jpeg,svg,webp,woff,woff2}"]
>   }
> ```

Root `index.html` is a standalone legacy page titled *"PPBF Platform - Coach
Review"* with no authentication of any kind, presenting athlete-shaped records
with injury notes. `index.html:20,25` and `:29,34`:

> ```
>                 athlete: "Marcus Thompson",
>                 …
>                 redFlags: []
>                 …
>                 athlete: "Jordan Lee",
>                 …
>                 redFlags: ["Shoulder discomfort"]
> ```

It also loads an external script, `index.html:7`:

> ```
>     <script src="https://cdn.tailwindcss.com"></script>
> ```

which would be refused outright by the app's own CSP (`connect-src 'self'`,
`script-src 'self' 'unsafe-inline'`, `apps/web/next.config.ts:20-36`).

**Refutation attempted. It largely succeeds, which is why this is LOW.**

1. *Is this config live?* Almost certainly not. The Static Web Apps workflow is
   named `legacy-static-web-apps-manual` and refuses to run without a typed
   confirmation string (`azure-static-web-apps-purple-bush-04c73e010.yml:13`,
   `if: inputs.confirm_legacy_swa_deploy == 'LEGACY_SWA_ONLY'`), with a second
   job that exits 1 otherwise.
2. *Would this file even be the one SWA read?* No. That workflow sets
   `app_location: "apps/web"` (`:30`), and `apps/web/staticwebapp.config.json`
   exists and is `{}` — an empty object. The root file is not on the path SWA
   would use.
3. *Is the athlete data real?* **No.** It is two hardcoded fabricated records in
   a client-side array. No child's actual data is present.
4. *Are security headers missing here a new finding?* No —
   `PASS-15-egress.md:493` already records it, and
   `apps/web/next.config.ts:59-61` explains the division deliberately: *"headers()
   applies to the standalone (container app) deployment, which is the live one.
   The static-export path ignores it; if that path ever ships,
   staticwebapp.config.json must mirror these."* Not re-reported.

**Consequence.** Low. Two dead configs and a dead page, in the root of a public
repository, describing a routing topology the platform does not have. The one
thing worth acting on is `index.html`: it presents athlete names alongside
injury flags with no disclosure that it is fabricated, and it is the target of
both surviving static-hosting fallbacks (this one and `firebase.json`'s). If
either static path is ever revived, it is the first thing a visitor sees.

---

### [LOW] A-01 — `ersjasonppbf-platformappsweb` is a stray shell-redirect artifact tracked on `main`

**What is wrong.** A 1,675-byte file with no extension sits in the repository
root. Its contents are `git diff --name-status` output — 44 lines of status
letters and paths:

> ```
> M	.dockerignore
> M	.github/workflows/deploy-staging.yml
> M	.gitignore
> A	Dockerfile.research-bridge
> A	apps/research-bridge/package.json
> …
> M	package-lock.json
> ```
> — `ersjasonppbf-platformappsweb:1-44`

The filename is a Windows path with its separators stripped —
`…\Users\jason\ppbf-platform\apps\web` collapsed — i.e. a redirect target that
lost its backslashes. It was added by `d7899044` (2026-08-11) and re-added by
`636ea678` (2026-08-12); its current contents correspond to the research-bridge
change (#449), so it has been overwritten by at least one later mangled redirect.
It is present on `origin/main`. Nothing references it
(`git grep -rn "ersjasonppbf"` returns no hits).

**Refutation attempted.** *Does it contain anything sensitive?* **No.** The file
was read in full: 44 lines, each a status letter and a repository-relative path,
all of which are tracked files anyway. No credential, no data, no PII. *Is it
generated or needed?* No — no script writes it and nothing reads it.

**Consequence.** Cosmetic, and reported only because the pass brief asked what it
is. It is a mistyped redirect committed twice, and it is safe to delete. Its one
signal worth noting: it indicates commits are being made from a Windows shell
with `git add -A`-style staging, which is the same mechanism that would sweep in
an untracked file that *does* matter — the risk `scripts/data/.gitignore` and
`intake/drops/.gitignore` were written to block.

---

### [LOW] A-02 — The root PowerShell suite reports platform health from file existence alone, and points at a database the platform does not use

**What is wrong.** Four `.ps1` files in the repository root
(`setup.ps1`, `health-check.ps1`, `master-runner.ps1`, `ppbf-cli.ps1`) present
themselves as operational tooling and verify nothing.

`health-check.ps1` runs seven checks, each a `Test-Path`, then concludes
(`health-check.ps1:27-28`):

> ```
> Write-Host "✅ Platform health check complete." -ForegroundColor Green
> Write-Host "All core systems are in place." -ForegroundColor Cyan
> ```

"All core systems are in place" means seven files exist on disk. It contacts no
database, no Container App and no endpoint.

`master-runner.ps1:20-26` instructs the operator to connect a database this
platform does not use:

> ```
> Write-Host "After running the above:" -ForegroundColor Yellow
> Write-Host "- Install dependencies in apps/web"
> Write-Host "- Connect Supabase"
> Write-Host "- Get Jason final approval"
> ```

The platform runs on Azure PostgreSQL; Supabase survives only in two removed
`.env.local.example` files visible in history. `master-runner.ps1:7` also
invokes `init.ps1`, `check-governance.ps1`, `go-live.ps1` and `run-tests.ps1`
from the root, where none of them exists (they are in `scripts/`), so its own
`Test-Path` branch prints "skipped" for all four and the script does nothing at
all.

`ppbf-cli.ps1` dispatches to eleven documents, of which
`MASTER_EVERYTHING_REFERENCE.md`, `THANK_YOU_CLOSING.md`,
`ULTIMATE_CLOSING_DOCUMENT.md` and `ULTIMATE_PROJECT_SUMMARY.md` are not
tracked.

Related, in `package.json:23`:

> ```
>     "deep:audit": "powershell -ExecutionPolicy Bypass -File ./scripts/deep-audit.ps1",
> ```

`-ExecutionPolicy Bypass` in a committed npm script normalises disabling the
host's script-execution policy.

**Refutation attempted.** Two ways, one partially succeeds. *Is any of this
load-bearing?* No — none is referenced by a workflow, and `health-check.ps1`
exists in duplicate at `scripts/health-check.ps1`. *Is this simply old scaffolding
nobody claims is current?* Substantially yes, and that is why it is LOW rather
than MEDIUM. But `health-check.ps1` is discoverable, prints green, and asserts a
conclusion about the platform's health; and `AGENT_KERNEL.md`'s own fifth
invariant is *"Claims need evidence… Code-reading alone is not runtime proof."*
A file-existence check reported as a health check is the same category error the
kernel names.

**Consequence.** An operator who runs the obvious-looking script in the root of
the repository is told the platform is healthy on the strength of seven
`Test-Path` calls, and is then told to connect a database that was removed. The
proportionate response is deletion; if any of it is worth keeping, it belongs in
`scripts/` next to the real tooling.

---

## Checked and found sound

Recorded because a pass that lists only problems misrepresents the system, and
because several of these are better than the norm for a project this size.

**Secrets and ignore hygiene**

- **No `.env` file has ever been committed**, on any branch, at any point. The
  only `.env`-shaped paths in history are three `*.example` files, all read in
  every historical version, all valueless.
- **`.gitignore` coverage is correct and reasoned.** `git check-ignore -v`
  confirms `.env`, `.env.local`, `apps/web/.env` and `apps/web/.env.local` are
  all ignored, by `.gitignore:4-5` and `apps/web/.gitignore:42` respectively.
- **The nested ignores are the strongest part.** `scripts/data/.gitignore` and
  `intake/drops/.gitignore` both use deny-all-then-allow (`*` followed by
  explicit `!` exceptions) rather than enumerating what to exclude — the correct
  construction when the directory's purpose is to receive files nobody has seen
  yet.
- **The example CSVs are unambiguously synthetic**: `EXAMPLE-001`,
  `EXAMPLE Athlete One`, `000-000-0001`, `@example.invalid`. No real name, no
  real number, no real address.
- **`package-lock.json` is clean**: `lockfileVersion 3`, 1,136 packages, all
  from `registry.npmjs.org`, all with `integrity` hashes, no `git+`/`file:`/
  `link:`/`http:` sources.
- **`node_modules/` has never been tracked** (0 additions across all refs).

**CI/CD**

- **No `pull_request_target` anywhere.** The single highest-value thing to get
  right in a public repository.
- **Fork PRs reach no secret.** The only two `pull_request`-triggered workflows
  declare `permissions: contents: read` and reference no `secrets.*`.
- **No secret is echoed.** All eleven `$GITHUB_ENV` writes of a connection
  string are individually preceded by `::add-mask::`; 17 masking calls total.
- **No build args.** No secret can be baked into an image layer, because none
  enters a build.
- **Azure OIDC throughout**, no long-lived cloud credential in GitHub secrets on
  any examined path.
- **`deploy-production.yml` verifies its own attestation** rather than trusting
  it (`:145-166`), after that attestation was given falsely twice.
- **`deploy-staging.yml:296-307` verifies the deployed revision resolved
  `AZURE_AI_KEY` to the intended secret reference** and halts if not — checking
  the deployment rather than assuming it.
- **Concurrency is set per environment** on every mutating workflow, with
  `cancel-in-progress: false`, and `ci.yml:15-20` explains why cancellation is
  allowed on PRs and forbidden on `main` (a cancelled required check reads as
  "never validated").
- **`backup.yml` documents its own security trade-off** rather than hiding it —
  `:15-31` explains why it declares no `environment:` (a scheduled run against a
  protected environment waits for a human and is cancelled after thirty days),
  and states the OIDC-subject consequence explicitly. `:33-36` names what is in
  the dump ("PIN hashes and every minor's record") and what protects it. That is
  how a risk decision should be recorded.

**Infrastructure as code (`infra/`, the research-bridge stack)**

- `storage.bicep:17-23`: `allowBlobPublicAccess: false`,
  `allowSharedKeyAccess: false`, `defaultToOAuthAuthentication: true`,
  `minimumTlsVersion: 'TLS1_2'`, `supportsHttpsTrafficOnly: true`. Both
  containers set `publicAccess: 'None'`.
- `container-app.bicep:174-213`: the Entra auth config is genuinely wired, not
  merely parameterised — `unauthenticatedClientAction: 'Return401'`,
  `requireHttps: true`, `allowedAudiences` bound to the API registration, and
  `defaultAuthorizationPolicy.allowedApplications` restricted to the single
  Claude connector client id. Only `/health` is excluded. The identifiers in
  `main.parameters.json` are Entra client ids and a session GUID — public
  identifiers, not credentials.
- `key-vault.bicep:17-19`: `enableRbacAuthorization: true`,
  `enableSoftDelete: true`.

**Operator tooling**

- **`scripts/backup-export.ps1` is exemplary** and is the standard the other
  scripts should be held to: it requires an explicitly named `-ExpectedHostname`
  and `-ExpectedDatabase` and refuses on mismatch (`:47-75`); it never echoes the
  connection string; and `:87-91` **refuses to write the dump inside the
  repository at all** — *"Refusing to write a database dump inside the repository
  ($resolvedOutput). This repository is public."*
- **`migration-runner.js` is guarded** (`:19-21`) — the finding against it (M-03)
  is a parser subtlety, not an absent control.
- **The 60+ `pilot-apply-*` runners share one guard module** that fails closed
  when unconfigured, deliberately (`postgres-write-target.mjs:78-82`).
- **`apps/web/next.config.ts:24-51` sets a full security-header set** —
  CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`; plus `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy`
  denying camera/microphone/geolocation, and HSTS — on the deployment that is
  actually live, with `apps/web/src/securityHeaders.test.ts` pinning each one.
  Each allowance is justified against the app's real inventory rather than
  copied from a template.
- **`Dockerfile.research-bridge`** — four stages, non-root, `--ignore-scripts`
  on install, dev dependencies pruned, only `dist/` shipped, and a Node major
  deliberately chosen and matched by its own CI.

---

## Could not establish

Stated as holes rather than filled with plausible answers.

1. **Whether either credential from S-01 still authenticates.** Settling it
   requires a request against the publicly reachable staging login, or a read of
   `pilot.accounts` for `org_admin_shadow` and `gate_shadow_athlete`. This pass
   made neither. **The exposure is established; the liveness is not.** Treat
   both as compromised and rotate — that is the correct action under
   uncertainty, and it is cheap.
2. **Whether the `production` GitHub environment actually carries a
   required-reviewer protection rule.** Three workflows depend on it
   (`deploy-production.yml:111`, `apply-migrations.yml:165`,
   `check-database.yml:80` and five others via `environment: ${{ inputs.target }}`).
   `deploy-production.yml:92-108` asserts the rule exists and that
   `AZURE_CLIENT_ID` carries both `github-main` and `github-production-env`
   federated credentials. That is a claim in a comment, not a verified fact, and
   it is not visible from the tree.
3. **The values behind every `secrets.*` and `vars.*`,** including whether
   `vars.PPBF_EXPECTED_POSTGRES_HOSTNAME` is configured — which is the difference
   between the workflow-side migration guard being a real check and being the
   tautology described under M-03.
4. **Branch protection on `main`**, and therefore whether the merge path that
   makes `backup.yml`'s ref-scoped OIDC identity safe is actually enforced.
5. **Azure-side reality**: RBAC assignments on `rg-ppbf-enterprise-staging`
   (which holds both environments, per C-03); whether the `ppbf-pilot-backups`
   container is in fact private; whether Defender for Storage malware scanning is
   on, which `deploy-staging.yml:233-243` correctly identifies as unknowable from
   this repository; and whether the production Postgres firewall admits arbitrary
   IPs.
6. **What the built images actually contain.** No Docker daemon, and building is
   a mutation. The Node major on `alpine:3.19` and the exact EOL date under I-01
   are inference from the Dockerfile plus public release policy, not observation.
   `apk policy nodejs` inside the built image settles it in one command.
7. **Known vulnerabilities in the dependency set.** Out of scope by instruction —
   no `npm audit`, no CVE lookup. The dependency review here is structural only
   (provenance, integrity, pinning). Two items are flagged for whoever does run
   that check, on shape rather than on any vulnerability claim:
   `pdf-parse@^2.4.5`, which parses attacker-supplied PDFs server-side at
   `apps/web/app/api/document-ingest/route.ts:3` (size-bounded to 10 MB,
   signature-checked, and 15-second-timeout-bounded, which is the right shape);
   and `googleapis@^174.0.0`, a very large dependency pulled into the web
   runtime for a single Drive upload call in
   `apps/web/src/server/document-intake/googleDrive.ts`.
8. **Whether the 143 remote branches are intentional.** Their number is what
   turned S-01 from a fixed incident into a live one, but whether any is still
   wanted is an owner question, not an audit finding. What can be said: at least
   17 branch-histories carry a credential literal, and no workflow prunes
   branches automatically (`branch-cleanup.yml` is `workflow_dispatch` with an
   explicit branch list).

---

## Summary by severity

| ID | Severity | Finding |
|---|---|---|
| S-01 | **HIGH** | Two literal credentials publicly readable in git history on 17 undeleted `origin` branches; values withheld |
| S-02 | MEDIUM | No secret scanning or push protection; the only guard inspects `.github/workflows/` alone |
| S-03 | MEDIUM | 11 credential-shaped env vars in no secret inventory, while `.env.example` claims to be that inventory |
| I-01 | MEDIUM | Runtime image installs Node + ffmpeg unpinned from an Alpine branch past EOL, decoupled from the builder and from `engines.node` |
| I-02 | MEDIUM | `.dockerignore` omits the four directories the repository flags as holding live tokens, real rosters and licensed content |
| C-01 | MEDIUM | No CI gate builds any image; two Dockerfiles claim a CI build that does not exist |
| H-01 | MEDIUM | `firebase.json` publishes the whole repository root, including the roster drop directory (latent — no deploy path) |
| M-01 | MEDIUM | `migrate-master-shadow.sh` applies DDL to any target with no guard; its `.js` twin has one |
| M-02 | MEDIUM | `seed:data` overwrites athlete/goal/session rows with no target guard, and `NODE_ENV=test` alone disables its destructive confirmation |
| M-03 | MEDIUM | Target guards parse the host with `new URL()`; `pg` honours a `?host=` override — demonstrated executably |
| I-03 | LOW | `Dockerfile.migration`: root user, unpinned install, and an entrypoint that refuses every reachable target |
| I-04 | LOW | Runtime image ships 105 SQL DDL files with no reader present |
| C-02 | LOW | Dependabot covers npm only; 43 mutable action tags tracked by nothing |
| C-03 | LOW | Production deploy falls back to the staging resource-group name — which is correct, revealing a shared resource group |
| H-02 | LOW | Root `staticwebapp.config.json` rewrites to nine files that do not exist; its fallback is a legacy unauthenticated page with fabricated athlete health notes |
| A-01 | LOW | `ersjasonppbf-platformappsweb` — a mistyped shell redirect committed twice; contains no sensitive data |
| A-02 | LOW | Root `.ps1` suite reports platform health from `Test-Path` and directs the operator to a database the platform does not use |
