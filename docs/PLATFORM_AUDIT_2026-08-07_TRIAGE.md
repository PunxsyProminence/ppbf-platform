# Platform audit 2026-08-07 — triage

An owner-supplied third-party audit report (`PPBF_PLATFORM_AUDIT_REPORT.md`,
source-only review, no live-system access) was checked against the actual
codebase on the same date. Overall verdict: no critical issues, consistent
with the audit's own conclusion. This file records what was verified, what
was corrected, and what genuinely needs the owner (per
`EXTERNAL_AUDIT_PROMPTS.md`'s own standing rule: an outside model's claims
get checked against the real code before anyone acts on them, because this
repo has a documented history of audits asserting things that turned out to
be false once someone looked).

## One claim in the audit was false, checked and corrected here

The audit states: *"File upload endpoints (video, roster) have caps but no
rate limiting."* This is not true for video. `shadow/upload/route.ts:49`,
`video/upload/route.ts:34`, and `profile/photo/route.ts:47` (portrait
upload) all call `enforceShadowRateLimit` (`shadowRateLimit.ts`), which is
Postgres-backed (`pilot.shadow_rate_limit_buckets`), not an in-memory
stand-in. Roster import (`admin/roster-import/route.ts`) genuinely has no
rate limiting — the audit was right about that half, wrong about the other.

## Rate limiting — the actual coverage (the audit's real, valid ask: document the strategy)

Three independent mechanisms exist, none of them a blanket per-IP/per-route
throttle:

1. **`rateLimit.ts`** — failed-attempt throttling (per-account and/or
   per-IP), on every route reachable *without* an authenticated session:
   `auth/login`, `auth/activate`, `auth/change-pin`, `admin/bootstrap`,
   `admin/platform-owner-microsoft`, `public-interest`. Two backing stores:
   an in-memory `Map` (`checkRateLimit`) and a Postgres-backed durable store
   (`checkDurableRateLimit`, gated by `PPBF_DURABLE_RATE_LIMIT`). The
   in-memory store is a **documented, deliberate** fallback
   (`rateLimit.ts:1-7`): "suitable for development and single-instance
   deployments... In production, this should be backed by Redis or similar
   distributed cache" — i.e., the durable store is the real production
   answer, not an oversight the audit needed to surface.
2. **`shadowRateLimit.ts`** — Postgres-backed request-volume quotas (chat,
   chat_daily, heavy_bag, upload buckets) on `shadow/chat`, `shadow/feedback`,
   `shadow/upload`, `video/upload`, `profile/photo`.
3. **`wallRateLimit.ts`** — in-memory per-IP fixed window on the single
   public wall-display route, with the same documented single-instance
   caveat as (1).

**Every anonymous-reachable mutating route already has rate limiting.**
There is no `middleware.ts` anywhere in `apps/web` — no blanket request
throttle exists, and none is needed today because every other mutating route
sits behind `requireRole`/`requirePrincipal`: an attacker needs a valid
authenticated, role-scoped session before reaching it. Confirmed **not**
rate-limited, all of them role-gated and audited (every one logs a
`pilot.audit_events` row on the action it performs): `admin/roster-import`,
`admin/portrait-review`, `admin/accounts/pin-reset`, `parent/consent` (grant/
withdraw), `api/pilot/incidents`, `api/pilot/escalations`,
`compliance/escalate`, `shadow/near-misses`, `feedback/submit`. For these,
classic brute-force rate limiting doesn't map cleanly onto the threat model
(the caller already holds valid staff/guardian credentials) — the operative
control today is the audit trail, not a request counter. `pin-reset`
specifically was checked in detail: it's an org-admin *setting* a new PIN for
an account they manage, not guessing an existing one, so it isn't a
brute-forceable secret the way `auth/login`/`auth/change-pin` are.

**If the owner wants blanket per-route throttling later**, build it on the
`shadowRateLimit.ts` Postgres-backed pattern, not `rateLimit.ts`'s in-memory
`Map` — Azure Static Web Apps' serverless functions do not guarantee
instance affinity, so an in-memory counter silently stops working under
multi-instance load with no error, exactly the failure mode this repo's own
code comments already warn about.

## Everything else in the audit — owner-decision or infra-access required, not fixed here

Nothing else in the report described a defect fixable in source without
either a product/infra decision or access this environment doesn't have
(Azure portal, GitHub org Dependabot settings, a live database to run
`npm audit`/query plans against):

- **Rollback procedures for migrations** — this repo's migrations are
  additive/idempotent by design (every `.pg.test.ts` proves re-running is a
  no-op); the real rollback story is Azure's managed point-in-time restore,
  which is an infra runbook, not a code change. Worth writing up, but needs
  the owner to confirm what Azure backup/restore is actually configured —
  guessing at RPO/RTO numbers here would be worse than leaving it unwritten.
- **Bundle size analysis / `@next/bundle-analyzer`** — safe to add as a
  dev-only tool, but touching build config for an app that deploys via
  Azure Static Web Apps' own build pipeline is exactly the kind of change
  this session shouldn't make unsupervised at low stakes and zero urgency
  (audit found no evidence of an actual bloat problem, only that no one has
  measured).
- **E2E coverage expansion, monitoring/alerting (Application Insights),
  secrets-rotation documentation, GDPR formal assessment, Dependabot/`npm
  audit` in CI** — all real, reasonable suggestions, none of them a bug;
  each is either a scoping decision (what should E2E cover first) or
  requires access/credentials (Azure Application Insights, GitHub org
  settings) this coding session doesn't have.
- **Custom error types, ORM evaluation** — explicitly labeled low-priority
  by the audit itself; a 20-30 hour ORM migration in particular is not
  something to start unsupervised on an unrelated task.

2026-08-07
