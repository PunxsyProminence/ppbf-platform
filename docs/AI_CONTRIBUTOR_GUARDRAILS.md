# AI Contributor Guardrails

Conditional safety rules for AI work in this repository. `AGENT_KERNEL.md` is the default execution contract; load this file only when the touched surface makes these rules relevant.

The platform serves youth athletes. Preserve the hard boundaries below, but do not turn incident history into extra approval ceremony.

## 1. Claims require evidence

- `Fixed`, `works`, `broken`, `deployed`, and `verified` require an executable test, reproduction, measurement, workflow result, or live observation.
- Code reading is not runtime proof. Mark unexecuted behavioral claims `UNVERIFIED` and name the confirming check.
- Use the smallest relevant test while iterating. Let the change-aware CI workflow run the required final repository gates.
- New user-facing SHADOW behavior should extend the applicable staging gate or explicitly state why a deterministic gate is not possible.

## 2. Current source, bounded scope, and collisions

- Start from current `main` and inspect live open PRs before editing.
- Use one bounded concern per branch/PR.
- A ticket is optional unless coordination, handoff, scheduling, or a durable decision record adds value.
- Do not duplicate an implementation already on `main` or in an open PR.
- Sequence overlapping work on contested surfaces instead of letting multiple AIs silently edit the same contract.

Contested surfaces include:

- `.github/workflows/*`
- `apps/web/src/server/pilot/shadowChat.ts`
- `apps/web/src/server/pilot/shadowRouter.ts`
- `apps/web/scripts/pilot-shadow-intake-gate.mjs`
- `apps/web/scripts/pilot-provision-gate-fixtures.mjs`
- `infra/azure/*.sql`

## 3. Hard safety invariants

- **SHADOW response validation:** changes must preserve both must-filter and must-pass cases. Do not delete a safety case merely to make output pass.
- **No invented authority:** no diagnosis, prescription, medical clearance, fabricated numbers, fabricated citations, or autonomous policy decisions.
- **Authentication:** athlete PIN sessions remain athlete-only. Privileged accounts use the approved privileged authentication path; do not create convenience backdoors for tests.
- **Organization isolation:** every organization-owned read/write must remain scoped to the correct `organization_id` and actor authority.
- **Safeguarding/minors:** do not weaken consent, review, quarantine, disclosure, retention, or human-decision boundaries to remove friction.
- **Visible fixtures:** gates must not silently invent state. Provisioning belongs in explicit setup steps or the real APIs under test.
- **Fail closed:** SHA, schema, authorization, evidence, and fixture guards are controls. Correct the input or implementation; do not bypass the guard.

## 4. Current SHADOW integration facts

These are measured operating constraints, not general model folklore:

- GPT-5-family reasoning deployments reject non-default `temperature`; omit it for reasoning models.
- Reasoning tokens count against `max_completion_tokens`; too-small budgets can return `finish_reason: length` with empty content.
- Provider timeout must remain compatible with measured latency and the Container Apps ingress ceiling. The current deployment baseline is 120 seconds; do not reduce it without measurement.
- The response filter withholds unsupported percentages, `research/data shows`, and `proven` claims unless verified evidence is present.
- The background SHADOW worker is controlled by deployment configuration. A disabled worker is not automatically an application defect.
- Interactive Heavy Bag behavior is synchronous unless the current implementation and acceptance criteria explicitly say otherwise.

## 5. Database and schema rules

- Migrations are additive, idempotent, and applied through `.github/workflows/apply-migrations.yml`, staging first.
- No HTTP route changes the schema. Schema ownership remains in migration files and approved runners.
- PostgreSQL has no general `ADD CONSTRAINT IF NOT EXISTS`; use the existing catalog-guarded migration pattern.
- Migration runners execute parse-first transactions. A syntax error means the transaction does not partially apply.
- A migration file is not sufficient by itself; confirm an existing runner actually includes it.
- Local `.env.local` may target production. Any direct database access must first identify the target and remain read-only unless Jason explicitly authorizes the exact write.
- Do not put production connection strings on a laptop or into chat when a workflow already performs the operation safely.
- Match existing insert patterns and actual schema defaults rather than assuming timestamps or identifiers are generated automatically.

## 6. Release and environment rules

There is no standing production bot, deploy coordinator, gatekeeper model, or model-specific release owner.

- Jason retains final production approval authority.
- Any current repo-capable AI/session may temporarily prepare or operate a release only after Jason explicitly requests release work.
- Preparing a release does not authorize final production promotion.
- No AI may approve the protected GitHub `production` environment, invent `migrations_complete=CONFIRMED`, authorize a rollback, or weaken a failed deployment guard.
- Use `docs/AI_DELIVERY_PIPELINE.md` for the exact temporary release procedure.
- The production SHA and staging-tested image digest must describe the same artifact.
- If `main` moves after staging, re-validate instead of pairing a stale digest with a newer SHA.
- Production migrations precede application code that depends on them.
- `--set-env-vars` cannot unset existing variables; workflows must state required values explicitly.
- New environment-controlled capabilities default off until staging evidence supports enabling them.
- Wait for the new revision to serve traffic before running deployed-behavior probes.
- Live Azure state and current workflow evidence outrank deployment prose or snapshots.

## 7. AI capability is task-scoped, not model-scoped

- A repo-capable AI may build, review, audit, integrate, or prepare a release when the current request authorizes that task and the hard boundaries above are preserved.
- No model family is permanently restricted to `builder`, `auditor`, or `gatekeeper` status.
- Independent review is useful for auth, organization isolation, minors/safeguarding, destructive data, schema, SHADOW safety, and production work; executable evidence outranks model agreement.
- An audit finding is a lead until verified. It should include file/location evidence and a falsifiable confirming check.
- Chat-only AI output is a candidate patch. A repo-capable AI/session must reconcile it with current source and execute the relevant checks before merge.

## 8. Scope and failure handling

- Do not drive-by fix unrelated work.
- When a requested change conflicts with a hard safety boundary, stop that part and report the exact conflict; deliver safe independent work when possible.
- A failed release is not a feature-development lane. Preserve the run evidence, return the failure to normal development, and retry only after the underlying issue is corrected.
- Use `null`, `not_verified`, or `UNVERIFIED` instead of filling evidence gaps with inference.
