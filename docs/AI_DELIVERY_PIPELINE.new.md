# AI Delivery Pipeline

This document applies when AI-authored work moves through GitHub or toward a deployed environment. Ordinary implementation starts with `AGENT_KERNEL.md` and `docs/current/ACTIVE_WORK.md`; do not load this file unless the task involves PR integration, staging, production, migrations, or runtime verification.

## Operating model

- One human owner has final product and production authority.
- Multiple AI agents may build, review, audit, or integrate work.
- Current `main`, current source, and live GitHub PRs are the coordination truth.
- A ticket is optional. Use one when coordination, handoff, scheduling, or a durable decision record adds value.
- A PR is the normal handoff object for git-capable agents.

## Multi-AI collision control

Before editing, an agent checks current `main`, `docs/current/ACTIVE_WORK.md`, and open PRs for the touched files or contract.

1. One concern per branch/PR.
2. Do not create a second implementation of work already present on `main` or in an open PR.
3. If two AIs need the same files or shared contract, sequence them or explicitly reconcile the overlap; do not merge around conflicts.
4. Draft PRs are useful early visibility for concurrent AI work, not an approval ceremony.
5. Stale branches are re-derived or closed rather than repeatedly patched forward when `main` has materially moved.

No standing Builder/Gatekeeper identity is required. An AI may build one change and review another. For high-risk changes, independent review by another AI is useful, but repository evidence and executable checks outrank model agreement.

## Build path

For a normal code change:

`request -> inspect current source/open PRs -> bounded branch -> implement -> targeted proof -> CI -> review if warranted -> merge`

During development, run the narrowest useful checks first. The repository CI decides the required changed-surface gates before merge. Do not repeatedly run expensive unrelated suites merely because they exist.

Claims still require evidence: a passing unit/integration test proves what it exercises; it does not prove deployment or live runtime behavior.

## Release path

Implemented, merged, deployed, and runtime-verified are different claims.

When a change is actually being released:

1. Verify the merge target is current and CI is green.
2. For schema/persistence changes, run the controlled migration path in staging first and verify the intended schema behavior.
3. Deploy the exact staged SHA/image through the existing deployment workflow.
4. Run the relevant runtime smoke/acceptance probe in staging.
5. Promote only the exact verified artifact.
6. Production remains protected by the GitHub environment approval checkpoint.
7. After production deploy, verify the live release SHA/image and the relevant smoke/acceptance behavior.

Documentation-only or non-deployed tooling work does not need deployment ceremony.

## Hard release boundaries

These are not optional efficiency tradeoffs:

- never bypass GitHub production environment protection;
- never claim `migrations_complete` without checking the actual migration/runner range;
- never pair a deployment SHA with an image built from another commit;
- never perform destructive production-data work without explicit human authorization for that operation;
- never weaken authorization, organization isolation, safeguarding, evidence validation, or fail-closed release guards to make a change pass.

Domain-specific rules live in `docs/AI_CONTRIBUTOR_GUARDRAILS.md` and should be loaded only when the touched surface requires them.

## Agents without git execution

An AI that cannot inspect or modify the repository directly may still propose complete files, patches, tests, or review findings. Its behavioral claims remain `UNVERIFIED` until a repo-capable agent applies the change to current source and runs the relevant proof.

Do not create a separate process lane or permanent model-family restriction for this. Capability determines what evidence an agent can produce; GitHub and executable checks determine what lands.

## Historical records

`docs/current/WORK_QUEUE.md` preserves the old detailed state machine, deployment evidence, collision notes, and shipped history. It is an audit/provenance ledger, not the everyday build workflow.
