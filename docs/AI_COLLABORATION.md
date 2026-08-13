# Multi-AI Collaboration

Use this only when more than one AI may touch nearby work.

## Model

- One human owner sets intent and retains final product/safety authority.
- Multiple AI agents may build, review, audit, or integrate.
- `main`, current source, and live GitHub PRs are coordination truth.
- Tickets are optional; use them when a durable handoff or decision record adds value.

## Collision control

Before editing, check current `main`, `docs/current/ACTIVE_WORK.md`, and open PRs for the touched files or shared contract.

1. One concern per branch/PR.
2. Do not duplicate work already on `main` or in an open PR.
3. If two agents need the same files or contract, sequence or explicitly reconcile the overlap.
4. Draft PRs are early visibility, not an approval ceremony.
5. Re-derive or close materially stale branches instead of repeatedly patching them forward.

No permanent Builder/Gatekeeper identity is required. An agent may build one change and review another. Independent review is useful for higher-risk work, but executable evidence outranks model agreement.

## Normal path

`request -> inspect current source/open PRs -> bounded branch -> implement -> targeted proof -> CI -> review if warranted -> merge`

Agents without repository execution may still provide complete patches, files, tests, or findings. Their behavioral claims remain `UNVERIFIED` until applied to current source and executed by a repo-capable agent.
