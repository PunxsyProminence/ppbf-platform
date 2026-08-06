# AI Delivery Pipeline

How missing capabilities get built by any AI and shipped to production through
one verified path. This is the operating manual for the flow. Three documents
work together and none of them stand alone:

- **This file** — roles, lanes, the gate a builder's work passes through.
- [docs/current/WORK_QUEUE.md](current/WORK_QUEUE.md) — the one current
  queue, its state machine, and the collision rules.
- [docs/current/PRODUCTION_STATE.json](current/PRODUCTION_STATE.json) — what
  is actually deployed and runtime-verified, right now, written only by the
  gatekeeper after observing the live environment.

Rules of conduct live in
[AI_CONTRIBUTOR_GUARDRAILS.md](AI_CONTRIBUTOR_GUARDRAILS.md) and still bind
every participant. The role decomposition this extends is
[MULTI_AI_EXECUTION_PLAN.md](MULTI_AI_EXECUTION_PLAN.md).

The platform serves youth athletes. Every shortcut in this pipeline was
removed on purpose.

## The central rule

**Implemented, merged, deployed, and runtime-verified are four different
claims.** This repo has shipped code that was merged, green in CI, and had
never worked once (guardrails §1) — CI proves compilation and unit behavior,
not that the product works. So "done" means production-deployed AND
production-verified, unless a ticket explicitly defines a documentation-only
completion rule. A ticket does not advance a state because code exists on a
branch; it advances because the gatekeeper observed it working at that state.
See the state machine in [docs/current/WORK_QUEUE.md](current/WORK_QUEUE.md).

## The shape

```
 Owner picks a ticket        Builder AI implements         Gatekeeper verifies
 from intake/tickets/   →    it in one of two lanes   →    merges, stages,      →  production
 and hands it to an AI                                     promotes
```

Three roles:

| Role | Who | Holds |
|---|---|---|
| **Owner** | Jason | Ticket selection, production approval clicks, all final calls |
| **Builder** | Any AI (Claude, ChatGPT, Grok, Copilot, …) | The ticket it was handed, nothing else |
| **Gatekeeper** | The VS Code Claude session | `gh`, `az`, the local test environment, and the only path to merge/deploy |

Builders never deploy, never merge, never touch the database. The gatekeeper
never expands a ticket's scope. The owner never has to read a diff to know
whether something is safe — that is what the verification ledger is for.

## Lane A — git-capable builders (Claude Code web, Copilot agents)

1. Read the ticket file, [AI_CONTRIBUTOR_GUARDRAILS.md](AI_CONTRIBUTOR_GUARDRAILS.md),
   and the file map in the ticket.
2. Branch from current `origin/main`, named `ticket/<id>-<slug>`.
3. Build exactly the ticket. Run locally before pushing:
   `npm ci && npm run typecheck && npm run lint && npm test`.
4. **Push once, then open a draft PR immediately** using the PR template.
   A repository ruleset blocks updating a branch after it is pushed —
   there are no fixup pushes. If you must revise, open a new branch
   `ticket/<id>-<slug>-v2` and a new PR, and close the old one yourself.
5. Fill the Evidence section of the template. Claims without evidence are
   returned unread (guardrails §1).
6. Stop. Do not merge, do not dispatch workflows, do not "helpfully" fix
   adjacent code.

## Lane B — chat-only builders (ChatGPT, Grok, anything in a browser tab)

For AIs that cannot run git. The **drop zone** is `intake/drops/`.

1. The owner pastes the ticket file into the AI as its prompt.
2. The AI produces complete files (never fragments or "…rest unchanged"),
   plus a `MANIFEST.md` listing: ticket id, every file with its full repo
   path and whether it is new or replaces an existing file, what was NOT
   done, and any assumption made.
3. The owner saves the output under `intake/drops/<ticket-id>/`, mirroring
   repo paths (e.g. `intake/drops/T-014/apps/web/app/store/page.tsx`), and
   tells the gatekeeper "drop T-014 is in".
4. The gatekeeper integrates: applies the files on a fresh branch, reconciles
   them with current `main`, runs the full gate, authors the PR, and credits
   the builder in the PR body. Integration problems go back to the owner as
   ticket feedback, not silent rewrites.

`intake/drops/` is gitignored — half-finished drops never reach a commit; the
only way out of the drop zone is through the gatekeeper's verification.

## What the gatekeeper runs on every intake (both lanes)

In order, stopping at the first failure:

1. **Freshness** — branch/drop reconciled against current `origin/main`
   (this repo merges fast; stale bases are the #1 conflict source).
2. **Scope check** — diff touches only the ticket's allowed files. Contested
   files (guardrails §3) touched without the ticket saying so → returned.
3. **Static gate** — `npm run typecheck` (both projects), `npm run lint`.
4. **Test gate** — `npm test` (3,600+), plus `npm run test:migrations` when
   the diff includes SQL or `src/server/pilot/` persistence code.
5. **Build gate** — `npm run build`.
6. **Adversarial review** — the gatekeeper attempts to refute the PR's
   claims, not confirm them: run the changed surface, probe the failure
   paths, check authorization scoping on every new query
   (`organization_id` on every organization-owned read/write — see the
   convention test), check the response validator lists if SHADOW phrasing
   changed.
7. **Safety invariants** — guardrails §4 checklist; any weakening is an
   automatic return regardless of what else passes.
8. **Merge** — squash, PR number in title (house style), only after CI
   `validate` is green in GitHub too.
9. **Stage** — dispatch `deploy-staging` with the exact SHA; capture the
   image digest; run the smoke set (login 400 / session 200 / shadow 401)
   plus whatever probe the ticket's acceptance criteria name. New
   user-facing behavior extends the SHADOW E2E gate or states why not
   (guardrails §1).
10. **Promote** — dispatch `deploy-production` with that SHA + digest.
    The GitHub `production` environment rule halts it for the owner's
    approval — that click is the owner's checkpoint, by design.
11. **Verify live** — read the container app's `PPBF_RELEASE_SHA` and image
    digest back and confirm they match what was staged; run the smoke set
    against production.
12. **Close the ticket** — move its file to `intake/tickets/done/` with a
    Shipped section: PR number, production SHA, digest, verification
    evidence.

Every intake gets a verification ledger comment on its PR: what was run,
what passed, what was returned and why. "Green" is never asserted without
the command output to show for it.

## Ticket files

Tickets live in `intake/tickets/`, one file each, named
`T-<nnn>-<slug>.md`, written from the gap register by the gatekeeper and
approved by the owner before any builder sees them. The format is the
Standard Ticket Contract from
[MULTI_AI_EXECUTION_PLAN.md](MULTI_AI_EXECUTION_PLAN.md) plus an embedded
context block, so a ticket can be pasted into any AI as a complete,
self-sufficient prompt. See `intake/tickets/T-000-template.md`.

Rules:

- One ticket, one concern, one PR. Tickets sized to land inside a single
  builder session (roughly ≤ 500 changed lines).
- `Files allowed` is a hard boundary, not a suggestion.
- Acceptance criteria are executable: a command, a probe, a test name —
  never "works correctly".
- Two builders never hold tickets whose allowed files overlap (collision
  rule from the work queue, still in force).

## Sequencing

The locked build order from MULTI_AI_EXECUTION_PLAN still governs priority:
authority → athlete domain → audit → intake → telemetry → analytics →
everything else. Within a band, tickets are independent by construction
(disjoint file sets), so any number of builders can run in parallel.

## What can go wrong, and who catches it

| Failure | Caught by |
|---|---|
| Builder claims done, never ran it | Evidence section empty → returned at step 0 |
| Stale base, silent conflict | Freshness (step 1) |
| Scope creep into contested files | Scope check (step 2) |
| Compiles, fails in reality | Adversarial review (step 6), staging smoke (step 9) |
| Cross-org data leak | Authorization sweep in step 6 + convention test |
| Weakened safety validator | Invariant checklist (step 7) |
| Wrong image promoted | Digest/SHA match verification (step 11) |
| Two AIs on one file | Ticket allowed-files disjointness + draft-PR visibility |

The pipeline assumes every builder is competent and none are trusted. That
is not cynicism; it is how the gate earns the owner a one-click deploy.
