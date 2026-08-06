# T-000 — <title: one capability, one concern>

> Status: OPEN | CLAIMED (<builder, date>) | SHIPPED (see done/)
> Lane: A (git-capable AI) or B (chat-only AI) — either unless stated
> Priority: P0 safety / P1 pilot-blocking / P2 operator / P3 polish

<!-- Everything below this line is the prompt. Paste the whole file into the
     builder AI. It must be able to succeed with no other context. -->

## Context you need

You are building one feature for the PPBF platform: a Next.js 16 (App
Router) + PostgreSQL app for a nonprofit youth boxing gym, deployed on Azure
Container Apps. TypeScript strict, Tailwind v4, tests in Jest
(`*.test.ts(x)` colocated), server logic under `apps/web/src/server/pilot/`,
API routes under `apps/web/app/api/pilot/`, pages under `apps/web/app/`.

Non-negotiable conventions:

- Every read/write of organization-owned data is scoped by
  `organization_id` in the SQL itself. A convention test fails PRs that
  join without it.
- Auth: `requireSession` / role checks from `src/server/pilot/auth.ts` at
  the top of every route handler. PIN sessions are athlete-only.
- Design system: use classes from `design-system/ppbf.css` (`.btn`,
  `.badge--filed`, `.frame`, `.stat`, `t-*` type classes, `--s*` spacing
  vars). No new hex values, no new fonts, no inline style constants.
- Migrations: additive, idempotent, `IF NOT EXISTS` throughout, one file
  under `infra/azure/`, plus a runner script and a `pilot:apply-*` entry
  in `apps/web/package.json` (copy an existing migration's shape).
- SHADOW content rules: no diagnosis, no prescription, no invented numbers
  or citations (a response filter enforces this — do not fight it).
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.

## Goal

<!-- What exists when this is done, in one paragraph, user-visible terms. -->

## In scope

<!-- Bullet list. Concrete. -->

## Out of scope

<!-- What an eager builder would add that you must not. Name the adjacent
     features explicitly. -->

## Files allowed

<!-- Hard boundary. New files: name them. Existing files: exact paths.
     Touching anything else returns the PR. -->

## Acceptance criteria (all executable)

<!-- Each one is a command, a probe, or a named test — never "works".
Examples:
- `npm test -- --runTestsByPath apps/web/app/api/pilot/<x>/route.test.ts` passes, including the new cases: <list them>
- `curl -X POST /api/pilot/<x>` without a session returns 401
- With a coach session, GET /<page> renders the list; with an athlete session it returns the role gate
-->

## Required tests

<!-- Which test files must exist/extend, and the specific behaviors they pin,
     including at least one failure-path case per new route. -->

## Delivery

Lane A: branch `ticket/T-000-<slug>` off current `origin/main`, run
`npm ci && npm run typecheck && npm run lint && npm test`, push ONCE, open a
draft PR with the repo's PR template, fill Evidence with real command
output. You cannot push to a branch twice — revisions are a new `-v2`
branch and PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full
repo path, plus a MANIFEST.md: ticket id, file list (new vs replaces), what
was not done, assumptions made. The human will place your output in
`intake/drops/T-000/`.
