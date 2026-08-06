# T-001 — Admin console for issuing per-athlete activation codes

> Status: READY
> Lane: A (git-capable AI) or B (chat-only AI) — either
> Priority: P3 operator convenience

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
- Auth: `requireSession` / role checks from `apps/web/src/server/pilot/auth.ts` at
  the top of every route handler. PIN sessions are athlete-only.
- Design system: use classes from `design-system/ppbf.css` (`.btn`,
  `.badge--filed`, `.frame`, `.stat`, `t-*` type classes, `--s*` spacing
  vars). No new hex values, no new fonts, no inline style constants.
- Full rules: `docs/AI_CONTRIBUTOR_GUARDRAILS.md` in the repo. Read it.

## IMPORTANT — read this before touching anything related to athlete PINs

An earlier automated audit of this repository flagged the athlete
onboarding flow as a security bypass: "only add-athlete UI creates live
accounts on shared `123456` + guessable `ath-NNN`; full activation-code
system exists but no UI issues codes." **That framing is wrong, and this
ticket exists only because a narrower, real gap survived underneath it.**

What's actually true, verified against
`apps/web/src/server/pilot/pinPolicy.ts` and `auth.ts` directly:

- The shared starting PIN is a **deliberate, documented design**, not an
  oversight. Quote from `pinPolicy.ts`: "This is a bootstrap credential,
  not a secret: it is public knowledge by design... What stops it being a
  way in is `accounts.must_change_pin` -- while that flag is set
  `requirePrincipal` refuses every route except the PIN change itself."
- I verified that invariant holds: `grep -rl requirePrincipalAllowingPinChange
  apps/web/app/api/` returns exactly one route
  (`auth/change-pin/route.ts`). Every other route uses `requirePrincipal`,
  which throws `Forbidden` when `mustChangePin === true`. A session opened
  on the shared PIN can do nothing but change that PIN.
- `/activate/page.tsx` **exists** and has a UI. The activation-code system
  is not entirely UI-less.

**The one real gap**: `apps/web/app/api/pilot/admin/activation-codes/route.ts`
has no admin console calling it. It's reachable only by hand-crafted HTTP
request. Whether that route is still needed at all — given the shared-PIN
design now covers the case it was built for — is unclear and is the first
thing this ticket asks you to resolve, not assume.

## Goal

Either (a) build a minimal admin console page that lets an org admin issue
and view activation codes via the existing route, or (b) if you determine
the route is dead code superseded by the shared-PIN flow, remove it and its
now-orphaned tests instead — do not build UI for a code path that turns out
to serve no purpose. State which path you took and why in your PR.

## In scope

- Read `apps/web/app/api/pilot/admin/activation-codes/route.ts` and
  `apps/web/src/server/pilot/activation.ts` fully before deciding (a) or (b).
- If (a): a page under `apps/web/app/admin/activation-codes/` — org-admin
  only, lists/issues codes, uses existing design-system classes.
- If (b): remove the route, `activation.ts`'s issuing logic (keep whatever
  `/activate/page.tsx` still depends on), and update any doc that claims
  the console exists.

## Out of scope

- Do NOT touch `must_change_pin`, `pinPolicy.ts`, the shared-PIN creation
  flow in `admin/people/page.tsx`, or anything in `auth.ts`. That system is
  working as designed; this ticket is about the activation-code path only.
- Do NOT add a new PIN/credential scheme.

## Files allowed

- `apps/web/app/admin/activation-codes/**` (new, if path a)
- `apps/web/app/api/pilot/admin/activation-codes/route.ts` (read-only
  reference, or delete if path b)
- `apps/web/src/server/pilot/activation.ts` (read-only reference, or trim
  if path b)
- One new or updated test file matching whichever path you take

## Acceptance criteria

- If (a): `npm test -- --runTestsByPath apps/web/app/admin/activation-codes/page.test.tsx`
  passes; a non-admin role sees the existing `WrongRoleNotice` pattern used
  elsewhere in `admin/`; issuing a code and then visiting `/activate` with
  it succeeds (or is stated as untestable without a live DB, with the
  reasoning).
- If (b): `npm run typecheck` and `npm test` both pass with the route gone;
  grep confirms nothing else references the removed route.

## Delivery

Lane A: branch `ticket/T-001-activation-code-console` off current
`origin/main`, run `npm ci && npm run typecheck && npm run lint && npm test`,
push ONCE, open a draft PR with the repo's PR template, fill Evidence with
real command output. You cannot push to a branch twice — revisions are a
new `-v2` branch and PR.

Lane B: output every file COMPLETE (no elisions), each preceded by its full
repo path, plus a MANIFEST.md: ticket id, file list (new vs replaces), what
was not done, assumptions made. The human will place your output in
`intake/drops/T-001/`.
