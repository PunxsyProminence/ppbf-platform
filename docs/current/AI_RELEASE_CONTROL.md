# PPBF AI Release Control

Coordination record for the multi-AI release lanes. NOT a source of truth
above GitHub — every entry below cites the run, PR, or SHA that proves it.
Claude (release commander) maintains this file. Grok does not edit it.
ChatGPT audits it against live GitHub.

MODE:
RELEASE_FIRST — owner override 2026-08-24 ~20:45Z: FUNCTION FIRST. Grok /
Golden Era corrective work (#606), plates (#586) and #607 are explicitly
OUT of today's initial production release. Ship current functionally safe
main; visual work returns afterwards through normal PR + CI + staging.

LAST_VERIFIED_UTC:
2026-08-24T21:25Z

CURRENT_MAIN:
26519efd49d04b0f4b72779b921174567dd48ed0

RELEASE_CANDIDATE_SHA:
26519efd49d04b0f4b72779b921174567dd48ed0  <-- FROZEN
Contains #596 #597 #599 #600 #601 #602 #603 #604 #605. Contains NO Grok
corrective UI work. #604 (production revision-truth) is the release-critical
repair inside it.

STAGING_SHA:
26519efd49d04b0f4b72779b921174567dd48ed0

STAGING_IMAGE_DIGEST:
sha256:17773a8f55b07114e7585b1c86972e34cacef34af31a9015e2db1e0b53810b5e

PRODUCTION_SHA:
none yet — blocked at the owner approval gate (see OWNER_GATES)

PRODUCTION_IMAGE_DIGEST:
none yet

## COMBINED-TREE GATES AT THE FROZEN SHA (local, before dispatch)

- `tsc --noEmit`: clean (exit 0)
- eslint: 0 errors, 12 warnings (unchanged baseline)
- full non-pg Jest: **568 suites / 7573 tests, all pass**
- design guards incl. safeguarding-red reservation and the legacy-theme
  guard: inside the above, all green

## STAGING_RUNTIME (deploy-staging run 32774306474)

Dispatched `expected_sha=26519efd…`, `schema_migrations_complete=CONFIRMED`,
`enable_shadow_gate=true`. Completed success 2026-08-24T20:38:24Z.
All 26 steps success. Read individually, not inferred from the run colour:

- Verify Exact Tested SHA And Schema Gate: pass (pins the built revision)
- Verify Staging Schema Matches This Commit: pass (read-only, live DB)
- Build and Push Container Image to ACR: pass
- Wait For New Revision To Take Traffic: pass — the new revision is serving
- Run SHADOW E2E Gate: PASS (2m53s; intake to promotion to PIN activation to
  sign-in to quick round to sync Heavy Bag to background enqueue/drain/
  read-back)
- Runtime Verification Ledger (continue-on-error, so read by its TEXT):
  **tally: PASS=72**, sessions minted 3 / revoked 3, **zero failed probes**.
  Seeded catalogs confirmed live: drill-library-seeded ok,
  disciplines-seeded ok, session-scripts ok, competence-cohorts ok,
  library-sources ok. The 16 listed items are honestly declared as needing
  human-authored acceptance probes (mutating checks that cannot run as live
  probes) — declared future work, NOT failures.
- Deactivate Gate Athlete Fixture: GATE FIXTURE DEACTIVATE PASS (PIN cleared,
  sessions revoked — no gate credential left live)

STAGING URL:
https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io

## PRODUCTION — REQUIRED MIGRATION FOUND (release-blocking without it)

deploy-production is promote-only by construction (no build step; verified by
audit and pinned by `deployPromotionContract.test.ts`, merged in #604).

**A production migration is REQUIRED before the code deploy, and the
pipeline's own schema gate would NOT have caught its absence.**

Evidence:

- Production last ran 2238ea17 (`docs/current/PRODUCTION_STATE.json`,
  2026-08-23T00:19:41Z).
- Between 2238ea17 and the candidate, exactly one migration landed:
  `infra/azure/pilot_slice_postgres_session_rpe_semantics_migration.sql`
  plus its `pilot-apply-session-rpe-semantics-migration.mjs` runner.
- It adds `pilot.sessions.rpe_method` (not null, default 'UNKNOWN') with two
  check constraints, and makes `pilot.sessions.rpe` nullable.
- The app WRITES that column: `entities.ts` issues
  `insert into pilot.sessions (…, rpe, rpe_method, …)`, and athlete check-in
  sends `rpe: null, rpe_method: 'UNKNOWN'` (AthleteWorkspace.tsx:1461-1462,
  1541-1542).
- `apps/web/scripts/pilot-verify-schema.mjs` contains NO rpe_method check —
  so deploy-production's "Verify Production Schema Matches This Commit" step
  would have PASSED against a production database lacking the column.
- Consequence had this shipped unmigrated: every athlete check-in INSERT
  fails in production (missing column; and `rpe` still NOT NULL), while the
  deploy reported success.

Therefore `migrations_complete=CONFIRMED` is NOT truthfully attestable for
production until apply-migrations has run there.

## OWNER_GATES (both waiting on Jason; nothing else blocks)

1. **apply-migrations**, target=production, migration=all —
   run **32774493452** — status `waiting` at the production protected
   environment. THIS IS THE RELEASE-CRITICAL ONE (see above).
2. **check-database**, target=production, check=seed-identity —
   run **32770083477** — status `waiting`. Read-only; resolves production's
   own privileged seed account id and proves
   AZURE_PRODUCTION_RESOURCE_GROUP is populated. Needed before seeding
   production reference data.

deploy-production itself will queue at the same approval.

## AFTER APPROVAL — the exact remaining sequence

1. apply-migrations (production / production / all) to green
2. check-database seed-identity (production) to read production's seed
   account
3. seed-reference-data production, dataset=all, mode=dry-run, then apply
   with `confirm_seed='SEED REFERENCE DATA'` and production's OWN seed
   account (never staging's; staging used a lowercase admin address,
   production is a different, capital-A account and must be read fresh)
4. deploy-production:
   - `confirm_sha=26519efd49d04b0f4b72779b921174567dd48ed0`
   - `release_digest=sha256:17773a8f55b07114e7585b1c86972e34cacef34af31a9015e2db1e0b53810b5e`
   - `migrations_complete=CONFIRMED` (truthful only after step 1)
   - `allow_rollback=NO`
5. Verify from the run's own steps: "Wait For Promoted Revision To Take
   Traffic" (added in #604) proves the serving revision carries THAT digest
   and holds 100% traffic BEFORE the smoke checks are accepted.

## CLAUDE_ACTIVE

- Merged today: #601 #602 #603 #604 #605.
- Open, EXCLUDED from this release by owner override: #607 (guard fix that
  unblocks #606 only).
- Branch `claude/sparring-claim-honesty`: partially pushed (047b97be) when
  the session hit its usage limit; NOT in the candidate. The athlete
  sparring page claims "your coach sees it" for ordinary Deep-Track
  observations that no coach surface reads. Deferred to CONTINUE_BUILD.
- Branch `claude/scheduler-error-not-medical-red`: **DO NOT MERGE AS IS.**
  Its pushed copy of `safeguardingRedReservation.test.ts` is escape-corrupted
  by the API relay — the NUL key separator and the backslash comparisons in
  `stripTsComments` each gained a doubled backslash, which would silently
  break the guard's string masking. Re-do from a clean base. Not
  release-critical.
- Branch `claude/runtime-ledger-gates` (633d6c5d): makes the Runtime
  Verification Ledger a hard gate. Verified 53/53 plus mutation-proved. Held
  back deliberately to keep the candidate minimal; land in CONTINUE_BUILD.

## GROK_ACTIVE (excluded from today's release by owner override)

- #606 `grok/golden-era-core-ui-impl-2026-08-24`. History: three heads
  shipped a truncated `CoachWorkspace.tsx` (511 lines vs main's 2568, 0
  fetch calls). Head b8226b67 restored the body (2572 lines, 14 fetch calls,
  functional diff = root className plus a comment) but decoded ~12 JSX HTML
  entities, producing 17 `react/no-unescaped-entities` lint errors. Latest
  head e7349a5a: CI still failing. Reviewed and reported on the PR twice
  with the exact remedy. SignInPanel, `app/login/page.tsx` and
  `ppbf-golden-era.css` all reviewed PASS (including correct reserved-red
  discipline).
- #586 Type B plates: deferred by owner; branch still carries no real plate
  bytes.

## CHATGPT_FINDINGS

P0-1 / P0-2 / P0-3 all fixed and merged (#597, #596, floor-plan identity).
None outstanding.

## RELEASE_BLOCKERS

None in code. The only thing between here and production is the owner
approval on the two waiting runs above.

## DEFERRED (non-blocking, for CONTINUE_BUILD)

- Athlete sparring "your coach sees it" claim (branch above).
- Scheduler load-failure panel wearing the reserved medical red.
- Runtime ledger hard gate.
- #602 `path.relative` Windows separators (guard fails loud, not open; all
  CI is ubuntu-latest).
- Digest-to-SHA provenance binding in deploy-production.
- `pilot-verify-schema.mjs` does not cover `rpe_method` — this release's near
  miss. It should learn every migration's objects.
- Lane A/C non-blocking findings: dead "Session Duration" input, coach roster
  row click, admin "Get Code" copy, UNKNOWN-method historical RPE rendering,
  track-assignments silent autosave, athlete "Messages 0" tile, holds not
  checked at check-in/drill-assignment, SHADOW near-miss text reaching
  athlete/parent chats the direct API denies them.
- Six KNOWN_UNFIXED resource-group workflows.

## EVENT LOG

- 2026-08-24T19:33Z | claude | merged #601 | a757b12a
- 2026-08-24T19:36Z | claude | merged #602 | 99b134f9
- 2026-08-24T19:46Z | claude | dispatched production seed-identity check | run 32770083477 (waiting at owner gate)
- 2026-08-24T19:57Z | claude | merged #603 | c7dee86d
- 2026-08-24T20:01Z | claude | staging verified at c7dee86d | run 32770638337
- 2026-08-24T20:01Z | claude | opened #604 | head 86f2ab70
- 2026-08-24T20:12Z | claude | merged #604 and #605 | b99337c4, 26519efd
- 2026-08-24T20:18Z | claude | reviewed Grok #606, found CoachWorkspace truncated 511 vs 2568 | PR comment
- 2026-08-24T20:28Z | claude | FROZE candidate at 26519efd; combined gates green (7573 tests) | local
- 2026-08-24T20:30Z | claude | dispatched deploy-staging at frozen SHA | run 32774306474
- 2026-08-24T20:32Z | claude | dispatched production apply-migrations | run 32774493452 (waiting at owner gate)
- 2026-08-24T20:38Z | claude | STAGING VERIFIED at 26519efd: SHADOW gate PASS, ledger PASS=72 with 0 failures, digest sha256:17773a8f… | run 32774306474
- 2026-08-24T21:25Z | claude | found production needs the session-rpe-semantics migration, and that verify-schema would not have caught its absence | this file
