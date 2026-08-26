# Athlete Workspace — Delivery Ledger

Per-slice delivery state for the athlete workspace program. One slice at a
time: implement, test, review, PR, merge, deploy that exact SHA to staging,
verify against the deployed revision, record, continue.

**This file is not a source of truth above GitHub or staging.** Every row
cites the PR, SHA or run that proves it. If this file and remote evidence
disagree, **remote wins** and the row is corrected explicitly rather than
quietly.

**Release state lives elsewhere.** `docs/current/AI_RELEASE_CONTROL.md` is the
authoritative record for CURRENT_MAIN / STAGING_SHA / PRODUCTION_SHA and the
image digests. This file tracks slice progress and points at that one; SHAs are
not duplicated across both, because two copies of a SHA are two things that can
drift apart.

## Status vocabulary

| Status | Means |
|---|---|
| `NOT_STARTED` | No branch, no PR, no code. |
| `ACTIVE` | Being implemented now. At most one slice may be here. |
| `PR_GREEN` | PR open, CI green, not merged. |
| `MERGED` | On `main`. Not yet proven on a deployed revision. |
| `STAGED_VERIFIED` | The exact merged SHA was deployed to staging AND passed the slice's own authenticated verification. |
| `BLOCKED` | Cannot proceed. The blocker is named in the row. |

`STAGED_VERIFIED` is only ever set from a run whose **step list** was read, not
from a job conclusion. A step conditioned on a workflow input inherits an
implicit `success()`, so an earlier failure **skips** later steps silently — a
skipped safeguarding probe and a passing one look identical in the run summary.
See `AGENT_KERNEL.md`.

## Resuming after a context reset

1. Read this file.
2. Verify its last recorded SHA against GitHub and against the deployed staging
   revision.
3. Resume at the first slice that is not `STAGED_VERIFIED`.
4. Do **not** restart a completed slice. A later change that touches an earlier
   slice's dependency re-runs that slice's focused tests only; it does not
   reopen its implementation.

## Program context at start (2026-08-26)

The audit reference was `main` at `e8b663cf`. Two merges landed after it and
before this program began, so `e8b663cf` is already stale as a baseline:

- `bdb51f57` — #679, agent environment facts in `AGENT_KERNEL.md` (docs only).
- `393b5a81` — #678, the SHADOW staging gate repair. **This is Slice 1's core.**

Work already in flight that this program must integrate rather than duplicate:

| Prompt named in the program | Real artifact | State |
|---|---|---|
| SHADOW readability / progressive disclosure | #675 | CI green, unmerged. Triggers **no e2e suite at all** — see Slice 7. |
| Expandable Floor cards and Goals | none | No branch, no PR, no code. Becomes Slice 9. |
| Removal of athlete access to Operations | #676 | CI green, unmerged. Becomes part of Slice 8. |
| Activation / onboarding handoff | none | No branch, no PR, no code. Becomes Slice 2. |

Also open and not part of this program: #677 (Card Catalog mobile layout),
#680 (gate refusal assertions), #671 (guardian contact safeguarding).

Collision map, verified by merge simulation across all pairs: **zero conflicts,
zero migrations** among the open set. The only file-level overlaps are
`apps/web/e2e/coach-journey.spec.ts` and `scripts/ci-classify-paths.mjs`,
between #676 and #677, and both are hunk-disjoint.

`apps/web/components/AthleteWorkspace.tsx` is touched by **no** open PR. The
primary agent owns it exclusively; no two agents edit it concurrently.

## Slices

### Slice 1 — Repair the SHADOW activation gate

- **Status:** `ACTIVE` — core `MERGED` and `STAGED_VERIFIED`; four of the
  fourteen requirements remain open.
- **Baseline SHA:** `e8b663cf`
- **PR:** #678 (merged), #680 (open, follow-up from its own adversarial review)
- **Merged SHA:** `393b5a81`
- **Staging SHA:** `3969fd3e` — run 33001246076, step 23 `Run SHADOW E2E Gate`
  **success**. Re-exercised on `02edec70` in run 33002830497, also success.
- **Focused tests:** `node --check`, `eslint`. The gate is a `.mjs` deploy
  script outside the TS project and the jest roots, so its only real proof is a
  staging dispatch with `enable_shadow_gate=true`.
- **Staging verification:** PASS. Root cause was the shared-PIN retirement
  rewriting `/api/pilot/admin/accounts/pin-reset` to issue a one-time
  `activation_code` while the gate still asserted the obsolete admin-PIN flow.
  Established as red on `main` first (run 32999742464 on `e8b663cf`, byte-identical
  failure) so the repair was made in the right place.
- **Remaining:** four requirements not met, tracked for gap closure —
  (7) the gate never signs out between activation and re-login;
  (10) `123456` / `DEFAULT_FIRST_LOGIN_PIN` is not asserted to be refused;
  (3)(14) no explicit check that the activation code, either PIN, or a session
  cookie cannot reach a log or `GITHUB_STEP_SUMMARY`.
  Plus #680: one refusal was asserted where the account is still inactive, so it
  never reached the credential check it named.

### Slice 2 — Activation and onboarding handoff

- **Status:** `NOT_STARTED`. Gap map complete; three defects found, one of them
  live and harmful.

**LIVE DEFECT — `/admin/pin` strands athletes. Fix this first.**
`/admin/pin` is in the nav as "PIN Management" (`buildingMap.ts:143`,
`ADMIN_GATE`). It posts `{account_id, pin, mode}` to `pin-reset`, which now
reads **only** `account_id` and calls `provisionAthleteActivation({mode:'reset'})`
— nulling `pin_hash`, setting `active_flag = false`, revoking every session.
The page contains **zero occurrences of "activation"**: it never reads the
`activation_code` the route returns. So one click deactivates the athlete,
discards the recovery code, and tells the admin *"PIN activated. Tell the
athlete this PIN"* about a PIN that was never stored
(`app/admin/pin/page.tsx:98-107`, `:126`). Athlete locked out, admin unaware,
recovery code gone. Same root cause as Slice 1: the shared-PIN retirement
changed `pin-reset`'s contract and this caller was never updated.

Related dead code: `resetAccountPin` (`auth.ts:408`) and `activateAccountPin`
(`auth.ts:492`) are the only functions that set `must_change_pin = true` and
now have **no callers at all**, while their comments still describe the retired
model as current.

**DEFECT — `startsWith('PIN')` prefix matching, reintroduced twice.**
`errors.ts:14-17` documents this exact bug as already fixed once.
`PIN_TRIVIALLY_GUESSABLE`'s message begins "That PIN…", not "PIN…", so the
prefix test misses it at `app/activate/page.tsx:143` and
`app/api/pilot/auth/activate/route.ts:93`. Consequence: an athlete who picks
`111111` is thrown back to the **code** screen with a PIN error, and it counts
against the brute-force budget — they can rate-limit themselves out of
activation without ever mistyping the code. The server already returns a
machine `code` in the body (`http.ts:83`); both call sites ignore it.

**DEFECT — `must_change_pin` not cleared on redeem.** `redeemActivationCode`
sets `pin_hash` and `active_flag` but never touches `must_change_pin`
(`activation.ts:313-324`). `provisionAthleteActivation` clears it on **both**
modes and is safe; the unsafe issuer is `issueActivationCode`
(`activation.ts:179-243`, behind `/admin/activation-codes`), which writes only
to the token table. Latent against deployed databases holding legacy rows
rather than reproducible from a clean schema — but one line, and
`issueActivationCode` is the documented general-purpose issuer.

**Other confirmed gaps:** no Copy/Print anywhere in the product
(`navigator.clipboard` and `window.print` appear nowhere in `app/` or
`components/` outside CardCatalog and PrintRoom); `/admin/activation-codes`
shows the one-time code with none of Copy/Print/Done and no live region or
focus move, so a screen-reader admin is never told it appeared;
`/athlete/sign-in` has no link to `/activate`; the `/activate` PIN field states
only "6 numbers" while `pinPolicy.ts` enforces seven more rules; **no e2e
touches activation at all** (`grep -rln "activat" apps/web/e2e/` returns
nothing). Stale "starting PIN" wording remains in `app/change-pin/page.tsx:108`
and `:151` (the latter publishes `123456` to every athlete),
`app/admin/organizations/page.tsx:440`, and `app/admin/pin/page.tsx:126-127,199-201`.

**Not involved:** `components/AthleteWorkspace.tsx` — its only `activation`
hit is a warm-up block description. Safe to exclude from this slice's
collision map.

### Slice 3 — Atomic session start and current Floor plan

- **Status:** `NOT_STARTED`

### Slice 4 — Notes and checkout

- **Status:** `NOT_STARTED`

### Slice 5 — Sparring integrity

- **Status:** `NOT_STARTED`

### Slice 6 — Pain-report integrity

- **Status:** `NOT_STARTED`

### Slice 7 — SHADOW and communication truthfulness

- **Status:** `NOT_STARTED`
- **Remaining:** must integrate #675 rather than clone it. #675 rewrites
  `app/shadow/page.tsx` by +236/-139 and the CI classifier assigns it **no e2e
  suite**, so its green CI is the weakest of the open set.

### Slice 8 — Athlete Schedule and access

- **Status:** `NOT_STARTED`
- **Remaining:** must integrate #676 (Operations restricted to admin +
  platform_owner) rather than duplicate it. Note #676's own adversarial review
  found four raw `/operations` links it had missed, two on ungated pages;
  those are fixed on that branch. Hidden navigation is not authorization — the
  server-side refusal is the requirement.

### Slice 9 — Floor and Goal usability and lifecycle

- **Status:** `NOT_STARTED`
- **Remaining:** no prior code exists for this despite it having been queued as
  a prompt. Nothing to integrate; it is a build.

### Slice 10 — Video and progression

- **Status:** `NOT_STARTED`

### Slice 11 — Final authenticated staging gate

- **Status:** `NOT_STARTED`
- **Remaining:** runs once, after every prior slice is independently
  `STAGED_VERIFIED`. Ends in a production go/no-go and waits for explicit
  owner authorization. This program does not deploy production.
