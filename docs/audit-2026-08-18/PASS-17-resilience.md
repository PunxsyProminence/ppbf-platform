# Pass 17 — Resilience & failure behaviour

**Branch** `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main` at `04dd116b`.
Read-only. The only file this pass wrote is this one.

The question this pass was sent to answer: **when something fails, does a safety
gate fail closed or fail open?** A gate that throws into a permissive default is
worse than no gate, because the screen shows it as passed.

The short answer, before the detail, because it is not the answer the brief
anticipated: **this codebase fails closed far more often than it fails open, and
where it fails open it usually says so in a comment first.** Of 24 safety-relevant
checks traced end to end, **15 fail closed, 9 fail open** — and 4 of those 9 are
one narrowly-scoped, documented, SQLSTATE-keyed degradation (`42P01`, missing
table) that only bites an environment whose operator has not applied migrations.
The two that fail open on *any* error, silently, are the two worth acting on.

---

## Method

Counted, not estimated. Everything below is a `grep`/script measurement on the
pinned tree, excluding `node_modules`, `.next`, and `*.test.ts`/`*.spec.ts`.

| Measurement | Count |
|---|---|
| `catch` blocks in `apps/web/{src,app}`, `apps/research-bridge`, `scripts`, `packages` (non-test) | 717 |
| — of those, whose body contains no `throw` (i.e. swallows) | 668 |
| — of those swallowing, in `apps/web/src/server` | 43 |
| — of those swallowing, on a safety-relevant path (filename matches safety/hold/waiver/consent/clearance/escalat/guardian/medical/incident/parent/minor/auth/access/compliance/conduct/near-miss/risk/flag) | 81 |
| `?? true` occurrences in `src` + `app` | 5 |
| `\|\| true` occurrences | 0 |
| `?? []` occurrences in `src` + `app` | 173 |
| — of those in `src/server` | 28 |
| `withTransaction(` call sites (non-test) | 62, across 30 files |
| `for update` / `for share` sites (non-test) | 29, across 16 files |
| Server-side `fetch(` call sites | 11 |
| — with an `AbortSignal.timeout` / `AbortController` | 9 |
| — with **no** timeout | **2** |
| API routes (`app/api/**/route.ts`) | 228 |
| — declaring `maxDuration` | 1 |
| Screens (`app/**/page.tsx`) | 125 |
| — that `catch` but appear to render no error state (mechanical grep) | 14 candidates; 1 hand-checked and refuted as a false positive |

**Files deep-read (opened in full or in the relevant range): 38.** Named, so the
reach of this pass is auditable: `trainingHolds.ts`, `escalationLadder.ts`,
`safetyGateMatrix.ts`, `contactClearanceGate.ts`, `waiverCompliance.ts`,
`guardianConsent.ts`, `access.ts`, `safetyFlags.ts`, `safetyReview.ts`,
`compliance.ts`, `shadowMedicalStatus.ts`, `shadowRecommendations.ts`,
`shadowNearMisses.ts`, `formulas/painReportAlert.ts`, `formulas/engine.ts`,
`formulas/repository.ts`, `videoScanSweep.ts`, `videoScan.ts`,
`videoScanPolicy.ts`, `videoSessions.ts`, `blob.ts`, `publication.ts`,
`schedulerDb.ts`, `db.ts`, `rateLimit.ts`, `audit.ts`, `http.ts`,
`shadowJobQueue.ts`, `shadowJobProcessor.ts`, `shadowJobWorker.ts`,
`shadowConversations.ts`, `shadowChat.ts`, `shadowReadiness.ts`,
`shadowFilmStudyProposals.ts`, `graphMailer.ts`, `managedIdentityToken.ts`,
`magicLink.ts`, `instrumentation.ts`; plus 14 route files and 10 page files.

**What this pass did not reach**, stated plainly rather than papered over:

- **It ran no code.** Every claim below is source reading. Nothing was reproduced
  against a live database or a running worker.
- **It did not open 190 of the 228 routes.** Routes were selected by filename
  against the safety keyword list plus the `writePilotAuditEvent` census; the
  remainder were not read.
- **It did not read 106 of the 125 screens.** The mechanical "catches but renders
  no error state" grep was run over all 125, but only the safety-relevant hits
  were opened.
- **It could not establish deployment facts**: whether `PPBF_SHADOW_WORKER_ENABLED`
  is `true` in production, whether every migration has been applied to every live
  environment, and whether `maxDuration` is honoured by the `output: "standalone"`
  container. All three change the severity of findings below, in both directions.
- **It did not audit `apps/research-bridge`** beyond including it in the catch
  census.

**De-duplication.** Checked against `NETWORK_STATUS.md` (read from
`origin/docs/agent-handoff-briefs`), `PASS-02-authorization.md`,
`PASS-03-minors-consent.md`, `PASS-04-safety-gates.md`, the audit `README.md`
findings table (F-01…F-23), and `git log --oneline origin/main -40`. Findings
already recorded there are cited, not re-reported: the incident double-file fix
(#433), the external-call timeout sweep (#425), the three routes whose error
handling did not do what it looked like (#426), the six guarded audit writes
(#429), F-10 (`assertShadowAuthority` cannot deny), F-11 (Film Study consent
race), and F-03 (`/admin/safety-review` double-counting) are all **prior work**.
Two findings below are explicitly framed as *resilience extensions* of F-11 and
of the #433 class rather than as new discoveries.

---

## Does each safety gate fail closed or fail open?

The headline table. "Failure mode" is the specific thing that goes wrong;
"C/O" is closed or open. Rows marked **O** are enumerated as findings below.

| # | Gate / check | Failure mode | C/O | Evidence |
|---|---|---|---|---|
| 1 | Training-hold **STOP** at class registration | `42P01` on `pilot.training_holds` | **O** | `trainingHolds.ts:411-416` — `return null` |
| 2 | Training-hold STOP at class registration | any other DB error | C | same block rethrows; savepoint scoped |
| 3 | Guardian/athlete **hold display** (`/parent/safety`) | `42P01` | **O** | `trainingHolds.ts:304-309` → `parent/safety/page.tsx:149` |
| 4 | Staff **hold roster** + `/admin/safety-review` headline | `42P01` | **O** | `trainingHolds.ts:353-358` — `return []` |
| 5 | **Contact-during-hold** near miss (`flagContactDuringHold`) | `42P01` | **O** | `trainingHolds.ts:464-469` — `return { flagged: false }` |
| 6 | Hold **placement** + its escalation | any error | C | one `withTransaction`, `trainingHolds.ts:156-229` |
| 7 | Hold **lift** | raced / stale request | C | guarded `UPDATE … and status = 'active'`, retry-safe |
| 8 | **Contact medical-clearance gate** | any error | C | runs before persist; `observations/route.ts:122-135` |
| 9 | **Medical clearance** read (`assertMedicalStatusAllowsRecommendation`) | no record / `pending` / DB error | C | `shadowRecommendations.ts:48-52` |
| 10 | Medical clearance read | two concurrent writes | **O (narrow)** | `shadowMedicalStatus.ts:80` — `order by effective_at desc` with no tiebreaker |
| 11 | **Guardian media consent** (`assertGuardianMediaConsent…WithClient`) | no guardians / DB error | C | `guardianConsent.ts:161-166`, `for share` lock |
| 12 | **Waiver compliance** rollup | missing rows | C | `waiverCompliance.ts:70` — defaults every type to `'missing'` |
| 13 | **Safety-flag resolve / bypass** | raced request | C | guarded `UPDATE … and status = 'open'`, `safetyFlags.ts:213-217` |
| 14 | Safety-flag resolve — **audit trail** | audit write fails | **partial** | `safety-flags/route.ts:127` unguarded; the bypass has already committed |
| 15 | **Escalation** acknowledge / resolve | raced / stale | C | status predicate on the `UPDATE`, `escalationLadder.ts:379-400` |
| 16 | **Incident** filing | sequential retry | C | atomic `INSERT … WHERE NOT EXISTS` (#433), `escalationLadder.ts:255-266` |
| 17 | **Pain-report** near miss + escalation | request retry | **O** | `painReportAlert.ts:121` — no dedup, unlike the contact gate |
| 18 | **Video scan** promotion | unrecognised tag / storage error | C | `videoScan.ts:87-109`; only an affirmative pass promotes |
| 19 | **Video scan → safety escalation** | any error at filing | **O** | `videoScanSweep.ts:170-186`; the row is already non-reclaimable |
| 20 | **SHADOW async safety-review ticket** | any error, twice | **O** | `shadowJobProcessor.ts:321-332` — `console.error` and continue |
| 21 | **Job authorization** re-validation on claim | any error | C | throws → `failJob`; `shadowJobProcessor.ts:171-179` |
| 22 | **Athlete-scope asserts** (`assertActorCanAccessAthlete`, `accessibleAthleteIds`, `actorCanAccessJob`) | any error incl. `42P01` on `coach_coverage` | C | `access.ts:74-85`, `access.ts:381-389`, `shadowJobQueue.ts:194-198` |
| 23 | **Client role gate** (`RoleSessionGate`) | session fetch fails | C | `RoleSessionGate.tsx:94-99` → `'retryable'`, children not rendered |
| 24 | **Auth rate limiter** | durable store unreachable | **O (deliberate)** | `rateLimit.ts:56-66`, `rateLimit.ts:279` |

Plus one row that is neither: **`assertShadowAuthority` cannot deny at any call
site** — already recorded as F-10 by pass 4. A check that never refuses cannot
fail open or closed; it is a logger.

**Count: 15 closed, 9 open.** Of the 9, four (rows 1, 3, 4, 5) are the same
`42P01` degradation; one (10) needs two writes inside one another's transaction
window; one (24) is a recorded product decision. **Two — rows 19 and 20 — fail
open on any error, silently, with no reconciliation path.** Row 17 is a
double-write rather than a fail-open, and belongs to the #433 class.

---

## Non-transactional multi-step safety writes

The brief named the shape: "an athlete linked but consent not recorded, a hold
created but its escalation not filed". Traced across all 62 `withTransaction`
sites and all 6 `fileEscalation` call paths.

**The named case does not occur.** Every state-owning safety insert that has a
dependent alarm pairs them in one transaction, and each says so:

| Pair | Transactional? | Evidence |
|---|---|---|
| hold insert + `training_hold` escalation | **yes** | `trainingHolds.ts:156` — one `withTransaction`; header: *"Every placement files a 'training_hold' escalation IN THE SAME TRANSACTION"* |
| near miss + auto-escalation (high/critical) | **yes** | `shadowNearMisses.ts:45-101`, `fileEscalation(…, client)` |
| compliance violation + its escalation | **yes** | `compliance.ts:183`, header: *"Runs on the same transaction client as the violation insert"* |
| medical status insert + shadow audit entry | **yes** | `shadowMedicalStatus.ts:33-60` |
| magic-link claim + session mint | **yes** | `magicLinkStore.ts` — *"Redeems a link and mints a session, in ONE transaction"* |
| class registration: hold probe + duplicate check + capacity + insert | **yes** | `schedulerDb.ts:202-280`, `for update` on the class row |
| publication retraction + research-library suppression | **yes** | `publication.ts:363-396`, `for update` on `guardian_links` |

The genuinely non-transactional multi-step safety writes are these five, in
descending order of how much it matters:

1. **`settleVideoSessionScan` → `fileEscalation`** (`videoScanSweep.ts:145-186`).
   The scan verdict is committed first, the escalation second, outside any
   transaction. Finding [HIGH] below.
2. **`resolveSafetyFlag` → `writePilotAuditEvent`** (`safety-flags/route.ts:117-131`).
   The flag bypass commits; the forensic record can be lost. Finding [MEDIUM].
3. **`withdrawMediaConsent` → `suppressPublishedMediaForAthlete`**
   (`parent/consent/route.ts:168-233`). Deliberately non-transactional and
   **correctly handled** — see "Checked and found sound".
4. **`flagNearMiss` → `emitShadowEvent`** (`painReportAlert.ts:121-157`). The near
   miss and escalation commit; the coach-feed event does not, and the request
   then 500s before the observation is written. Finding [MEDIUM] below (the
   retry is the problem, not the split).
5. **`completeJob` → `queueHumanReview`** (`shadowJobProcessor.ts:293-332`). Job
   completes, review ticket may not. Finding [MEDIUM].

**Audit-write census.** 88 routes call `writePilotAuditEvent`. Only 10 wrap it in
the "non-fatal audit" guard that #429 introduced — `parent/consent/route.ts:22`,
`training-holds/route.ts` (`auditHoldEvent`), `admin/video-compliance/route.ts:26`,
`compliance/violations/route.ts:25`, plus 6 auth/payment/publication routes. In
the other 78, a failed audit write turns a **committed** domain write into a 500
the caller reads as "it did not happen". On a safety route this is the wrong lie
in the wrong direction — see finding [MEDIUM] on `/api/pilot/safety-flags`.

---

## Timeouts, retries and double-writes

### Timeouts

| Outbound call | Timeout | Where |
|---|---|---|
| Azure AI chat completions (job processor) | 120 s | `shadowJobProcessor.ts:387` |
| Azure AI chat completions (Heavy Bag, sync) | per-model | `shadowHeavyBag.ts:134` |
| Azure AI vision (Film Study / content screen) | `VISION_TIMEOUT_MS` | `shadowFilmStudy.ts:218` |
| Azure AI embeddings | `EMBEDDING_TIMEOUT_MS` | `shadowEmbeddings.ts:42-49` |
| Stripe token exchange | `STRIPE_NETWORK_TIMEOUT_MS` | `paymentConnect.ts:154` |
| Microsoft OIDC discovery / token / JWKS | `OIDC_NETWORK_TIMEOUT_MS` | `federatedAuth.ts:86,151,275` |
| SharePoint upload, AAD token, Dataverse write | yes | `document-intake/*` |
| **Microsoft Graph `sendMail`** | **none** | `graphMailer.ts:139` |
| **Azure IMDS managed-identity token** | **none** | `managedIdentityToken.ts:85` |
| **Postgres (every query in the platform)** | **none** | `db.ts:67-71` |
| Azure Blob (`downloadToBuffer`, `getProperties`, `uploadData`, `getTags`) | none (retries only) | `blob.ts` |

PR #425 ("Bound the external calls that had no timeout at all") touched six
files: `document-intake/{auth,dataverse,googleDrive,sharepoint}.ts`,
`federatedAuth.ts`, `paymentConnect.ts`. It did not reach `graphMailer.ts` or
`managedIdentityToken.ts`, which are the two remaining unbounded HTTP calls, and
both sit on the guardian sign-in path. Findings [MEDIUM] below.

The database is the largest hole and is not an HTTP call, which is presumably why
the sweep missed it: `new Pool({ connectionString, ssl, max: 10 })` sets no
`connectionTimeoutMillis`, no `idleTimeoutMillis`, no `query_timeout`, and issues
no `SET statement_timeout`. `grep -rn "statement_timeout\|connectionTimeoutMillis\|query_timeout\|lock_timeout"` across `apps/web`, `infra`, and `scripts` returns exactly one hit — a comment
saying the setting is absent. Finding [MEDIUM] below.

### Retries, and whether a retry can double-write

Only three retry mechanisms exist. There are **no in-request retry loops** other
than the two-attempt `queueHumanReview` block.

| Mechanism | Double-write risk | Verdict |
|---|---|---|
| Job lease expiry → `stale_running` re-claim (`shadowJobQueue.ts:329-355`), `max_retries` default 3 | Heavy Bag conversation append is keyed on `job.jobId` (`shadowJobProcessor.ts:243-247`); Film Study proposal is `on conflict (job_id) do update` (`shadowFilmStudyProposals.ts:83-84`) | **closed** for rows — but re-runs the *external egress*, see [HIGH] below |
| Video scan attempt backoff (`videoSessions.ts:294`) | The claim CTE only matches `scan_state in ('pending','scanning')`; a terminal verdict is never re-claimed | no double-write, but **no re-attempt of the escalation** either — see [HIGH] |
| User re-submitting a form after a 500 | Incident reports deduped (#433); contact-without-clearance deduped (`contactClearanceGate.ts:180-187`); contact-during-hold deduped (`trainingHolds.ts:475-482`); **pain reports not deduped** | one gap — see [MEDIUM] |

