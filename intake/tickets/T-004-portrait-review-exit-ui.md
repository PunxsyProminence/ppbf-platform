# T-004 — Portrait review exit UI (photos stuck pending forever)

> Status: OPEN
> Lane: A or B
> Priority: P2 operator / safeguarding-adjacent (minors' faces)

## Context you need

You are building one feature for the PPBF platform: a Next.js App Router +
PostgreSQL app for a nonprofit youth boxing gym. TypeScript strict, design
system from `design-system/ppbf.css`, tests colocated.

Non-negotiable: every org-owned read/write scoped by `organization_id` in SQL;
auth via `requirePrincipal` / role gates; no new dependencies without flagging;
full rules in `docs/AI_CONTRIBUTOR_GUARDRAILS.md`.

## Goal

Organization admins and coaches who may review a subject can see portraits
stuck in `pending_review` and **release** or **block** them through a UI that
calls the existing `POST /api/pilot/profile/photo/review` route. Photos no
longer sit invisible forever with only a hand-crafted HTTP POST as the exit.

## In scope

- Discover or add a **list** of org portraits with `photo_review_state =
  'pending_review'` and a non-null blob path (if no list route exists, add the
  minimal org-scoped GET under `apps/web/app/api/pilot/profile/photo/` — still
  `organization_id` in SQL).
- Page under `apps/web/app/admin/` (or coach surface if coaches must review
  their own athletes — match `photo/review/route.ts` role rules:
  org admin, or coach_of_subject / self).
- For each row: identity safe for the role, open/view path if one exists,
  **Release** and **Block** actions posting `{ account_id, decision }`.
- Colocated page tests with `@jest-environment jsdom`; mock fetch; no
  `@testing-library/jest-dom` unless already in package.json.

## Out of scope

- Do not change what release/block do in `profileDb` or blob delete behavior.
- Do not auto-approve with ML or skip human review.
- Do not touch gym wall public photos or publication pipeline (separate).
- Do not implement T-008 consent policy here.

## Files allowed

- `apps/web/app/admin/portrait-review/**` (or chosen admin path) — new
- Optional: `apps/web/app/api/pilot/profile/photo/pending/route.ts` (+ test) if
  no list exists
- Optional: one small helper in `apps/web/src/server/pilot/profileDb.ts` for
  the pending list query only

## Acceptance criteria (executable)

- `npm test -- --runTestsByPath <page.test.tsx>` passes, including release and
  block POST body assertions.
- Non-allowed role hits the same WrongRoleNotice / gate pattern as other admin
  consoles.
- List query includes `organization_id` in SQL (convention test still green).

## Delivery

Lane A: branch `ticket/T-004-portrait-review-exit-ui`, full gate, draft PR.
Lane B: complete files only + MANIFEST.md under `intake/drops/T-004/`.

## Evidence of the gap (audit)

- Write path sets `pending_review` on upload (`profile/photo/route.ts`).
- Exit API exists: `apps/web/app/api/pilot/profile/photo/review/route.ts`
  (release | block).
- No `.tsx` caller of `photo/review` found on main at ticket write time.
