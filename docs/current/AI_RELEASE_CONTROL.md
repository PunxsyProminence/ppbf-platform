# PPBF AI Release Control

Coordination record for the multi-AI release lanes. NOT a source of truth
above GitHub — every entry below cites the run, PR, or SHA that proves it.
The release-control lane maintains this file (AGENT_KERNEL.md, Lane model). Build lanes do not edit it.
ChatGPT audits it against live GitHub.

MODE:
CONTINUE_BUILD — production is live and verified (2026-08-25T13:46Z, a830eae2 —
the SECOND production release; the first was 26519efd at 2026-08-24T22:56Z). The
release-first phase is complete; visual work returns through normal
PR + CI + staging. History of this phase: owner override ~20:45Z, FUNCTION FIRST. Grok /
Golden Era corrective work (#606), plates (#586) and #607 are explicitly
OUT of today's initial production release. Ship current functionally safe
main; visual work returns afterwards through normal PR + CI + staging.

LAST_VERIFIED_UTC:
2026-08-27T00:12Z -- production, staging, the shared image digest AND the
revision name all re-read from this pass's own runs (33025393831 and
33024642622), from the step lists rather than the job conclusions.
PRODUCTION_REVISION is no longer not_verified: the name was read from the
deploy's own log line, which prints the revision and the image it runs
together.

CURRENT_MAIN:
bc82d41a532314e3b1a2f49356381d51d9af91d4  (#700)

READ THIS FIELD WITH SUSPICION, ALWAYS. It is hand-transcribed into a file that
travels through the same PR queue as everything else, so it is stale the moment
another PR merges -- and on an active day that is minutes, not days.

This release is the proof. A promotion of cb80cb32 was dispatched at 22:18Z and
its staging gate went red; while it was being re-verified, a parallel lane
merged #699 and #700. Because deploy-production refuses unless
`confirm_sha == github.sha`, cb80cb32 became unpromotable the moment main moved
-- not by policy but by mechanism. The release that actually shipped is
therefore bc82d41a, two commits past the one that was staged first.

The durable fix is to stop transcribing it: have a workflow step write
github.sha at dispatch time rather than a human or an agent typing it here.
Until that exists, `git log --oneline <this value>..origin/main` is the only
trustworthy answer to "what is on main", and this line is a hint about when the
file was last touched.

Unstaged on main as of this entry: none. main, staging and production are all
bc82d41a. #698 (clearance compare-and-swap) is open and green but deliberately
unmerged until this record lands, so that main did not move again mid-promotion.

RELEASE_CANDIDATE_SHA:
a830eae24fdec92ebdf325235716aeb9d54482f4  <-- FROZEN, SHIPPED 2026-08-25
25 commits past the previous production SHA 26519efd. This is the
backend/security + release-engineering lane — nine authorization fixes among
them, the tip being #633 (activation refuses the published starting PIN).
Contains NO visual or design-system change: `git diff 26519efd..a830eae2` shows
0 files under `design-system/` and 0 under `public/plates/`. Contains ZERO
schema-bearing files, so no migration was required (see the run record below).

PREVIOUS CANDIDATE, shipped 2026-08-24:
26519efd49d04b0f4b72779b921174567dd48ed0
Contained #596 #597 #599 #600 #601 #602 #603 #604 #605 and NO Grok corrective
UI work. #604 (production revision-truth) is the release-critical repair inside
it, and the traffic-wait step #604 added is what carried this release too.

STAGING_SHA:
bc82d41a532314e3b1a2f49356381d51d9af91d4  (deploy-staging run 33024642622,
success 2026-08-26T23:57:31Z -- read from the step list, not the job colour.)
Step 23 Run SHADOW E2E Gate: success, 23:53:22 -> 23:57:09, a real 3m47s of
execution rather than a short-circuit. Step 24 Guardian Contact Runtime Probe:
success. Step 25 Runtime Verification Ledger: success. Step 26 Deactivate Gate
Athlete Fixture: success. Step 27 Report Gate Athlete Fixture Still Live:
SKIPPED, which is its passing outcome -- its condition names always()
explicitly, so it is not subject to the inherited success() that makes a
bypassed safeguard look identical to a green one.

A RED GATE PRECEDED THIS ONE, AND IT WAS NOT THIS COMMIT'S FAULT. Run
33019214969 (cb80cb32, 22:18Z) failed at step 23 with

    Background Heavy Bag job f3b491be ended 'failed': SHADOW_AI_EMPTY_RESPONSE

thrown at shadowJobProcessor.ts:415 when the provider returns HTTP 200 with an
empty `content`. Three things establish it as provider nondeterminism rather
than a regression: the delta 8fde7170..cb80cb32 touches ZERO AI/SHADOW files
(shadowJobProcessor.ts last changed at 09f19e7b, before the prior release); step
13, the SYNCHRONOUS Heavy Bag, passed on that same run; and the next gate run
passed the identical step. The background job asks for
`max_completion_tokens: 4096` against a gpt-5-family reasoning deployment, where
reasoning tokens are spent from that same budget -- so an answer that reasons
too long returns empty. There is NO retry on that path. This will keep costing
gate cycles at random until it is fixed; it is logged as an open defect, not as
a flake to be waved through.

NOTE ON THAT RED RUN: deploy-staging deploys BEFORE it gates. Steps 14 and 16
had already put cb80cb32 live on staging and taken traffic by 22:24Z, so
staging ran an ungated revision for ~90 minutes under a red run. That is a
property of the workflow's step order, not of this release, and it is why
"the run was red" must never be read as "nothing was deployed".

STAGING_IMAGE_DIGEST:
sha256:080acbba443a29435e74626152daca1809522146d90e3321c698db98133cd226
Read from run 33024642622's own "Report Release Digest Last" step, which prints
it for use as deploy-production's release_digest input. It is the digest for
STAGING_SHA bc82d41a above, and it is the same digest production now serves --
promotion built nothing, so the two are byte-identical by construction rather
than by coincidence.

Superseded digests, kept only so nobody reaches for the wrong one:
  8fde7170 -> sha256:74588ad2501ab6e41d20a27ead0cb46920f7886a5d60fe7398261b2d4fd335be
  cb80cb32 -> sha256:03e89ff8ba28a60de820907a09f571633afe9be28624803019fdc9f4b24b3e2c  (RED GATE, never promoted)
  9830aa46 -> sha256:93397a55fba884d8cd84c376b09696eae3e97bf56bb4b05a9ddd7a1eb41f7a5b

PRODUCTION_SHA:
bc82d41a532314e3b1a2f49356381d51d9af91d4  <-- LIVE (2026-08-27T00:11:51Z)
deploy-production run 33025393831. Read from the STEP LIST, not the job colour;
every step ran, none skipped:
  - Verify supplied SHA matches the checked-out commit: success
  - Verify Production Schema Matches This Commit: success. This is the check
    that matters more than the operator's attestation -- it ran against the
    live production database and agreed that no migration was outstanding, so
    the CONFIRMED input was true rather than merely asserted. Independently:
    `git diff --name-only 8fde7170 bc82d41a -- 'infra/azure/**' 'migrations/**'`
    returns nothing.
  - Verify release digest exists in ACR and was built from this commit: success.
    Provenance, not just shape: it fetches the ACR manifest and asserts the tag
    list contains the confirm_sha, which is what catches a transposed
    SHA/digest pair.
  - Refuse a Rollback Nobody Asked For: success
  - Deploy Tested Digest to Azure Container App: success 00:11:31
  - Wait For Promoted Revision To Take Traffic: success 00:11:51 -- serving
  - Pilot API Smoke Checks: success, log reads "Production smoke checks passed."

Promoted on Jason's explicit approval, through the protected-environment gate:
the guard job completed at 00:01:34Z and build-and-deploy sat in `waiting` until
00:10:09Z, when Jason released it. The 8m35s gap is the human approval, and it
is the reason this record can say approved rather than assumed.

Previous: 8fde7170 (2026-08-26T21:04:36Z, run 33013124125).

WHAT THIS RELEASE CLOSES IN PRODUCTION. Seven P0 fixes that had been sitting on
main, plus two from a parallel lane:
  - #690 guardian deletion now clears active_flag, deactivates the
    organization membership and revokes sessions in the SAME transaction.
    Before this, deletion wrote deleted_at and nothing else, so a deleted
    guardian WOULD have kept reading their linked minor's records and WOULD
    have been able to mint a fresh session by emailing themselves a magic
    link, indefinitely.

    CORRECTED 2026-08-27, and the correction is the point of this file. The
    sentence above originally read "a 'deleted' guardian in production kept
    reading their linked minor's records" -- stated as a harm that was
    happening. That was never verified. What was verified is what the code
    does the first time somebody is deleted; whether anybody ever had been was
    not checked before it was written down here.

    The code says probably nobody. deleteGuardianAccount and
    deleteAthleteRecord have exactly ONE caller between them --
    DELETE /api/pilot/admin/data-deletion -- and nothing in app/ or
    components/ calls that endpoint. There is no button anywhere in the
    product, and no script or workflow calls it either. A deletion requires
    somebody hand-crafting an authenticated request against the live API.

    "Probably nobody" is still not a number, so check-database.yml now carries
    a read-only `deletion-preflight` check that counts the deletion audit
    rows and any record left marked-deleted-but-still-reachable. Until that
    has been run against production, the honest status of this entry is: the
    defect was real, the fix is correct, and the blast radius is UNMEASURED.
  - #695 approving an already-promoted intake case is refused -- a second
    promotion reset an activated athlete's PIN and revoked their sessions,
    locking them out in two clicks.
  - #693 the board's data boundary is now an explicit runtime allow-list
    (projectAnnouncementForBoard), not a TypeScript interface. TypeScript is
    erased at runtime, so the previous "boundary" shipped the fields it
    claimed to omit.
  - #691 scheduler registrations and attendance are filtered to athletes the
    coach can actually reach, not merely to classes they own.
  - #689 legacy `admin` role accepted where `organization_admin` was required
    on intake promotion.
  - #688 activation journey e2e coverage (the first browser test of the only
    path a new athlete has into the product).
  - #692 drill change-proposal lifecycle.
  - #699 / #700 seed-loader hardening: six loaders now refuse a missing
    PPBF_SEED_ORG_ID rather than defaulting to a hardcoded fixture
    organization. Landed by a parallel lane, reviewed here as diff only.

PRODUCTION_IMAGE_DIGEST:
sha256:080acbba443a29435e74626152daca1809522146d90e3321c698db98133cd226
The digest supplied as deploy-production's release_digest input, and the SAME
digest the staging gate verified -- deploy-production is promote-only and built
nothing, so what production serves is byte-identical to what run 33024642622
gated. Confirmed as built from bc82d41a by that run's own provenance step, not
inferred.

PRODUCTION_REVISION:
app-ppbf-production--0000141  <-- VERIFIED, not inferred.
Read from run 33025393831's own log line, which prints the revision and the
image it runs in one statement:

    Latest revision app-ppbf-production--0000141 runs image
    ***.azurecr.io/ppbf-frontend@sha256:080acbba443a29435e74626152daca1809522146d90e3321c698db98133cd226

That line is the evidence that the NAME and the DIGEST belong to each other --
which is the whole point of the field, and why the previous entry was left
not_verified rather than guessed. It then reached Running at 100% traffic on
the fourth poll (00:11:51Z), so this revision is serving, not merely created.

Previous: app-ppbf-production--0000137 (stale, belongs to the a830eae2 release).

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

HISTORICAL — this section is about the 2026-08-24 release (26519efd). The
2026-08-25 release (a830eae2) required NO migration: zero schema-bearing files
in the 25-commit delta, and the deploy's own schema check confirmed it against
the live production database. See the run record immediately below.

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

## PRODUCTION RUNTIME — VERIFIED LIVE (deploy-production run 32853286769)

Dispatched confirm_sha=a830eae24fdec92ebdf325235716aeb9d54482f4,
release_digest=sha256:921a3f77a2040f28715bba55862808a68d201a6c3a4969558c69ac63e69dd9c1,
migrations_complete=CONFIRMED, allow_rollback=NO. Both jobs conclusion=success;
build-and-deploy (job 97819120492) completed_at 2026-08-25T13:46:54Z. Every step
read individually, not inferred from the run colour.

The CONFIRMED attestation was checked BEFORE it was made: `git diff
26519efd..a830eae2` is 25 commits carrying ZERO schema-bearing files (no `.sql`,
no migration or schema path) and no new `pilot:apply-*` script in
`apps/web/package.json`. The workflow's own schema step then confirmed that
independently against the live production database. No apply-migrations run was
needed or dispatched for this release.

guard job — all success, in order: Verify running from main / Verify supplied SHA
matches the checked-out commit / Verify migration confirmation / Verify supplied
release digest format.

build-and-deploy — all success, in order:

- Resolve Production Resource Group: pass (the fail-closed refusal added in #604)
- Authenticate via Azure OIDC: pass
- Set up Node For The Schema Check / Install Locked Dependencies: pass
- Verify Production Schema Matches This Commit: pass (read-only, LIVE production
  database)
- Verify release digest exists in ACR and was built from this commit: pass
- Refuse a Rollback Nobody Asked For: pass
- Validate Production AI Configuration: pass
- Deploy Tested Digest to Azure Container App (Production): pass
- **Wait For Promoted Revision To Take Traffic: pass** — and it earned its place
  again. It asserted the digest ON the revision BEFORE waiting for traffic. Log:
    Latest revision app-ppbf-production--0000137 runs image
      ***.azurecr.io/ppbf-frontend@sha256:921a3f77a2040f28715bba55862808a68d201a6c3a4969558c69ac63e69dd9c1
      1: Activating 100
      2: Activating 100
      3: Activating 100
      4: Running 100   — 2026-08-25T13:46:48Z
  containerApp systemData.lastModifiedAt: 2026-08-25T13:46:14.656606Z.
- Resolve Production Base URL: pass
- Pilot API Smoke Checks: pass, AFTER the wait — "Production smoke checks
  passed." Run FROM THE GITHUB RUNNER against
  https://app-ppbf-production.purpledesert-3a75d580.eastus.azurecontainerapps.io:
  POST /api/pilot/auth/login {} expected 400, got 400; POST
  /api/pilot/auth/session {} expected 200, got 200; POST
  /api/pilot/shadow/events {} expected 401, got 401.

HONEST LIMIT ON THIS RECORD. Production was NOT probed from the Claude session
that wrote it. That session's egress policy denied CONNECT to the production
host — the agent proxy logged `gateway answered 403 to CONNECT (policy denial)`
— so every live-serving statement above is the GitHub runner's observation read
out of the run log, not a direct observation of production from the session. No
az read, no browser, no authenticated production journey on this release. The
three smoke probes are unauthenticated and would pass against the previous image
too; what ties a830eae2's image to the serving revision is the revision-digest
assertion inside the wait step, not the smoke checks.

WHAT SHIPPED: the backend/security + release-engineering lane, nine
authorization fixes among the 25 commits. NO visual/design-system files are in
it (`design-system/` 0 files, `public/plates/` 0 files), so nothing in this run
is evidence about the UI.

## PRODUCTION RUNTIME — PREVIOUS RELEASE 26519efd, SUPERSEDED 2026-08-25 (deploy-production run 32783211177)

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
- Reference-data seed: **DONE, and the open question is answered.** The
  dry-run (run 32787708007) found production's operational catalogs
  COMPLETELY EMPTY -- every loader reported "0 already present" -- then
  rolled back without writing. The apply (run 32788628209, mode=apply,
  confirm_seed='SEED REFERENCE DATA',
  seed_account_id=Admin@punxsyprominence.org, organization_id blank)
  completed success 23:25:48Z against ppbf-pg-195892, all four loaders PASS,
  inserting exactly what the dry-run rehearsed:

    drill_library 119, drill_scale_levels 357, drill_stop_rules 674,
    drill_cues 258 rows processed, disciplines 5, competence_levels 6,
    cohort_definitions 6, session_scripts 3, session_script_blocks 65,
    session_script_renderings 4

  Run summary: "Written. The loaders are idempotent -- re-running adds no
  duplicates." This is what moved production from deployed to USABLE: before
  it, a coach signing in would have found an empty drill library and no
  session scripts. NOT OBSERVED: an authenticated end-user read of these
  catalogs through the deployed app -- the evidence is loader output, not a
  browser.

## OWNER_GATES (historical — the release-blocking ones are cleared)

1. apply-migrations run 32774493452 — APPROVED and GREEN.
2. check-database seed-identity run 32770083477 — APPROVED and GREEN.
3. deploy-production run 32783211177 — APPROVED and GREEN. PRODUCTION LIVE.
4. seed-reference-data dry-run — approved and green (re-dispatched as run
   32787708007 after the original was cancelled as stale).
5. seed-reference-data APPLY run 32788628209 — APPROVED and GREEN.
   PRODUCTION REFERENCE DATA SEEDED. The release is complete.

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

- CONTINUE_BUILD merged since production: #607 #608 #609 #610 #611 #612
  #613 (see EVENT LOG for SHAs).
- Open, CI pending, merge on green: #614 (six remaining resource-group
  workflows fail closed), #615 (dead Session Duration input removed),
  #616 (admin "Get Code" labels -> "Get Starting PIN").
- HELD until #606 resolves: coach roster row click (selectedAthleteId is
  set on click and consumed only by the row's own highlight class --
  CoachWorkspace.tsx is mid-restore in Grok's lane; a main-side edit now
  would churn the file under them).
- Merged today (release phase): #601 #602 #603 #604 #605.
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

Done since the release: sparring claim (#612 merged), scheduler red (#609
merged), runtime ledger hard gate (#610 merged), provenance binding (#613
merged); resource-group workflows (#614), Session Duration input (#615) and
"Get Code" copy (#616) are open PRs merging on green.

Still deferred:
- Coach roster row click (held for #606 -- see CLAUDE_ACTIVE).
- #602 `path.relative` Windows separators (guard fails loud, not open; all
  CI is ubuntu-latest).
- UNKNOWN-method historical RPE rendering (measure production data first),
  track-assignments silent autosave, athlete "Messages 0" tile.
- FOR THE OWNER, not to be decided by an AI alone: training holds are not
  enforced at check-in/drill-assignment; SHADOW injects near-miss text into
  athlete/parent chats that `GET /near-misses` denies those roles.

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
- 2026-08-24T23:26Z | claude | production reference data seeded (drills 119, scale levels 357, stop rules 674, cues 258; disciplines 5, competence 6, cohorts 6; scripts 3, blocks 65, renderings 4) | run 32788628209
- 2026-08-24T22:59Z-23:22Z | claude | merged #607 #608 #609 | 0f803768 50536d57 2cf5117c (commit timestamps)
- 2026-08-25T00:15Z | claude | merged #611 (docs) | ad1d5f3e
- 2026-08-25T00:45Z | claude | merged #610 (runtime ledger gates) | 1df6d7c8
- 2026-08-25T01:04Z | claude | merged #612 (sparring claim honesty) and #613 (digest-to-SHA provenance) | 995e27f6, d1f39c52
- 2026-08-25T01:20Z | claude | opened #614 (six resource-group workflows fail closed) #615 (dead duration input) #616 ("Get Code" labels); all subscribed, merge on green | PRs
- 2026-08-25T01:25Z | claude | re-checked Grok #606: head 492f491d still -5739 lines, full workspace bodies still not in the PR; noted main moved under the packaged restore artifact | this file
- 2026-08-25T13:46Z | claude | PRODUCTION DEPLOYED at a830eae2: revision app-ppbf-production--0000137, digest asserted ON the revision as sha256:921a3f77… before the traffic wait, Running 100 at 13:46:48Z, runner smoke checks passed | run 32853286769
- 2026-08-25T14:35Z | claude | recorded that release in PRODUCTION_STATE.json (previous production record 26519efd carried to superseded_record_2026-08-25, not deleted) and in this file; production NOT probed from the recording session — egress policy denied CONNECT | this file
