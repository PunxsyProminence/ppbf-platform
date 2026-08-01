# SHADOW Sibling Surfaces + Spec Conformance Audit — 2026-08-01

Completes the last two dimensions `SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md` §6 listed as
uncovered. Audited at `5cd79c4`. Every finding established against source with file:line
evidence; nothing inferred from PR titles or prior docs.

The other two uncovered dimensions — jobs/feedback/unlocks and
classification/routing/evidence — were completed in
`SHADOW_JOBS_ROUTING_EVIDENCE_AUDIT_2026-07-31.md` and are not re-audited here. **§6 of the
2026-07-28 audit is now fully covered.**

Verdicts follow the 2026-07-31 convention: **DEFECT** (wrong behavior, concrete failure
scenario), **DESIGN-GAP** (missing piece someone must decide on), **STALE-SPEC** (code is
right, the document is wrong), **OK** (traced and sound).

---

## Dimension A — sibling chat surfaces (`/admin/shadow`, `/shadow/scout`)

Much healthier than the 2026-07-28 audit described. Its §1.5 claimed the console "swallows
every failure" and leaves "a fully-rendered but empty shell". That is no longer accurate and
should not be carried forward: of 16 fetches, 15 now parse the payload, `throw` on
`!response.ok`, and land in a `catch` that calls `setError`, which renders. The page has 20
error-state references.

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| A1 | **FIXED.** The growth-metrics fetch was the one silent failure left in the console: `if (!response.ok) return;` inside a `try/finally` with no `catch`, so a 403 or 500 leaves the SHADOW Intelligence tiles blank with no message, while every neighbouring panel would have explained itself | **DEFECT** (minor) — **fixed in #154** | `app/admin/shadow/page.tsx:1082` |
| A2 | ~~The chat footer links "The Office" unconditionally, so a non-admin is routed to a console whose every call will 403.~~ **WITHDRAWN — this finding was wrong.** Measured per role against the eight endpoints the console calls: `organization_admin` 8/8, `admin` 7/8, `platform_owner` 7/8, `coach` 5/8, `parent` 2/8, `athlete`/`volunteer`/`staff` 1/8. Every role reaches at least `telemetry`, and a coach reaches most of the console, so "every call will 403" is false and gating the link on the viewer's tier would hide a surface coaches legitimately use. The narrow real issue — an admin-only panel that could not explain its own refusal — is A1, now fixed | **WITHDRAWN** | role sets at `shadowRoleSets.ts`; per-route `requireRole` lists |
| A3 | `/admin/shadow` has no client-side auth gate — 0 session checks in 2105 lines | **OK** | Server-side `requireRole` is enforced on every route it calls; the gate's absence costs clarity (A2), not access |
| A4 | Credentials on every console fetch | **OK** | 16 of 16 carry `credentials: 'include'`; the #39 fix held and was extended to the seven fetches added since |
| A5 | `/shadow/scout` renders a `cancelled` branch explaining expiry | **OK** | `app/shadow/scout/page.tsx:466-468` — the 2026-07-31 audit's B3 is fixed |
| A6 | Every endpoint the console calls exists | **OK** | 12 of 12 resolve; the apparent 13th (`api/pilot/shadow/metrics/route`) is a **type import**, not a fetch (`:8`) |

---

## Dimension B — spec vs implementation (`docs/SHADOW_ML_ARCHITECTURE_SPEC.md`)

The spec's §3 API block is its most concretely checkable section, so conformance was measured
there first, then against the safety and rate-limit claims.

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| B1 | **FIXED** (owner decision 2026-08-01: 10/user/hour, administrative tier exempt). Spec §3.1 specified "10 Heavy Bag/hour per organization" and no such limit existed. There is no `heavy_bag` bucket, and no bucket is keyed by organization alone: `enforceShadowRateLimit` requires *both* `organizationId` and `accountId`, so every cap is per-account-within-org. A Heavy Bag turn is charged to the same generic `chat` (30/60s) and `chat_daily` (400/day) buckets a Quick Round consumes. An organization with N accounts therefore has an effective ceiling of N × 400 Heavy Bag turns/day and **no organization-level ceiling at all** — on the platform's most expensive inference path | **DEFECT** — **fixed in #154** | `shadowRateLimit.ts:41-56` (five buckets, none for heavy bag), `:94-100` (org+account key); `chat/route.ts:545-553` (only `chat` and `chat_daily` applied) |
| B2 | Spec §3.5 `GET /api/pilot/shadow/scout-reports` does not exist, and §5.5's Scout Report generation pipeline is gone (`generateScoutReport` deleted by the 2026-07-31 audit's B5; only a tombstone comment remains at `shadowHeavyBag.ts:261`). `/shadow/scout` is linked and titled for Scout Reports but reads the generic `jobs` list instead | **DESIGN-GAP** | route absent; `app/shadow/scout/page.tsx` fetches `shadow/jobs`, `shadow/chat`, `shadow/metrics` only |
| B3 | Spec §3.1 specifies 100 requests/minute per user; actual chat limit is 30/60s | **STALE-SPEC** | Code is stricter than specified, and `shadowRateLimit.ts:42-44` explains why. The document is wrong, not the code |
| B4 | Spec §3.7 `POST /api/pilot/shadow/migrate` does not exist | **STALE-SPEC** | Migrations now run through the manual `apply-migrations` workflow with a retype-the-target confirmation and an explicit "never applied as a side effect of merging" rule. Strictly safer than an HTTP migration endpoint; the spec predates it |
| B5 | Spec §6.2 states "**Every response includes**" `confidence`, `confidenceReason`, `chainOfThought`, `confidenceMarker`, `librarySourcesUsed`, `recommendationsLinked`, `caveats`. None are returned | **not filed as a defect** | `shadowExplainability.ts` was deleted (#76) together with the client interface that declared it, so nothing in the product promises this to a user. Recorded as a roadmap gap per the 2026-07-28 audit's own rule: an unbuilt capability is only a defect when the UI advertises it |

---

## What to do

**B1 and A1 are fixed.** B1 was resolved by owner decision rather than by following the spec:
ten Heavy Bag rounds per *user* per hour with the administrative tier exempt, rather than the
per-organization cap §3.1 describes. A shared organization pool was rejected deliberately —
one member exhausting it would silently deny everyone else in the gym. The spec should be
updated to match.

**A2 is withdrawn.** It was checked before being implemented and did not survive: the claim
that non-admins hit a console where every call 403s is false, and acting on it would have
hidden the console from coaches who use five of its eight data sources. Recorded rather than
deleted, because the measurement is the useful part.

B2 is a product decision — build the Scout Report pipeline the spec describes, or retitle
`/shadow/scout` to what it actually shows (a job list). Leaving a surface named for a feature
that was deliberately deleted is the same shape of problem as the dead prompt sections removed
in #152.

B3 and B4 need only a documentation edit, and in both cases the code is the better version.

---

## Coverage

Complete for the two dimensions named. Two limits worth stating plainly:

- **Dimension B was measured against the spec's §3 API block, §3.1 rate limits, and §6.2**,
  which are its concrete, falsifiable claims. The narrative sections (§1.1 Hybrid Intelligence
  Stack, §2.x components, §5.x pipelines) were read for context but not converted into a
  claim-by-claim table; a full 1509-line conformance matrix was not built.
- **Dimension A did not exercise the console at runtime.** Findings are from source. A1's
  blank-tile behavior and A2's 403 path are read from control flow, not observed in a browser.
