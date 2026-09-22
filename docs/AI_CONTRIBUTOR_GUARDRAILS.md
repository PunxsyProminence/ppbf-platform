# AI Contributor Guardrails

Conditional safety rules for AI work in this repository. `AGENT_KERNEL.md` is the default execution contract; load this file only when the touched surface makes these rules relevant.

The platform serves youth athletes. Preserve the hard boundaries below, but do not turn incident history into extra approval ceremony.

## 1. Claims require evidence

- `Fixed`, `works`, `broken`, `deployed`, and `verified` require an executable test, reproduction, measurement, workflow result, or live observation.
- Code reading is not runtime proof. Mark unexecuted behavioral claims `UNVERIFIED` and name the confirming check.
- Use the smallest relevant test while iterating. Let the change-aware CI workflow run the required final repository gates.
- New user-facing SHADOW behavior should extend the applicable staging gate or explicitly state why a deterministic gate is not possible.
- Evidence must be **applicable** to the claim, not merely present and green. A run is evidence for the property and execution path it actually exercised and for nothing else. For a material claim, name the execution path the instrument ran and what the evidence does not establish: `docs/current/EVIDENCE_APPLICABILITY.md`.

## 2. Current source, bounded scope, and collisions

`AGENT_KERNEL.md`'s invariants 1-3 govern: start current, search before
creating, one bounded concern per PR. Sequence overlapping work on contested
surfaces instead of letting multiple AIs silently edit the same contract.

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
- **Authentication:** in staging and production, PIN sign-in admits only athletes. The one exception is BASE-03's offline local runtime (`pinLoginPermitted` in `apps/web/src/server/pilot/credentialPolicy.ts`): `NODE_ENV=development`, `PPBF_OFFLINE_RUNTIME=true` and a loopback database, for `organization_admin` and `coach` only, never a board-seat holder. Privileged accounts use the approved privileged authentication path; do not create convenience backdoors for tests.
- **Organization isolation:** every organization-owned read/write must remain scoped to the correct `organization_id` and actor authority.
- **Safeguarding/minors:** do not weaken consent, review, quarantine, disclosure, retention, or human-decision boundaries to remove friction.
- **Visible fixtures:** gates must not silently invent state. Provisioning belongs in explicit setup steps or the real APIs under test.
- **Fail closed:** SHA, schema, authorization, evidence, and fixture guards are controls. Correct the input or implementation; do not bypass the guard.

## 4. Current SHADOW integration facts

These are measured operating constraints, not general model folklore:

- GPT-5-family reasoning deployments reject non-default `temperature`; omit it for reasoning models.
- Reasoning tokens count against `max_completion_tokens`; too-small budgets can return `finish_reason: length` with empty content.
- Provider timeouts are per model (`timeoutMs` in `apps/web/src/server/pilot/shadowRouter.ts`): 90 to 210 seconds (values checked 2026-09-21), set at roughly twice the latencies measured on 2026-07-29, and all under the 240-second Container Apps ingress limit. Do not reduce one without measurement.
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

Who may release, and the procedure, are in `docs/AI_DELIVERY_PIPELINE.md` (OD-2026-08-29-006: staging is a build lane's; production needs Jason's word; no AI approves the protected `production` environment or invents `migrations_complete=CONFIRMED`). Rules kept only here:

- Production migrations precede application code that depends on them.
- `--set-env-vars` cannot unset existing variables; workflows must state required values explicitly.
- New environment-controlled capabilities default off until staging evidence supports enabling them.
- Wait for the new revision to serve traffic before running deployed-behavior probes.
- Live Azure state and current workflow evidence outrank deployment prose or snapshots.

## 7. Lanes are fixed across AI products; tasks vary within Claude lanes

- Across AI products the lanes are fixed (OD-2026-09-21-001; `AGENT_KERNEL.md`, Working channel): ChatGPT designs, enforces standards and researches, and is read-only here; Grok owns visual work; Codex has no lane.
- Among Claude lanes, a session may build, review, audit, integrate, or prepare a release when the current request authorizes that task and the hard boundaries above are preserved.
- Independent review is useful for auth, organization isolation, minors/safeguarding, destructive data, schema, SHADOW safety, and production work; executable evidence outranks model agreement.
- An audit finding is a lead until verified. It should include file/location evidence and a falsifiable confirming check.
- Chat-only AI output is a candidate patch. A repo-capable AI/session must reconcile it with current source and execute the relevant checks before merge.

## 8. Scope and failure handling

- When a requested change conflicts with a hard safety boundary, stop that part and report the exact conflict; deliver safe independent work when possible.
- A failed release returns to normal development (`docs/AI_DELIVERY_PIPELINE.md`, Failure and rollback).
- Use `null`, `not_verified`, or `UNVERIFIED` instead of filling evidence gaps with inference.
