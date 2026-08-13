# Release Procedure

This file governs staging and production release work only. Ordinary building follows `AGENT_KERNEL.md` and `docs/AI_COLLABORATION.md`.

## No standing production bot

There is no permanent production bot, deploy coordinator, gatekeeper model, or model-specific release owner.

- Jason is the sole human production approval authority.
- Any current repo-capable AI/session may temporarily prepare or operate one release after Jason explicitly requests that release work.
- That authority is task-scoped and ends when the release is completed, stopped, or handed back.
- No AI may approve the protected GitHub `production` environment, invent a migration attestation, authorize a rollback, weaken a failed gate, or claim live verification from source reading.

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
3. Diff the candidate against the SHA currently observed in production. Determine whether the range includes schema, migration-runner, environment-variable, auth, organization-isolation, safeguarding, or SHADOW safety changes.
4. Apply required staging migrations through `.github/workflows/apply-migrations.yml`. Never apply them from a laptop or ad hoc AI shell.
5. Dispatch `.github/workflows/deploy-staging.yml` for the exact SHA and the applicable gates.
6. Capture the immutable `sha256:` image digest produced by staging.
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
2. Dispatch `.github/workflows/deploy-production.yml` from `main` using:

```text
confirm_sha: <exact prepared SHA>
release_digest: <exact staging-tested digest>
migrations_complete: CONFIRMED
allow_rollback: NO
```

3. GitHub must halt at the protected `production` environment for Jason's approval. No AI approves that checkpoint.
4. The workflow must verify the production schema, digest availability, rollback direction, deployment, and smoke checks.

The SHA and digest must describe the same staged artifact. If `main` moves after staging, re-validate the release rather than pairing an old digest with a new SHA.

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

Only then report `PRODUCTION_RUNTIME_VERIFIED`.

## Failure and rollback

A release operator does not repair product code inside the release lane.

- Before deployment: stop at the failed gate and return the exact run, step, input, and evidence.
- After deployment: read the actual running SHA/digest, preserve failure evidence, and prepare either a retry or rollback packet.
- A rollback requires Jason's explicit authorization and a known prior SHA/digest. Dispatch with `allow_rollback: YES` only when the rollback is deliberate.

## Production-state records

Live Azure state and current GitHub workflow evidence outrank `docs/current/PRODUCTION_STATE.json`. That JSON file is an audit snapshot, not a controller and not bot-owned.

Any authorized release verifier may propose an update only after directly observing the relevant environment. Use `null` or `not_verified` when live evidence is unavailable. Historical references to a named gatekeeper or VS Code Claude session describe an old operating model and grant no current authority.

## Minimal release path

```text
Jason requests preparation
→ current AI/session validates and stages exact SHA
→ AI returns RELEASE READY packet
→ Jason authorizes promotion
→ workflow queues protected production deployment
→ Jason approves GitHub environment
→ workflow deploys and probes
→ current AI/session reads back live state
```
