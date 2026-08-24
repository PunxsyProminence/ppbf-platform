# PPBF AI Release Control

Coordination record for the multi-AI release lanes. NOT a source of truth
above GitHub — every entry below cites the run, PR, or SHA that proves it.
Claude (release commander) maintains this file. Grok does not edit it.
ChatGPT audits it against live GitHub.

MODE:
CONTINUE_BUILD — production is live and verified (2026-08-24T22:56Z). The
release-first phase is complete; visual work returns through normal
PR + CI + staging. History of this phase: owner override ~20:45Z, FUNCTION FIRST. Grok /
Golden Era corrective work (#606), plates (#586) and #607 are explicitly
OUT of today's initial production release. Ship current functionally safe
main; visual work returns afterwards through normal PR + CI + staging.

LAST_VERIFIED_UTC:
2026-08-24T23:05Z

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
26519efd49d04b0f4b72779b921174567dd48ed0  <-- LIVE

PRODUCTION_IMAGE_DIGEST:
sha256:17773a8f55b07114e7585b1c86972e34cacef34af31a9015e2db1e0b53810b5e
IDENTICAL to STAGING_IMAGE_DIGEST above — the same tested image was
promoted, not rebuilt.

PRODUCTION_REVISION:
app-ppbf-production--0000136

PRODUCTION_URL:
https://app-ppbf-production.purpledesert-3a75d580.eastus.azurecontainerapps.io

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

## PRODUCTION — REQUIRED MIGRATION (the pipeline DOES catch it)

deploy-production is promote-only by construction (no build step; verified by
audit and pinned by `deployPromotionContract.test.ts`, merged in #604).

A production migration IS required before the code deploy:

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

CORRECTION (2026-08-24T22:10Z). An earlier revision of this file claimed
`pilot-verify-schema.mjs` does not check `rpe_method`, and therefore that
deploy-production would have passed against an unmigrated production
database and then failed every check-in while reporting success. **That was
wrong.** The claim came from grepping the script for the literal string,
which is not a valid test: the script DERIVES its expected objects from the
migration SQL at deploy time.

Verified by running the script's own `expectedObjectsFrom` over the real
`infra/azure` tree (99 migration files):

- `sessions.rpe_method` — EXPECTED: true
- constraints expected: `pilot_sessions_rpe_method_check`,
  `pilot_sessions_rpe_method_agrees_with_value`

So deploy-production's "Verify Production Schema Matches This Commit" step
would have REFUSED the deploy until apply-migrations ran, which is exactly
what that step exists to do. There is no gap here, and no near miss to fix.

The operational consequence is unchanged: `migrations_complete=CONFIRMED` is
not truthfully attestable, and the deploy would refuse anyway, until
apply-migrations has run against production.

## PRODUCTION RUNTIME — VERIFIED LIVE (deploy-production run 32783211177)

Dispatched confirm_sha=26519efd…, release_digest=sha256:17773a8f…,
migrations_complete=CONFIRMED, allow_rollback=NO.
guard job success 22:08:58Z; build-and-deploy success 22:56:48Z after the
owner approved the production environment. Every step read individually:

- Resolve Production Resource Group: pass (the explicit refusal step added
  in #604 — the secret is populated)
- Verify Production Schema Matches This Commit: pass (read-only, live
  production DB, AFTER apply-migrations run 32774493452 landed the
  session-rpe-semantics migration)
- Verify release digest exists in ACR: pass
- Refuse a Rollback Nobody Asked For: pass (not an ancestor; proceeded)
- Validate Production AI Configuration: pass
- Deploy Tested Digest to Azure Container App (Production): pass
- **Wait For Promoted Revision To Take Traffic: pass** — and this is the
  step that earned its place. Log:
    Latest revision app-ppbf-production--0000136 runs image
      …/ppbf-frontend@sha256:17773a8f55b07114e7585b1c86972e34cacef34af31a9015e2db1e0b53810b5e
      1: Activating 100
      2: Activating 100
      3: Running 100
  The digest assertion passed AND the revision took ~15s to leave
  Activating. Before #604 the smoke checks ran immediately after the
  update, so they would have probed the PREVIOUS revision and passed —
  a green run reporting a deploy that was not yet serving.
- Pilot API Smoke Checks: pass, AFTER the wait — "Production smoke checks
  passed." (login empty payload 400, session 200, unauthenticated shadow
  events 401) against
  https://app-ppbf-production.purpledesert-3a75d580.eastus.azurecontainerapps.io

## PRODUCTION DATABASE

- Migrations: apply-migrations run 32774493452, target=production,
  migration=all — SUCCESS. Log: target_hostname ppbf-pg-195892…,
  "Applied session RPE semantics migration",
  "PILOT SESSION RPE SEMANTICS MIGRATION PASS", and the run's own summary
  "Safe to attest migrations_complete for production".
- Seed identity: check-database run 32770083477, check=seed-identity —
  SUCCESS. Production seed account is **Admin@punxsyprominence.org**
  (CAPITAL A), platform_owner, active, org ppbf-default-org. The
  lowercase twin is active=NO; the check prints an explicit
  CASE-DIFFERING DUPLICATES warning.
- Reference-data seed: dry-run dispatched (run 32783198601,
  seed_account_id=Admin@punxsyprominence.org, organization_id blank so it
  resolves from the app's own default-org secret) and still WAITING at the
  production approval as of 23:05Z. Read-only; it writes nothing and does
  not gate the deploy. OPEN QUESTION, honestly unresolved: whether
  production's drill / discipline / competence-cohort / session-script
  catalogs are already populated. The dry-run answers it without writing.

## OWNER_GATES (historical — the release-blocking ones are cleared)

1. apply-migrations run 32774493452 — APPROVED and GREEN.
2. check-database seed-identity run 32770083477 — APPROVED and GREEN.
3. deploy-production run 32783211177 — APPROVED and GREEN. PRODUCTION LIVE.
4. seed-reference-data dry-run run 32783198601 — STILL WAITING. Read-only,
   non-blocking. Approve it to learn whether production's operational
   catalogs need filling.

Note for whoever runs the next release: GitHub requires a SEPARATE approval
per run. Approving two runs does not carry to later dispatches.

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
- 2026-08-24T21:25Z | claude | found production needs the session-rpe-semantics migration | this file
- 2026-08-24T22:10Z | claude | CORRECTED that entry: verify-schema DOES derive and expect sessions.rpe_method plus both constraints (ran expectedObjectsFrom over all 99 migration files); deploy-production would have refused, not silently shipped | this file
