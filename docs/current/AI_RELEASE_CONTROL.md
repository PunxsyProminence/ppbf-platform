# PPBF AI Release Control

Coordination record for the multi-AI release lanes. NOT a source of truth
above GitHub — every entry below cites the run, PR, or SHA that proves it.
Claude (release commander) maintains this file. Grok does not edit it.
ChatGPT audits it against live GitHub.

MODE:
RELEASE_FIRST

LAST_VERIFIED_UTC:
2026-08-24T20:30Z

CURRENT_MAIN:
c7dee86d1f8c1fce5ee6028152248a012ef30438 (#603 merged)

RELEASE_CANDIDATE_SHA:
NOT FROZEN — waiting on Grok's actual Golden Era UI implementation PR
(per owner control doc §12; the theme-seam-only #599 is not sufficient).

STAGING_SHA:
c7dee86d1f8c1fce5ee6028152248a012ef30438

STAGING_IMAGE_DIGEST:
sha256:72dfdcd96c740d0e00728c5dc2b856c19a110dde00416a9b3675f9e38b8a47d5

PRODUCTION_SHA:
none today (not yet promoted)

PRODUCTION_IMAGE_DIGEST:
none today (not yet promoted)

## CLAUDE_ACTIVE

- PR #604 (open, CI running): deploy-production revision-truth — new
  "Wait For Promoted Revision To Take Traffic" step (asserts the promoted
  digest on the revision, waits Running/100%), explicit fail-closed
  resource-group refusal, new deployPromotionContract.test.ts (9 tests,
  mutation-proved; workflow-contract set 160/160).
- In flight, branch pending: athlete claim honesty — sparring page stops
  claiming "your coach sees it" (nothing reads ordinary sparring
  observations; the safety-review branch, which IS backed by a flagged
  near miss, keeps its wording), and the Schedule help stops claiming
  readiness/academic booking gates the scheduler does not enforce (the one
  enforced gate — an active all_training hold blocks registration — is what
  the help now names). Tests + mutation proof done; full-suite gate running.
- In flight (subagent, branch pending): scheduler load-failure panel wears
  the reserved MEDICALLY_NOT_ALLOWED red (--locked / badge--locked at
  app/schedule/page.tsx:304-305); being moved to the non-medical failure
  idiom with the safeguardingRedReservation allow-list SHRUNK accordingly.
- Queued: flip the staging Runtime Verification Ledger from
  continue-on-error to a hard gate — its "expected failures until reference
  data is seeded" excuse is now empirically gone (run 32770638337:
  tally PASS=72, zero probe failures on seeded catalogs).

## GROK_ACTIVE

- No corrective Golden Era implementation PR observed as of
  2026-08-24T20:30Z. #599 (theme seam) merged earlier; owner ruled it
  insufficient as the actual UI implementation. Watching for the new PR.
- PR #586 (Type B plates): DEFERRED from today's critical path by owner
  decision (control doc §4). Branch head 877f59d7 still carries no real
  plate bytes (measured against the byte/SHA-256 manifest). Not blocking.

## CHATGPT_FINDINGS

- P0-1/P0-2/P0-3 from the independent audit: all fixed and merged
  (#597 readiness non-prescription, #596 pain-report ordering, floor-plan
  identity fix). No unresolved ChatGPT findings known at this timestamp.

## MERGED_SINCE_LAST_CHECK

- #601 fail-closed production resource group (apply-migrations,
  seed-reference-data, check-database) — merged a757b12a.
- #602 legacy-import guard tightened to the explicit two-file theme chain —
  merged 99b134f9.
- #603 athlete self-report honesty (owner's exact wording; 4 new pinning
  tests, mutation-proved) — merged c7dee86d.

## STAGING_DATABASE

- Migrations: apply-migrations run 32756298411 (target=staging,
  migration=all) — green; schema verified read-only by the deploy's
  "Verify Staging Schema Matches This Commit" step (run 32770638337 step 7).
- Seed: dry-run 32757880085 green (session scripts 3/65/4 would-insert,
  first fill); apply 32759052783 green ("Written. The loaders are
  idempotent"); org resolved from the app secret; hostname guard
  ppbf-pg-staging-7k4m2q / ppbf_staging.
- Catalogs verified live by the runtime ledger: drill-library-seeded ok,
  disciplines-seeded ok, library-sources ok (run 32770638337).

## STAGING_RUNTIME

- Deploy run: 32770638337 (deploy-staging, dispatched with
  expected_sha=c7dee86d…, schema_migrations_complete=CONFIRMED,
  enable_shadow_gate=true) — completed success 2026-08-24T20:01:54Z.
- Every step green at step level, including the hard gates:
  - Verify Exact Tested SHA And Schema Gate: pass
  - Verify Staging Schema Matches This Commit: pass
  - Wait For New Revision To Take Traffic: pass (new revision serving 100%)
  - Run SHADOW E2E Gate: PASS (full intake→promotion→PIN
    activation→sign-in→quick round→sync Heavy Bag→background
    enqueue/drain/read-back cycle)
  - Runtime Verification Ledger (continue-on-error, so read by its TEXT,
    not its color): tally PASS=72, sessions minted 3 / revoked 3, ZERO
    failed probes. 16 items honestly listed as needing human-authored
    acceptance probes (mutating checks that cannot run as live probes) —
    those are declared future work, not failures.
  - Deactivate Gate Athlete Fixture: GATE FIXTURE DEACTIVATE PASS
    (no leaked gate PIN).
- Staging URL:
  https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io
- Digest (for deploy-production release_digest):
  sha256:72dfdcd96c740d0e00728c5dc2b856c19a110dde00416a9b3675f9e38b8a47d5

## PRODUCTION

- Not deployed today yet. deploy-production is promote-only by
  construction (no build step; verified by pipeline audit and pinned by
  deployPromotionContract.test.ts in PR #604).
- Production DB state: UNKNOWN pending the seed-identity check —
  check-database run 32770083477 (target=production, check=seed-identity)
  is sitting in `waiting` at the production protected-environment approval.
- Production migrations/seed/deploy all bind to the same `production`
  environment approval.

## RELEASE_BLOCKERS

- Grok's actual Golden Era UI implementation PR does not exist yet
  (required for the frozen candidate per control doc §12/§17).
- Production protected-environment approval (owner-only; see OWNER_GATES).
No other release blockers known: audit lanes A (journeys), B (auth/org,
239 routes), C (data honesty), F (pipeline), G (SHADOW) all reported no
unfixed RELEASE_BLOCKER-class defects; C1 (sparring claim) is being fixed
in the claim-honesty branch above.

## OWNER_GATES

1. Approve production-environment workflow runs when ready. First in line:
   check-database seed-identity run
   https://github.com/PunxsyProminence/ppbf-platform/actions/runs/32770083477
   (read-only; resolves production's seed account and proves the
   AZURE_PRODUCTION_RESOURCE_GROUP secret is populated). Production
   migrations, seed, and the deploy itself will each queue at the same
   approval.

## DEFERRED (non-blocking)

- Type B plates (#586) — owner decision, later visual upgrade.
- #602 path.relative Windows separators — guard fails LOUD not open on
  Windows; all CI is ubuntu-latest; one-line normalization idiom recorded
  (safeguardingRedReservation.test.ts:506) for later.
- Digest↔SHA provenance binding in deploy-production (procedural today:
  record both from the same staging run).
- Lane A non-blockers: dead "Session Duration (minutes)" input (records
  nothing), coach roster row click highlights only, admin "Get Code"
  button copy, untouched-slider default recorded as GREEN auto note
  (mitigated by #603's value read-back; product call).
- Lane C non-blockers: UNKNOWN-method historical RPE rendering (no such
  rows exist in production's empty DB today), track-assignments silent
  autosave, athlete "Messages 0" hardcoded tile, holds not checked at
  check-in/drill-assignment (policy decision), SHADOW near-miss text
  reaching athlete/parent chats that the direct API denies them (product
  sign-off needed; contained to own record/org).
- Six KNOWN_UNFIXED resource-group workflows (exact list pinned in
  workflowResourceGroupContract.test.ts, shrink-only).

## NEXT_ACTIONS

1. Merge #604 on green; merge claim-honesty and scheduler-red PRs on green.
2. Flip the Runtime Verification Ledger to a hard gate (one-line PR).
3. When Grok's corrective UI PR appears: technical review (function, auth,
   role, org, privacy, safety, readiness, pain, build, tests, integration),
   merge on green, freeze TODAY_RELEASE_CANDIDATE_SHA, combined-tree
   gates, staging redeploy of the frozen SHA with the gate on.
4. Production, with staging evidence in hand: seed-identity → migrations →
   seed (dry-run then apply, production's own capital-A seed account read
   fresh) → deploy-production with confirm_sha=frozen SHA and
   release_digest=that staging run's digest. Each step queues at the owner
   approval gate.

## EVENT LOG

- 2026-08-24T19:33Z | claude | merged #601 (fail-closed production RG) | a757b12a
- 2026-08-24T19:36Z | claude | merged #602 (guard allow-list) | 99b134f9
- 2026-08-24T19:46Z | claude | dispatched check-database production seed-identity | run 32770083477 (waiting at env approval)
- 2026-08-24T19:52Z | claude | dispatched deploy-staging expected_sha=c7dee86d gate=on | run 32770638337
- 2026-08-24T19:57Z | claude | merged #603 (athlete self-report honesty) | c7dee86d
- 2026-08-24T20:01Z | claude | staging deploy SUCCESS: SHADOW gate PASS, ledger PASS=72/0 fail, digest sha256:72dfdcd9… | run 32770638337
- 2026-08-24T20:01Z | claude | opened #604 (deploy-production revision truth) | head 86f2ab70
- 2026-08-24T20:30Z | claude | created this coordination file | this commit
