# Release Procedure

This file governs staging and production release work only. Ordinary building follows `AGENT_KERNEL.md` and `docs/AI_COLLABORATION.md`.

## Who releases (OD-2026-08-29-006)

There is no permanent production bot, deploy coordinator, gatekeeper model, or model-specific release owner.

- Jason is the sole human production approval authority.
- **Staging:** a Claude session (the only builder, OD-2026-09-28-001) may
  dispatch `deploy-staging` and staging migrations through
  `.github/workflows/apply-migrations.yml`.
- **Production:** `deploy-production` and production migrations are prepared
  and verified by that session, then dispatched only on Jason's explicit word. That
  authority is task-scoped and ends when the release is completed, stopped, or
  handed back. `release-one-approval` (below) is a production dispatch from its
  first step, although it begins by deploying staging.
- **GitHub requires a separate approval for every run** of a protected
  workflow. Approving two runs does not carry to later dispatches.
- No AI may approve the protected GitHub `production` environment, invent a migration attestation, authorize a rollback, weaken a failed gate, or claim live verification from source reading.
- The one exception, from the owner's workspace rules (L2): when Jason has personally opened the authenticated production-approval page in Claude's in-app browser and explicitly instructs Claude to approve that specific run, Claude may perform the reviewer click. It is not standing approval and never covers a run without his instruction for that run.

The deployment workflows are the control plane. The AI is only a temporary operator of those controls.

## Release states

Keep these claims distinct:

1. `MERGED` — code is on `main`.
2. `CI_VERIFIED` — required GitHub checks passed for the exact SHA.
3. `STAGED` — the exact SHA was deployed to staging and an immutable image digest was captured.
4. `PRODUCTION_DEPLOYED` — the protected production workflow completed for that SHA and digest.
5. `PRODUCTION_RUNTIME_VERIFIED` — the live environment was read back and the required probes passed.

A later state must not be inferred from an earlier one.

## Prepare a release

A request such as `Prepare current main for production; do not deploy yet` authorizes staging and evidence collection, not final production approval.

For the exact candidate SHA:

1. Confirm it is current on `main` and inspect open PRs and active deployment runs for collisions or stale releases.
2. Confirm the required CI result is green.
3. Diff the candidate against the SHA currently observed in production (live
   evidence, not `docs/current/PRODUCTION_STATE.json`). Determine whether the range includes schema, migration-runner, environment-variable, auth, organization-isolation, safeguarding, or SHADOW safety changes.
4. Apply required staging migrations through `.github/workflows/apply-migrations.yml`. Never apply them from a laptop or ad hoc AI shell.
5. Dispatch `.github/workflows/deploy-staging.yml` for the exact SHA and the applicable gates.
6. Capture the immutable `sha256:` image digest produced by staging, from that run's `staging-image-digest` artifact (`staging-image-digest.txt`) -- never by grepping a run log.
7. Verify the staging revision, traffic, smoke checks, and any release-specific acceptance probe.
8. Return one compact release packet:

```text
RELEASE READY
SHA: <40-character main SHA>
Image: sha256:<64 hex characters>
CI: PASS
Staging: PASS
Migrations required: yes/no
Staging migrations: PASS/not applicable
Release-specific probes: PASS/list
Open production runs: none/list
Rollback: NO
Owner action: authorize promotion
```

Stop instead of producing `RELEASE READY` when any item is unknown or failed.

## Promote to production

Production promotion requires a separate explicit instruction from Jason, such as `Promote that release`.

1. If migrations are required, dispatch the production migration workflow first and verify its result. Do not type `CONFIRMED` from assumption or from a merged SQL file alone.
2. If the release introduces or changes reference data the new code depends
   on, seed it **before** `deploy-production`, after the migrations. The seed
   account for gym content is an organization admin of `punxsy_prominence`
   (`ppbf@punxsyprominence.org`), never the platform-owner account (Admin@):
   gym work uses the organization-admin account (`ORGANIZATION_ROLE_MODEL.md`,
   Organization Admin; OD-2026-09-28-005; the owner's workspace rules). Read
   its exact `account_id` fresh from **production** (`check-database`,
   seed-identity, production), run `seed-reference-data` as a dry-run, then
   apply with that account. In both runs pass
   `organization_id=punxsy_prominence` -- the gym's organization
   (OD-2026-09-28-007); the workflow requires it. Never reuse an id from
   staging: `account_id` is case-sensitive, and staging's seed account was a
   different, lowercase admin address. Every dataset loads through the
   content-import core, which checks that account before reading anything
   else -- an active organization admin (or admin) with an active membership
   in the gym, never the platform owner
   (`apps/web/src/server/pilot/contentImport/actor.ts`) -- and records its own
   role as `created_by_role` on every row it writes. The dry-run prints the
   plan with the account and role it will record; `dataset: all` then applies
   every dataset in one transaction.
   Deploying first leaves
   production serving code whose catalogs are empty, which the archived
   2026-08-24/25 release record shows, and whose planned sequence was
   migrations, seed identity, seed dry-run and apply, then deploy.
3. Dispatch `.github/workflows/deploy-production.yml` from `main` using:

```text
confirm_sha: <exact prepared SHA>
release_digest: <exact staging-tested digest>
migrations_complete: CONFIRMED
allow_rollback: NO
```

4. GitHub must halt at the protected `production` environment for Jason's approval. No AI approves that checkpoint, except as stated once under *Who releases* above.
5. The workflow must verify the production schema, digest availability, rollback direction, deployment, and smoke checks.

A schema check is verified by running it, not by searching its source.
`pilot-verify-schema.mjs` derives its expected objects from the migration SQL at
deploy time, so a string search of the script says nothing about what it checks
(a 2026-08-24 claim built on such a search was wrong).

The SHA and digest must describe the same staged artifact. If `main` moves after staging, re-validate the release rather than pairing an old digest with a new SHA.

## One run, one approval: `release-one-approval`

A second valid path for the same release, added 2026-10-01 (OD-2026-09-30-007
section 2). `.github/workflows/release-one-approval.yml` does *Prepare a
release* and *Promote to production* in ONE run for ONE frozen commit, with one
production approval. It exists because the three-dispatch path takes `main`'s
head at each dispatch, and `main` moving during the roughly ten minutes a
release takes made `deploy-production` refuse the staged digest. Here both
halves use the run's own commit, so `main` moving after dispatch changes
nothing. The three workflows above are unchanged and remain valid.

**It has never been run** (as of 2026-10-01). What is established about it is
static: `releaseOneApprovalContract.test.ts` holds its shape and holds every
copied step equal to its source in `deploy-staging.yml` and
`deploy-production.yml`. Its first run needs overwatch and Jason, and the
checks under *Before the first use* below.

**Authority is the production rule, not the staging one.** Dispatching it is
dispatching a production release: only on Jason's explicit word, like
`deploy-production`. That a session may dispatch `deploy-staging` on its own
does not extend to this workflow, although its first job is a staging deploy.

### What it does

| Job | Environment | In order |
|---|---|---|
| `staging` | `staging` (no reviewer, so no pause) | refuse a re-run, a wrong ref or a wrong commit; apply staging migrations; verify staging schema; build the image once, tagged with the commit; deploy it to staging; wait for the revision; run the staging gates; deactivate the gate fixture |
| `production` | `production` (**the one approval**) | the same refusal; then read-only checks: the digest exists in the registry and carries the commit's tag, the rollback guard, production AI configuration, no SHADOW job waiting. Only then: apply production migrations; verify production schema; check the SHADOW queue again; deploy the staging digest; wait for that revision and digest; smoke checks; report |

The approval is asked only after the `staging` job has succeeded, with its
results on the same run page. The migration order in both jobs is the `all`
list of `apply-migrations.yml`, read through
`apps/web/scripts/migration-apply-order.mjs`; the workflow holds no list of its
own.

### When it may NOT be used

- **The release needs reference data seeded.** It does not seed. A release
  whose code depends on newly seeded reference content stays on the
  three-workflow path (step 2 of *Promote to production*).
- **A migration is not additive and idempotent.** It applies every routine
  migration to production in one go, behind the one approval.
- **Only one environment is wanted.** Use `deploy-staging` or the production
  pair.

A release that needs Jason's signed-in look at staging (sign-in, minors' data
or safety screens) CAN use it: the run waits at the approval for as long as he
needs, with the new image live on staging. Nothing in the workflow checks that
he looked. That check stays a rule the operator keeps.

### Dispatch

From `main` only:

```text
confirm_sha: <full 40-character SHA of main's head>
confirm_production: production
allow_rollback: NO
enable_shadow_gate: true
```

There is no `release_digest` input and no migration attestation. The digest is
the `staging` job's output; the migrations are applied and verified by the run.

### Reading the result

- **`staging` failed.** Production was never offered. Staging may still have
  been migrated and deployed (the deploy and its gates are different steps).
- **`staging` failed at "Refuse Promotion While The Gate Athlete Fixture May
  Be Live".** The gate athlete's PIN may still work on staging's public login.
  Clear it before anything else. `deploy-staging` only reports this; here it
  stops the release.
- **`production` failed before "Apply Production Migrations".** Nothing was
  written to production.
- **`production` failed at or after "Apply Production Migrations" and before
  the deploy completed.** This is NOT `PRODUCTION_DEPLOYED`. Production's
  schema may be AHEAD of the running app. Nothing is rolled back. Fix the
  cause and dispatch a fresh run; the migrations are idempotent.
- **Green.** `PRODUCTION_DEPLOYED` for that commit and digest. *Verify
  production* below still applies before `PRODUCTION_RUNTIME_VERIFIED`.

The last step, "Report What Production Now Runs", writes which of these it was
into the run summary.

**Never use "Re-run failed jobs" or "Re-run all jobs".** Both jobs refuse any
attempt after the first before changing anything. A re-run of `production`
still asks for the approval first, because GitHub asks before the job's first
step; approving it changes nothing. Dispatch a fresh run.

### Concurrency: release and migration serialization only

- The whole workflow is one group, so a second `release-one-approval` run
  cannot start its staging half while the first waits for the approval.
- Its `staging` job shares the group of `deploy-staging` and of a staging
  `apply-migrations`; its `production` job shares the group of
  `deploy-production` and of a production `apply-migrations`.
- A run waiting at the production approval holds its workflow group (observed
  on `deploy-production` runs 30772571138 and 30786409061, 2026-08-03). So a
  release left waiting blocks the next release, and a production
  `apply-migrations` left unapproved blocks `deploy-production`, an emergency
  rollback included, until it is approved or cancelled.
- By default a group holds one running and one pending run; a third dispatch
  cancels the pending one. A cancelled pending run has started no step.
- **NOT serialized** against any of the above: `seed-reference-data`,
  `approve-library-baseline`, `cleanup-membership-orphans`,
  `import-shadow-research`, `move-policy-shelf`, `repair-research-baseline`,
  `rescope-library-baseline`, `retention-cleanup` (which also runs on a
  schedule), `backup`, `check-database`, `run-checks`. Do not run one against
  an environment while a release of it is in flight.

### Before the first use (overwatch; no production write)

1. **Re-read both environments** and record the result with the date:
   `staging` has no required reviewer and `production` has one. If `staging`
   has acquired a reviewer, this is no longer one click; stop and revisit.
   ```text
   gh api repos/PunxsyProminence/ppbf-platform/environments --jq '.environments[] | {name, rules: [.protection_rules[]?.type]}'
   ```
2. **Prove a second run cannot start staging.** Dispatch run A and let it
   finish `staging` and wait at the approval. Dispatch run B. B must stay
   pending with no job started. Reject or cancel A; B must then start, or be
   cancelled by hand. Run A reaches no production step: rejecting the approval
   ends it before the `production` job's first step.
3. **Settle what a waiting JOB holds.** Not known: whether the `production`
   job, while it waits for approval, already holds the `deploy-production`
   group (the observation above is for a workflow-level group). With run A
   waiting, dispatch `apply-migrations` with `target: production`,
   `confirm_target: production`, `migration: list-check` (it touches no
   database). Note whether it is pending behind A or itself waiting for
   approval, then cancel it. Record the answer here.
4. Record all three with the run ids in this section, replacing "It has never
   been run".

## Verify production

After the workflow completes, read back the live environment rather than relying only on a green badge:

- `PPBF_RELEASE_SHA`
- running image digest
- active revision
- traffic assignment
- login empty-payload probe (`400`)
- session probe (`200`)
- unauthenticated SHADOW probe (`401`)
- release-specific acceptance probes

The three smoke probes are unauthenticated and would pass against the previous
image too. What ties the new image to the serving revision is the
revision-digest assertion inside the deploy workflow's wait step, so read that
step, not only the smoke results.

Only then report `PRODUCTION_RUNTIME_VERIFIED`.

## Failure and rollback

A release operator does not repair product code as part of the release.

- Before deployment: stop at the failed gate and return the exact run, step, input, and evidence.
- After deployment: read the actual running SHA/digest, preserve failure evidence, and prepare either a retry or rollback packet.
- A rollback requires Jason's explicit authorization and a known prior SHA/digest. Dispatch with `allow_rollback: YES` only when the rollback is deliberate.

## Production-state records

Live Azure state and current GitHub workflow evidence outrank `docs/current/PRODUCTION_STATE.json`. That JSON file is an audit snapshot, not a controller and not bot-owned. It was last updated 2026-08-28 and did not record the September releases (checked 2026-09-21).

Any authorized release verifier may propose an update only after directly observing the relevant environment. Use `null` or `not_verified` when live evidence is unavailable. Historical references to a named gatekeeper or VS Code Claude session describe an old operating model and grant no current authority.

## Minimal release path

```text
Jason requests preparation
→ a Claude session validates and stages the exact SHA
→ AI returns RELEASE READY packet
→ Jason authorizes promotion
→ workflow queues protected production deployment
→ Jason approves GitHub environment
→ workflow deploys and probes
→ that session reads back live state
```
