# AI Contributor Guardrails

Rules for ANY AI (Claude, ChatGPT, Grok, or other) doing work in this
repository. These are not style preferences — every rule below exists because
violating it broke something real, usually silently. If a rule seems to block
your task, say so in your PR description and stop; do not work around it.

The platform serves **youth athletes**. Mistakes here are not abstract.

---

## 1. The prime rule: merged is not working

This repo has carried features that were merged, green in CI, and had **never
worked once**: a chat tier whose every request failed on two independent
defects, a background job system that 400'd on every call, a migration that
was never parseable, an approval flow that requires a state nothing can
produce. CI proves compilation and unit behavior; it does not prove the
product works.

Therefore:

- **Claims require evidence.** "Fixed", "works", "broken" must cite a test, a
  reproduction, or a measurement. If you cannot execute code, label every
  such claim `UNVERIFIED — needs CI/gate confirmation`.
- **Never assert model/API behavior from reading code.** Reasoning-model
  latency, token spend, parameter support, and filter behavior were all
  discovered by measurement, and several confident code-reading theories died
  on contact with evidence.
- The end-to-end proof is the **SHADOW E2E gate** (`deploy-staging` dispatch
  with `enable_shadow_gate=true`). New user-facing behavior should add or
  extend a gate step, or state explicitly why it cannot be gated.

## 2. Branch and PR discipline

- Never commit to `main`. One branch, one PR, one concern.
- **Open your PR as a draft immediately** — drafts are how parallel sessions
  see each other's intent. Check `gh pr list` (or the PR page) for open work
  touching your files BEFORE you start.
- Squash-merge only, PR number in the title line (house style).
- CI (`validate`) must be green. Full suite (`npm test` from repo root, 1200+
  tests) and `npx tsc --noEmit -p apps/web` before pushing.
- Do not modify files owned by another open PR. If you must, say so and
  sequence with its author.

## 3. Contested files — sequence, never parallelize

Three parties edited these in one night and paid for it in conflicts and
races. Touching them requires checking open PRs first and saying so in your
own PR:

- `.github/workflows/*` (deploy-staging, deploy-production, apply-migrations)
- `apps/web/src/server/pilot/shadowChat.ts` (validator + system prompt)
- `apps/web/src/server/pilot/shadowRouter.ts` (model registry, timeouts)
- `apps/web/scripts/pilot-shadow-intake-gate.mjs` and
  `pilot-provision-gate-fixtures.mjs`
- `infra/azure/*.sql`

## 4. Safety invariants — never weaken, only extend

- **Response validator** (`shadowChat.ts`): its true-positive cases are
  pinned by tests in BOTH directions (things that must filter, things that
  must pass). Any change must extend both lists. Never delete a
  must-still-filter case to make something pass.
- **Doctrine**: no diagnosis, no prescription, no clearance, no invented
  numbers or citations. The system prompt's PHRASING section exists because
  the filter enforces it — do not put phrasing in the prompt that the
  validator forbids (this happened; it muted the product).
- **Auth boundaries**: PIN sessions are athlete-only, by design; privileged
  local sessions are revoked on first use. Privileged accounts are
  Microsoft-authenticated. Do not add non-interactive privileged auth
  endpoints for testing convenience — the gate mints sessions via the DB on
  CI runners instead, deliberately.
- **The gate provisions nothing** (`gate-session.mjs` stance): fixtures are
  created only by the explicit, visible provisioning step or by the real
  APIs under test. Never make a gate silently invent state to pass.
- **Fail closed.** Guards that refuse (SHA mismatch, migration attestation,
  fixture-missing errors) are features. Fix the input, never the guard.

## 5. Known landmines (do not "fix" casually)

- **CLOSED (2026-07-30) — intake approval was unreachable for months**:
  documents are born `pending_security_review`, and until the
  document-review feature existed nothing could produce the scanned+ready
  state approval requires. The closure is the audited human review pair
  (`/api/pilot/intake/document-review` + `document-link`) this landmine
  always prescribed. Two things must stay true: approval on unreviewed
  documents must still refuse (the gate asserts the refusal BEFORE
  reviewing — never remove that), and review must stay a human attestation
  with an audit row, not an auto-pass.
- **SHADOW job worker is dormant by design**: it starts only when
  `PPBF_SHADOW_WORKER_ENABLED=true` is set in a deploy workflow. Queued
  scout reports/board summaries not processing is configuration, not a bug.
- **Interactive Heavy Bag is synchronous on purpose** (~90s wait); the gate
  asserts it. `preferAsync` affects background flows only.

## 6. Model-integration facts (all measured, all cost real debugging)

- gpt-5-family reasoning deployments **reject any non-default `temperature`**
  (HTTP 400, instantly). Omit the parameter (`isReasoningModel` flag in the
  router registry).
- Reasoning tokens count against `max_completion_tokens`. Budgets under
  ~4096 can yield `finish_reason: length` with EMPTY content.
- Real latency on our prompts: 33–95s depending on deployment. Never set a
  provider timeout under 120s; never over 230s (Container Apps ingress cuts
  requests at 240s). Timeouts are per-model in the router registry.
- The response filter withholds uncited percentages, "research/data shows",
  and "proven". Answers must explain via mechanics and coaching experience
  unless a verified evidence id is supplied in context.

## 7. Database rules

- **Migrations are additive and idempotent**, applied via the
  `apply-migrations` workflow (staging first, always). Never from a laptop.
- PostgreSQL has **no `ADD CONSTRAINT IF NOT EXISTS`** — use
  catalog-guarded DO blocks (pattern exists in
  `pilot_slice_postgres_multiorg_migration.sql`).
- Migration files execute as ONE parse-first transaction: a syntax error
  anywhere means NOTHING applies, ever. `node --check` is not a SQL check —
  the staging workflow run is the proof.
- Local `.env.local` points at **PRODUCTION**. Any local DB access must
  verify `current_database()` first and be read-only unless a human
  explicitly approved the specific write. Production writes are executed by
  the human, never by an AI.
- Tables may lack column defaults (`athletes.created_at`): match the insert
  patterns in `entities.ts`, don't assume `default now()`.

## 8. Deploy and environment rules

- **Only the deploy coordinator dispatches production workflows, and only
  because GitHub — not this document — enforces the human checkpoint.** The
  `production` environment carries a `required_reviewers` protection rule, so
  every production deploy and every production migration halts at `pending`
  until the owner approves it in GitHub. Dispatching queues the request; it
  cannot ship anything. Every other AI session dispatches nothing at all, in
  any environment. Changed 2026-07-30: the rule previously read "production
  dispatches are the human's", which predated that protection rule and made
  the owner retype inputs they were reading off the coordinator anyway —
  a copying step, not an independent check, and it produced its own errors.
- **The digest and the SHA must describe the same commit.** The production
  deploy takes only a digest that already passed the gate, and the guard
  independently re-checks `confirm_sha` against whatever `refs/heads/main`
  resolves to at dispatch time. So a digest goes stale the moment anything
  merges: validate, then dispatch immediately, or re-validate. Never pair a
  digest built from one commit with a `confirm_sha` naming another to satisfy
  the guard — that deploys an image the SHA does not describe.
- **`migrations_complete` is an attestation, not a check** — the workflow
  says so itself. Before typing CONFIRMED, diff `infra/` across the range
  being deployed. A migration file alone is not the whole story: confirm a
  runner actually applies it (the per-migration runners in
  `apps/web/scripts/` list their SQL files explicitly, and a new file may be
  added to an existing runner rather than getting its own workflow choice).
- **The deploy coordinator is the workspace (VS Code) Claude instance.**
  Handed off 2026-07-30 by the remote session that held the role before it.
  Every other AI session — the remote work-and-merge session included — does
  not dispatch deploy or migration workflows at all, staging included. It
  builds, tests, and merges, then hands the coordinator the exact dispatch
  inputs: expected SHA, a truthful `schema_migrations_complete` attestation,
  and the gate flag, in the PR body or a handoff issue.
- `--set-env-vars` cannot UNSET a variable already on an app — state every
  variable explicitly in the workflow.
- New features needing env vars must default OFF and be enabled per
  environment in the deploy workflow, with a comment saying why.
- `az containerapp update` returns before the new revision serves traffic —
  anything that tests the deployed app must wait for the revision-readiness
  step (already in deploy-staging).

## 9. Scope discipline

- Implement the brief. Nothing adjacent, however tempting. If you find an
  unrelated bug: file/report it (issue or PR description), don't drive-by
  fix it — especially in contested files.
- If the brief conflicts with anything in this document, STOP and report
  the conflict instead of choosing silently.
- Silent scope-narrowing is worse than asking: if part of a brief is
  blocked, deliver the rest and state plainly what you left out and why.

## 10. For AIs without repo/shell execution (chat-only sessions)

Your patches are applied and run by others, so:

- Produce complete files or exact unified diffs — never "add something like
  this" sketches.
- Include the tests that prove your change, in the same patch.
- Mark every behavioral claim `UNVERIFIED` — CI and the gate are the
  arbiters, not your reasoning.
- Restate which guardrail sections your change touches so the human can
  route it (e.g. "touches §4 validator — extends both test lists").

## 11. Division of labor: who builds, who audits

Two roles, and an AI is in exactly one of them for a given piece of work.

**Builders — Claude sessions with repository and shell execution.**
All application, infrastructure, migration, and design code is written by
these. A builder must *prove* its work: run the suite, run the affected
tests, measure the behavior it claims, and say in the PR what it executed.
"It should now work" is not a deliverable; §1 applies with full force.

**Auditors — other model families (Grok, ChatGPT, and any future model),
audit-only.** They read the repository and report findings. They do NOT
open PRs, write fixes, change files, or dispatch workflows. Their findings
go to the deploy coordinator, who verifies each one — by measurement where
possible — before any of it becomes an execution brief for a builder.

**Why this split, from measured experience (2026-07-30, seven audit
reports across three model families):**

- Outsider auditors without execution read code *as written* rather than
  trusting a green suite. The single highest-value finding of that day —
  four competing schema-ownership paths, and a volunteers feature that had
  never once worked in production — came from a model that could not run
  anything and therefore had nothing to be lulled by.
- Model diversity in audit is real: each family found defects the others
  missed. Run the same lens across several, and treat agreement between
  them as a confidence signal, not as a vote.
- Fabricated evidence is the observed failure mode of a confident auditor:
  one report cited a test that does not exist and a role permission that
  the code refuses. That is survivable in an auditor whose output is
  verified before use, and *not* survivable in a builder whose output is
  merged. Hence the asymmetry.

**Rules that follow:**

1. An audit finding is a **lead, not a fact**, until the coordinator
   verifies it. Verify by execution or live query where the claim allows;
   say plainly which findings could not be verified and why.
2. Findings must carry file:line, evidence (or an explicit `UNVERIFIED`
   plus the exact confirming check), and a suggested acceptance criterion.
   Findings without a falsifiable claim are not actionable.
3. Auditors are told what is already known, so they spend their pass on new
   ground rather than re-reporting the KNOWN GAP and other tracked items.
4. Builders work from briefs, not from raw audit reports. A brief states
   verified facts, exclusive file territory, tasks, and acceptance criteria
   — so parallel builders cannot collide (§3) and nobody re-derives what
   was already measured.
5. When an audit claim and the code disagree, the code wins and the brief
   says so explicitly, including "do not fix X — X is not real", so a
   builder does not go chasing a phantom.
