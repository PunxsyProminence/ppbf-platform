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

---

## Findings

Nine findings. No CRITICAL: severity CRITICAL was reserved, per the brief, for a
failure that makes a safety gate permissive **for a real child**, and none of the
nine clears that bar on this tree. Two get within one deployment fact of it, and
that fact is named.

### [HIGH] A blocked video of a child files its safety escalation exactly once, and if that write fails the escalation is lost forever

**What is wrong.** `sweepQuarantinedVideos` settles the scan verdict on the row
*first*, then files the escalation. The settle writes `scan_state` to `'blocked'`,
`'infected'` or `'needs_human_review'`. `claimNextVideoSessionForScan` only matches
`scan_state = 'pending'` or a stale `'scanning'`. So the row can never be
re-claimed, and the escalation can never be re-attempted. The code's own comment
asserts the opposite.

**Verbatim, `apps/web/src/server/pilot/videoScanSweep.ts:159-164`:**

```
    // swallowed: a safety escalation failing to file silently is exactly the
    // kind of gap this closes, so a filing failure surfaces through the
    // worker's onError log and the sweep tick retries, rather than looking
    // like it succeeded. The row itself is already durably settled by this
    // point, so a failure here costs a delayed escalation, never data loss.
```

The claim predicate that makes "the sweep tick retries" false,
`apps/web/src/server/pilot/videoSessions.ts:158-162`:

```
       where status = 'quarantined'
         and (
           (scan_state = 'pending' and scan_next_attempt_at <= now())
           or (scan_state = 'scanning' and scan_claimed_at < now() - ($1::int * interval '1 second'))
         )
```

And the state the settle has already written,
`apps/web/src/server/pilot/videoScanPolicy.ts:205-210`:

```
    case 'infected':
      return 'infected';
    case 'blocked':
      return 'blocked';
    case 'needs_human_review':
      return 'needs_human_review';
```

**Refutation attempted, four ways, three failed:**

1. *Does another writer file `source_type: 'video_scan'`?* No.
   `grep -rn "'video_scan'"` over `src` and `app` returns four hits: the union
   declaration (`escalationLadder.ts:29`), two comments, and this one filer
   (`videoScanSweep.ts:173`). `videoScanSweep.ts:44` says so itself: *"this is the
   only filer for source_type 'video_scan'"*. **Refutation failed.**
2. *Is there a reconciliation sweep that finds terminal-negative videos with no
   escalation?* No such query exists anywhere in the tree. **Refutation failed.**
3. *Does the escalation throw at all in practice?* `fileEscalation` opens its own
   `withTransaction` and inserts into `pilot.safety_escalations`, whose
   `athlete_id` is NOT NULL with an FK to `pilot.athletes` — the guard at
   `videoScanSweep.ts:170` already skips a null `athlete_id`, so the FK is not
   the likely trigger. A connection blip, a pool timeout, or an org row deleted
   mid-sweep would be. Low probability, not zero. **Refutation partially
   succeeded** — this is why the severity is HIGH and not CRITICAL.
4. *Does the sweep run at all?* Only from `instrumentation.ts:48`, only when
   `PPBF_SHADOW_WORKER_ENABLED === 'true'` (`shadowJobWorker.ts:28`). If the
   worker is off in production the whole path is dead and this finding is
   theoretical. **This is the one thing that would refute it outright, and this
   pass could not establish it** — it is the same open question pass 3 recorded
   and pass 8 owns.

**Consequence for a child.** A video of a minor that Microsoft's content screen
affirmatively refused (`decision: 'blocked'`, escalation severity `'critical'`) is
held at `status = 'quarantined'` — so it is not distributable, which is the
important protection and it holds. What is lost is that anybody is *told*. The
escalation ladder is, by `escalationLadder.ts:11-13`, the only notification
mechanism this platform has: *"There is no notification channel in this platform
(no email, ever), so this table and the /admin/escalations page that reads it ARE
the escalation mechanism."* A refused video of a child sits in one filtered list
that nobody is prompted to open, permanently, after a single transient database
error.

---

### [HIGH] A job retried after a lease expiry re-sends a child's video frames to the external vision service, with consent checked only at the original enqueue

**What is wrong.** This is a resilience extension of **F-11** (pass 3: Film Study
checks guardian consent at enqueue and never again). F-11 describes the *timing*
gap. What this pass adds is the *multiplier*: the retry machinery re-executes the
egress up to `max_retries` times, each triggered by infrastructure trouble long
after the consent check.

`executeFilmStudyJob` downloads the child's video and sends frames to Azure AI
before persisting anything:

**`apps/web/src/server/pilot/shadowJobProcessor.ts:900-905`:**

```
    const videoBytes = await downloadPilotVideoFile(context.blobPath);
    const clipPath = path.join(workDir, 'source-clip');
    await fs.writeFile(clipPath, videoBytes);

    const extraction = await extractFrames({ clipPath, directory: workDir });
```

If the worker dies, or the 300-second lease lapses (which the provider's own
120-second timeout plus frame extraction can approach), the job returns to
`'pending'` and is claimed again:

**`apps/web/src/server/pilot/shadowJobQueue.ts:329-336`:**

```
     stale_running AS (
       UPDATE pilot.shadow_jobs
       SET status = CASE
             WHEN retry_count + 1 >= max_retries THEN 'failed'
             ELSE 'pending'
           END,
           retry_count = retry_count + 1,
```

`max_retries` is `3` by default (`shadowJobQueue.ts:244`, and
`infra/azure/pilot_slice_postgres.sql:995` — `max_retries integer not null default 3`),
and the job TTL default is 24 hours (`normalizeJobTtlHours`). So up to three
separate vision-service calls on a minor's footage, spread over a day.

**Refutation attempted:**

1. *Does the retry create duplicate proposal rows?* No — `createFilmStudyProposal`
   is idempotent on `job_id`:
   `shadowFilmStudyProposals.ts:83-84` — `on conflict (job_id) where job_id is not null / do update set updated_at = now()`.
   **This half of the concern is refuted**, and the finding is narrowed
   accordingly: the defect is the repeated *egress*, not a duplicated record.
2. *Does the re-execution re-check consent?* `processNextShadowJob` re-validates
   the enqueuing actor (`loadCurrentJobActor`) and the actor's athlete scope
   (`assertActorCanAccessAthlete`), and `executeFilmStudyJob` re-checks the
   actor's *role*. None of these is a guardian-consent check. **Refutation
   failed** — this is exactly F-11's mechanism, reached a second and third time.
3. *Does the consent-withdrawal sweep cancel the job?* `suppressPublishedMediaForAthlete`
   (`publication.ts:357-397`) touches `video_publications` and
   `research_library`. It does not read or update `pilot.shadow_jobs`.
   **Refutation failed** — same as F-11.

**Consequence for a child.** A guardian withdraws consent, is truthfully told
published media was retracted, and their child's face is sent to an external
vision service — not once, as F-11 describes, but on each of up to three retries
over the following 24 hours, each retry triggered by a worker restart or a slow
provider rather than by anyone's decision.

---

### [MEDIUM] A safety-flag bypass commits and its forensic record can be lost, while the coach is told the action failed

**What is wrong.** `PATCH /api/pilot/safety-flags` resolves the flag — which
includes `status: 'bypassed'` — and *then* writes the audit event, unguarded and
outside any transaction.

**Verbatim, `apps/web/app/api/pilot/safety-flags/route.ts:117-131`:**

```
    const resolved = await resolveSafetyFlag({
      organizationId: principal.organizationId,
      flagId: body.flag_id,
      status: body.status,
      resolution: body.resolution,
      coachNote: body.coach_note.trim(),
      resolvedByAccountId: principal.accountId,
      resolvedByRole: principal.role,
    });

    await writePilotAuditEvent({
      event_type: 'update',
```

`writePilotAuditEvent` throws on failure — and it is three writes, not one
(`audit.ts:21`, `:41` `emitShadowEvent`, `:54` `writeShadowTelemetryEvent`), none
of which swallows. Any of the three failing produces a 500 from a request whose
safety-relevant write already committed.

**Refutation attempted:**

1. *Does the route wrap it?* No. The sibling routes that handle the *same* risk do:
   `parent/consent/route.ts:22` defines `auditConsentEvent` and its comment states
   the doctrine — *"A lost audit row must not tell a guardian their consent
   decision failed when it in fact committed -- same non-fatal-audit doctrine as
   training-holds' auditHoldEvent and video-compliance's auditComplianceEvent."*
   `training-holds/route.ts` uses `auditHoldEvent` at both the place and the lift
   path. `/api/pilot/safety-flags` uses neither. **Refutation failed**, and the
   contrast is what makes this a miss rather than a trade-off.
2. *Is the write itself at risk of being repeated?* No — `resolveSafetyFlag`'s
   `UPDATE` carries `and status = 'open'` (`safetyFlags.ts:216`), so a retry
   returns a 409 `SAFETY_FLAG_NOT_FOUND_OR_NOT_OPEN` rather than re-resolving.
   **Refutation succeeded on the retry half**; the audit-loss half stands.
3. *Is the flag class protected?* `external_rule` flags cannot be bypassed
   (`safetyFlags.ts:205-210`, database-constraint backed). But `flag_class` is
   supplied by whoever raises the flag, as pass 2 already recorded.

**Consequence for a child.** Pass 2's F-20 established that any coach can bypass
an open flag on any child, including `concussion_rest_period`. This finding is the
resilience half of that: on the one path where the audit event is the only record
of who cleared it, the audit event is the part that can be lost, and the coach who
did it is shown a 500 — so the action is invisible to the register *and* to the
person who performed it. 78 of 88 audit-writing routes share this shape; this is
the one where it lands on a child's safety record.

---

### [MEDIUM] A retried pain report files a second near miss and a second escalation — the #433 class, on the one path that was not fixed

**What is wrong.** `POST /api/pilot/shadow/formulas/observations` deliberately
raises the alarm *before* persisting the observation, so that a failure aborts
loudly. The observation write is idempotency-keyed; the alarm is not. Two of the
three alarm paths on that route dedup first. The pain-report path does not.

**Deduped — `apps/web/src/server/pilot/contactClearanceGate.ts:180-188`:**

```
  const alreadyFlagged = await findNearMissByTriggerContext(
    input.organizationId,
    input.athleteId,
    NEAR_MISS_TRIGGER,
    input.contextId,
  );

  if (!alreadyFlagged) {
    await flagNearMiss({
```

**Not deduped — `apps/web/src/server/pilot/formulas/painReportAlert.ts:118-121`:**

```
  const value = input.value as number;
  const severity = severityForPain(value);

  await flagNearMiss({
```

`flagNearMiss` files an auto-escalation in the same transaction whenever severity
is `high` or `critical` (`shadowNearMisses.ts:83-101`,
`shouldAutoEscalateNearMiss`). Anything after it in the request can fail —
`emitShadowEvent` at `painReportAlert.ts:138`, `saveFormulaObservation` at
`observations/route.ts:172`, or the response being dropped on the way back — and
the athlete's natural response is to submit again.

**Refutation attempted:**

1. *Is there a unique index or constraint on `shadow_near_misses`?* No partial
   unique index appears in the DDL for this table; the codebase's own dedup
   mechanism for this table is the application-level
   `findNearMissByTriggerContext`, which is exactly what this path skips.
   **Refutation failed.**
2. *Does the escalation ladder dedup on its own?* `fileEscalation` does not; only
   `fileIncidentReport` has a dedup window, and it is scoped to
   `source_type = 'incident'` (`escalationLadder.ts:259`). Near-miss escalations
   go through the plain `insertEscalation`. **Refutation failed.**
3. *Does anything downstream collapse duplicates?* The opposite —
   `detectRepeatedPatternEscalations` groups by `athlete_id` plus
   `metadata->>'trigger'` with a default threshold of 3
   (`escalationLadder.ts:453`, `:490-495`). `contactClearanceGate.ts:171-179`
   documents this exact hazard for its own path: *"three rows with the same
   trigger then read as a 'repeated pattern' to the detector, which is supposed
   to mean repeated SESSIONS."* **Refutation failed, and inverted into a second
   consequence.**

**Consequence for a child.** A child in pain taps submit twice because the first
attempt errored. Their file now shows two pain reports and two open escalations
for one instance of pain — and with one genuine earlier report, three rows with
the same trigger, which files a *fourth* escalation claiming a repeated pattern
that does not exist. An admin triaging the queue sees a child who reports pain
constantly. Pass 4's F-03 found `/admin/safety-review` double-counting by a
different mechanism; this is a second, independent way the same screen inflates
the same child.

---

### [MEDIUM] The database is the one outbound call with no timeout, and the pool has no connection timeout either

**What is wrong.** Every external HTTP call in this platform is bounded except
two (below). The database — which every safety gate reads through — is bounded by
nothing.

**Verbatim, `apps/web/src/server/pilot/db.ts:67-71`:**

```
    pool = new Pool({
      connectionString: getAzurePostgresConnectionString(),
      ssl: resolveSslConfig(),
      max: 10,
    });
```

No `connectionTimeoutMillis`, no `idleTimeoutMillis`, no `query_timeout`. No
`SET statement_timeout` anywhere: `grep -rn "statement_timeout\|connectionTimeoutMillis\|query_timeout\|lock_timeout"` over `apps/web`, `infra` and
`scripts` returns exactly one line, and it is a comment noting the absence.

**The codebase already knows. `apps/web/src/server/pilot/omegaPlatformContext.ts:154-157`:**

```
 * entire pool and every other in-flight request -- athlete check-ins, coach
 * reviews, session lookups -- queues behind a single Omega turn. pg queues
 * rather than rejecting and the pool sets no connectionTimeoutMillis, so this
 * degrades as unexplained latency instead of a visible error.
```

**Refutation attempted:**

1. *Is there a request-level timeout that would bound it anyway?* One of 228
   routes declares `maxDuration` (`shadow/jobs/process/route.ts:23`, value 60).
   `next.config.ts` sets `output: "standalone"` — and `maxDuration` is a
   serverless-platform directive, so whether it is honoured in this container
   deployment **this pass could not establish**. For the other 227 routes the
   question does not arise.
2. *Does pool exhaustion make a gate permissive?* No, and this is the reason the
   severity is MEDIUM. A stuck `getPool().connect()` means the request hangs; a
   hung registration request does not register a held athlete, and a hung safety
   screen renders "Loading…" rather than "no problems". **Refutation partially
   succeeded**: this is an availability defect, not a fail-open.
3. *Is `max: 10` documented as sufficient?* `GYM_ROLLUP_CONCURRENCY = 3` exists
   specifically to stop one Omega turn eating the pool, which is a mitigation for
   one known consumer, not for the general case.

**Consequence for a child.** During a database incident, the guardian-facing
`/parent/safety` page and the coach-facing hold roster do not show wrong
information — they show nothing, indefinitely, with no error and no bound. A
guardian trying to find out whether their child is cleared to spar tonight waits
on a spinner that never resolves.

---

### [MEDIUM] Two outbound calls still have no timeout, and both sit on the guardian sign-in path

**What is wrong.** PR #425 bounded six files' worth of external calls. Two
remain, and they are the pair the magic-link flow depends on — the credential
guardians use, per `AUTH_CONTRACT.md`'s `requiredCredentialFor`.

**`apps/web/src/server/pilot/graphMailer.ts:139-144` — Microsoft Graph `sendMail`, no `signal`:**

```
  const response = await dependencies.fetchImpl(GRAPH_SEND_MAIL_URL(config.sender), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
```

**`apps/web/src/server/pilot/managedIdentityToken.ts:85-88` — the IMDS token fetch, no `signal`:**

```
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-IDENTITY-HEADER': identityHeader },
    });
```

`fetchImpl` is the real global `fetch` in production —
`magicLinkStore.ts:66-69` — so neither is bounded by an injected stub.

And the ordering compounds it. **`apps/web/src/server/pilot/magicLink.ts:128-148`:**

```
  await dependencies.invalidateLiveTokens(account.account_id);

  const token = dependencies.createToken();
  const expiresAt = new Date(dependencies.now().getTime() + MAGIC_LINK_LIFETIME_MS);

  await dependencies.storeToken({
```
…and only then `await dependencies.sendMail({`.

**Refutation attempted:**

1. *Does `managedIdentityToken` at least fail fast because the endpoint is
   link-local?* Its own comment says *"The endpoint is link-local. A network
   failure here means the platform, not the internet."* A link-local endpoint that
   accepts a connection and never answers still hangs; the comment addresses
   *unreachable*, not *unresponsive*. **Refutation failed.**
2. *Is there an upstream bound?* See the previous finding — no `maxDuration` on
   this route, and no global request timeout in `next.config.ts`.
   **Refutation failed.**
3. *Does the invalidate-then-send ordering actually cost anything?* Yes, and it is
   deliberate for a good reason (`magicLink.ts:126-128`: three working credentials
   in an inbox is worse). But the consequence when the send hangs is that the
   guardian's previously-working link has already been killed and the replacement
   was never delivered. **Refutation failed.**

**Consequence for a child.** A guardian who needs to reach `/parent/safety` or
`/parent/consent` — to see whether their child's training is paused, or to
withdraw media consent — requests a sign-in link. Graph hangs. Their old link is
already dead, the new one never arrives, and the request never returns an error
they can act on. The one credential a guardian has is the one with no timeout on
either of its two dependencies.

---

### [MEDIUM] The async safety-review ticket for a filtered SHADOW answer is dropped to a log line after two attempts

**What is wrong.** When a background SHADOW answer trips the post-generation
safety boundary, the answer has *already* been appended to the conversation and
the job has *already* been marked completed. The review ticket that puts it in
front of a human is attempted twice and then abandoned.

**Verbatim, `apps/web/src/server/pilot/shadowJobProcessor.ts:321-332`:**

```
      try {
        await queueHumanReview(reviewTicket);
      } catch {
        try {
          await queueHumanReview(reviewTicket);
        } catch {
          console.error('SHADOW async human-review queue write failed twice', {
            jobId: job.jobId,
            jobType: job.jobType,
          });
        }
      }
```

**Refutation attempted:**

1. *Is the reasoning sound?* Partly, and the comment above it is honest about the
   trade — `shadowJobProcessor.ts:316-320`: *"The job is already completed above,
   so a throw here would route to failJob against a completed row… (The
   synchronous path can fail its request closed; this path cannot without
   reordering completion, which would let a re-claim duplicate the already-
   appended answer.)"* The constraint is real. **Refutation partially succeeded**
   — this is a considered trade-off, not an oversight.
2. *Is there a reconciliation?* No. `shadow_jobs` carries
   `safety_status = 'filtered'`, and nothing anywhere queries for completed
   filtered jobs lacking a review row. `listHumanReviews`
   (`shadowConversations.ts:837`) reads the queue only.
   `purgeTerminalShadowJobs` deletes terminal job rows after 30 days
   (`shadowJobQueue.ts:273-282`), so the evidence that a ticket was owed
   eventually disappears too. **Refutation failed.**
3. *Is the insert likely to fail twice?* `pilot.shadow_human_review_queue` has no
   `category` check constraint (`infra/azure/pilot_slice_postgres.sql:927`), the
   `severity` value `'high'` is inside the allowed set, and `conversation_id` is
   passed as null. So the plausible cause is a connection-level failure — and if
   the connection were down, `completeJob` immediately above would also have
   failed. **Refutation largely succeeded**, which is why this is MEDIUM and not
   HIGH. The residual window is a transient failure landing between the two
   statements, twice.

**Consequence for a child.** A background SHADOW answer about a child — an
intensity or return-to-contact question — is withheld and replaced by the safety
boundary, the coach sees the replacement, and no reviewer is ever told the
boundary fired. The false-positive learning signal that `safetyFlags.ts`'s own
header calls load-bearing is lost, and there is no way to find out later that it
was owed.

---

### [MEDIUM] Four hold checks fail open on a missing table, including the one sentence a guardian reads

**What is wrong.** Four reads of `pilot.training_holds` catch SQLSTATE `42P01`
(undefined table) and return the permissive answer. This is deliberate, scoped to
one SQLSTATE, and documented at each site — which is why it is one MEDIUM finding
rather than four. It is reported because the *guardian-facing consequence* is not
documented anywhere: the degradation is described in terms of "does not 500", not
in terms of what the parent is then told.

**The enforcement read, `apps/web/src/server/pilot/trainingHolds.ts:411-416`:**

```
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P01') {
      throw error;
    }
    return null;
  }
```

**The guardian/athlete read, `apps/web/src/server/pilot/trainingHolds.ts:304-309`:**

```
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    return null;
  }
```

**The staff roster, `apps/web/src/server/pilot/trainingHolds.ts:353-358`** —
`return []`, on the read whose own header (`:332-335`) says *"this is the surface
a coach or admin reads to answer 'is this child protected right now'"*.

**The contact-during-hold alarm, `apps/web/src/server/pilot/trainingHolds.ts:464-469`**
— `return { flagged: false }`.

And what the guardian is shown when `getActiveTrainingHold` returns null,
**`apps/web/app/parent/safety/page.tsx:149`:**

```
                    <p className="t-body mt-[var(--s3)] text-[color:var(--bone-400)]">No training pause on file right now.</p>
```

A 200 OK, no error banner, an affirmative statement of fact.

**Refutation attempted, and it substantially succeeded:**

1. *Is the catch broad?* No. It keys on exactly `42P01` and rethrows everything
   else, including connection errors, permission errors, and syntax errors. The
   in-transaction variant even wraps the probe in `SAVEPOINT training_hold_probe`
   so a missing table cannot poison the enclosing registration transaction
   (`trainingHolds.ts:395-406`). This is careful work. **Refutation succeeded on
   breadth.**
2. *Can the table actually be missing?* `create table if not exists pilot.training_holds`
   appears in **both** `infra/azure/pilot_slice_postgres.sql` (the base schema)
   and `pilot_slice_postgres_training_holds_migration.sql`. So a live environment
   provisioned from the base schema has it. Migrations are operator-applied —
   `access.ts:75` states the premise: *"Migrations are operator-applied
   (guardrails section 7), so this code legitimately runs against databases the
   coach_coverage migration has not reached yet"* — and there is no boot-time
   migration, so a partially-migrated environment is possible but is not the
   default. **Refutation largely succeeded**, and is why this is MEDIUM, not
   CRITICAL.
3. *Does `placeTrainingHold` share the weakness?* No — deliberately not.
   `trainingHolds.ts:105-107`: *"Deliberately does NOT swallow a missing-table
   error itself: called inside a write transaction (placeTrainingHold), a missing
   table should fail that write outright."* **Refutation succeeded.**

**Consequence for a child.** In an environment where `pilot.training_holds` is not
present — a fresh gym provisioned by a partial migration run, a schema rename, a
`search_path` misconfiguration — a guardian is told in plain words that there is
no pause on their child's training, `/admin/safety-review` reports zero open
holds, class registration proceeds, and contact logged during a hold raises
nothing. Four surfaces agree, confidently, and all four are wrong in the same
direction. Nothing anywhere tells an operator the table is missing.

---

### [LOW] Two coaches setting medical clearance at once can leave the permissive value winning

**What is wrong.** `pilot.shadow_medical_administrative_status` is append-only and
"current" is resolved by `order by effective_at desc limit 1` with no tiebreaker.
`effective_at` defaults to `now()`, and the insert runs inside `withTransaction`,
so `now()` is the **transaction start** time, not the commit time.

**Verbatim, `apps/web/src/server/pilot/shadowMedicalStatus.ts:77-82`:**

```
    `select status_id, organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at, created_at
     from pilot.shadow_medical_administrative_status
     where organization_id = $1 and athlete_id = $2
     order by effective_at desc
     limit 1`,
```

**The column, `infra/azure/pilot_slice_postgres_shadow_decision_loop_migration.sql:19`:**

```
  effective_at timestamptz not null default now(),
```

Coach A begins a transaction and writes `'cleared'`. Coach B begins later and
writes `'not_cleared'`. B commits first, A commits second. The latest row by
`effective_at` is A's — the earlier-started transaction — so the read returns
`'cleared'`. That value is the input to the contact-clearance gate
(`contactClearanceGate.ts:141`) and to `assertMedicalStatusAllowsRecommendation`.

**Refutation attempted:**

1. *Is there a lock or a uniqueness constraint?* No `for update`, no partial
   unique index, no `on conflict`. Nothing serializes two writers.
   **Refutation failed.**
2. *Is the window wide?* No. The transaction contains one insert plus one shadow
   audit entry — milliseconds. And both writes are human actions, so two coaches
   would have to act within the same few milliseconds. **Refutation largely
   succeeded**; this is LOW for that reason and no other.
3. *Is there clock skew across replicas?* No — `now()` is the single database's
   clock. **Refutation succeeded on that variant.**

**Consequence for a child.** In the narrow interleaving, a coach who has just
recorded that a child is *not* cleared for contact gets a system that still reads
`'cleared'`, and the contact gate passes silently. The correct fix is a
tiebreaker on the read (`order by effective_at desc, created_at desc`) or a
`for update` on the athlete's status rows — neither narrows a role gate, so this
one is bounded and implementable without an owner decision.

---

### [LOW] A failed contact observation is reported to an athlete as "partially saved", with nothing said about the safety check

**What is wrong.** The sparring page posts each observation as its own request
through `Promise.allSettled` and reports an aggregate. A rejected request — the
network dropping on exactly the `contact_level` or `punch_absorbed` POST — is
dropped from the tally.

**Verbatim, `apps/web/app/athlete/dashboard/sparring/page.tsx:121-131`:**

```
  const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const savedCount = fulfilled.filter((value) => value.ok).length;

  return {
    ok: savedCount === results.length,
    savedCount,
    // Any one of the contact observations tripping the gate is enough; they all
    // concern the same session.
    safetyReviewRaised: fulfilled.some((value) => value.safetyReviewRaised),
```

and what the athlete is then told, **`sparring/page.tsx:214`:**

```
        : 'Telemetry partially saved. Some metrics may be missing from coach review.');
```

**Refutation attempted:**

1. *Is the server side fail-open?* No, the opposite. `observations/route.ts:122-125`
   is explicit: *"Runs BEFORE the observation is stored, so a failure here aborts
   the whole request rather than quietly persisting contact nobody was alerted
   to."* **Refutation succeeded for the server** — this is a client-reporting
   defect only.
2. *Is there another path that would catch the missed contact?* No. The near miss
   is raised only from this request; a contact observation whose request never
   landed produces no record and no alarm anywhere.
   **Refutation failed.**
3. *Does the page at least distinguish "nothing saved"?* Yes —
   `sparring/page.tsx:199` names that case clearly. It is the *partial* case that
   is under-described. **Refutation partially succeeded**, hence LOW.

**Consequence for a child.** An athlete logs a sparring session with no medical
clearance on file. The contact half of the submission fails; the rest lands. They
read "Telemetry partially saved. Some metrics may be missing from coach review",
which sounds like a data-quality note, and no safety review is raised. The
wording should name the specific loss — contact was not recorded, so log it again.

---

### [LOW] A failing video-scan sweep silently stops retention and audit-archival housekeeping from ever running

**What is wrong.** In the worker tick, the housekeeping counter is incremented
*after* the sweep, inside the same `try`. A sweep that throws every tick means the
counter never advances.

**Verbatim, `apps/web/src/server/pilot/shadowJobWorker.ts:109-118`:**

```
      if (options.sweep) {
        await options.sweep();
      }
      if (options.housekeeping) {
        ticksSinceHousekeeping += 1;
        if (ticksSinceHousekeeping >= housekeepingEvery) {
          ticksSinceHousekeeping = 0;
          await options.housekeeping();
        }
      }
```

The housekeeping slot carries `purgeTerminalShadowJobs` and the SHADOW chat audit
archival (`instrumentation.ts:63-79`) — which `instrumentation.ts:9-12` describes
as *"the platform's retention work"*.

**Refutation attempted:**

1. *Does the sweep throw in practice?* It returns early with
   `skippedReason: 'not_configured'` when no scanner is set
   (`videoScanSweep.ts:106-108`), so an unconfigured environment does not throw.
   A configured one can — the finding above is one way.
   **Refutation partially succeeded.**
2. *Is anything else driving retention?* No. `grep` finds no workflow in
   `.github/workflows/` and no route calling `purgeTerminalShadowJobs` or the
   archival sweep. This tick is the only caller. **Refutation failed.**
3. *Does it matter for safety?* Not directly — the consequence is that job
   `input_payload` (up to 12k characters of authorized context about a child, per
   `shadowJobQueue.ts:266-269`) outlives its declared 30-day retention. That is a
   data-retention defect, adjacent to pass 3's F-17, not a permissive gate. Hence
   LOW.

**Consequence for a child.** Context about a minor that an owner decision says is
deleted after 30 days is retained indefinitely, and the reason is a *different*
subsystem failing — which is precisely the cascading shape the brief asked about.
Reordering two blocks fixes it.

---

## Checked and found sound

Recorded deliberately. A resilience pass that reports only defects would give a
false picture of this codebase, and several of these are the reason the fail-open
count is 9 and not 30.

**Every safety screen distinguishes a failed load from an empty one.** Nine
checked by hand — `/parent/safety`, `/admin/safety-review`, `/admin/escalations`,
`/admin/safety-flags`, `/admin/waiver-status`, `/admin/athlete-consent`,
`/admin/video-compliance`, `/admin/compliance-center`,
`/board/escalation-monitoring` — and every one renders a distinct error state
rather than the empty state. `/admin/escalations` carries the reasoning inline
(`escalations/page.tsx:260`): *"A failed load must not wear the empty state's
clothes"*. `/admin/safety-flags` goes further and appends *"Flags may exist that
are not shown here."* to a load error (`safety-flags/page.tsx:138`). **This was
the single most likely place to find a fail-open and it is not there.**

**Every route-level `catch` returns an error status.** All 22 catch blocks in the
14 safety-relevant routes read either `return jsonError(error)` or the guarded
audit wrapper. None returns a 200. `jsonError` (`http.ts:71`) maps a
`PilotError`, a `MedicalStatusBlockedError` and a `GuardianConsentMissingError` to
409, and anything unrecognised to 500 — so an unexpected database error on a gate
path becomes a refusal, never a pass.

**The client role gate fails closed.** `RoleSessionGate.tsx:94-99` sets state
`'retryable'` on any non-abort error and `:107` returns the "Unable to verify
access" screen instead of `children`. A session-endpoint outage hides the page; it
does not reveal it.

**All athlete-scope asserts fail closed, including their degradations.**
`assertCoachAssignedToAthlete` (`access.ts:74-85`) and `accessibleAthleteIds`
(`access.ts:381-389`) both catch `42P01` on `pilot.coach_coverage` and treat it as
*no coverage* — fewer permissions, not more. `actorCanAccessJob`
(`shadowJobQueue.ts:194-198`) and `listConversations`
(`shadowConversations.ts:650-657`) both turn a thrown assert into denial.

**The video-scan decision engine cannot be talked into promoting.**
`parseContentScreenVerdict` (`videoScanPolicy.ts:119-123`) treats anything that is
not the exact token `SCAN_PASS` as `'uncertain'`, with the comment naming the bug
it avoids: *"a sloppy `includes('PASS')` would have turned 'I cannot say this is a
PASS' into a promotion"*. `readMalwareVerdict` (`videoScan.ts:87-109`) returns
`'unavailable'` for an unrecognised tag value, never `'clean'`.
`decideVideoScanOutcome` promotes only when every enabled gate reported an
affirmative pass. A blob-storage failure produces `{}` tags
(`blob.ts:91-100`) which reads as `not_scanned_yet` → `retry`, then
`needs_human_review`. Fail-closed at four consecutive layers.

**The guardian-consent race is closed correctly, and pass 3's read of it is
corroborated.** `assertGuardianMediaConsentWithClient` (`guardianConsent.ts:149-183`)
takes `for share` on `pilot.guardian_links` inside the approval transaction, and
`suppressPublishedMediaForAthlete` (`publication.ts:364-369`) takes `for update`
on the same rows before retracting. Either the publish commits and the sweep
retracts it, or the sweep's lock wins and the re-check refuses. An empty guardian
list throws rather than passing (`guardianConsent.ts:165-167`).

**The consent-withdrawal → suppression split is non-transactional on purpose and
handled properly.** `parent/consent/route.ts:185-233`: the sweep failure is *not*
swallowed, it logs, writes a durable audit row distinguishing "no published media"
from "suppression failed", and returns a 500 whose message tells the guardian
exactly what to do — *"Your consent withdrawal was recorded, but suppressing
already-published media failed. Withdraw again to retry"*. This is the model the
`videoScanSweep` finding above should follow.

**The job queue's concurrency and lease handling.** `FOR UPDATE SKIP LOCKED` plus
a `gen_random_uuid()` lease token, `completeJob`/`failJob` both predicated on
`status = 'running' AND lease_token = $4 AND lease_expires_at > NOW()`, a
`stale_running` CTE that requeues a dead worker's job and terminates it at
`max_retries`, and an `expired_pending` CTE that cancels jobs past TTL and blanks
their payload. `JOB_LEASE_SECONDS = 300` carries a comment explaining the measured
reason it is not 120. There is no dead-letter table, but `'failed'` is a real
terminal state with the error code retained and a 30-day purge — jobs do not
silently vanish before then.

**The guarded-UPDATE pattern is used consistently instead of row locks, and it is
sufficient.** Hold lift, safety-flag resolve, and escalation acknowledge/resolve
all put the legal prior state in the `WHERE` clause and re-read on zero rows to
distinguish "no such record" from "illegal transition". `escalationLadder.ts:369-374`
names the bug this prevents: *"acknowledging a RESOLVED escalation flipped it back
to 'acknowledged' with its resolved_* columns still populated -- a closed safety
record about a minor silently reopened"*. Two coaches acting at once cannot
regress any of these three records.

**Nine of eleven server-side outbound HTTP calls are bounded**, which is #425
working. `?? true` occurs five times in the whole tree and `|| true` zero times;
of the five, `shadowFeedback.ts:181` (`humanReviewRequired ?? true`) defaults
*toward* review, and the `coversVideo ?? true` pair is already pass 3's F-12.

**`assertShadowRuntimeReadiness` fails closed** — a missing table or unset
connection string throws `ShadowRuntimeUnavailableError` → 503
(`shadowReadiness.ts:24-58`, `http.ts:110-119`), and it caches only *successes*,
so a transient failure is retried rather than memoised.

**Safety flags gate nothing, so they cannot fail open.** `listOpenSafetyFlags` has
exactly two readers: the route that lists it and the admin page that renders it.
No code path consults a flag before permitting an action. Worth knowing before
someone treats an empty flag list as a clearance — and worth reading alongside
pass 4's finding that the flag register is display-only.

**`formulas/repository.ts:146`'s `?? []` on `hard_blocks` is unreachable.**
The column is `text[] not null default '{}'` in both
`pilot_slice_postgres.sql:1183` and the runtime migration. Defensive, not a gap.
This is recorded because it was the most promising-looking "empty means nothing
blocking" candidate in the `?? []` census, and it is a false alarm.

---

## Could not establish

Named rather than guessed, per rule 2.

1. **Whether `PPBF_SHADOW_WORKER_ENABLED` is `true` in any live environment.**
   This bounds the two HIGH findings in *both* directions: if the worker is off,
   the video-scan escalation gap is dead code and quarantined videos of minors
   simply never get a verdict at all; if it is on, both findings are live. Pass 3
   recorded the same hole and pass 8 owns the question. Needs Actions run history
   or App Service configuration nobody in this session can see.
2. **Whether `maxDuration = 60` is honoured under `output: "standalone"`.** It is
   a serverless directive and this is a container deployment. If it is enforced,
   an operator draining a `film_study` job through
   `/api/pilot/shadow/jobs/process` gets the process killed at 60 s while the
   provider call can run to 120 s and the lease to 300 s — a reliable path into
   the retry-egress finding. If it is not enforced, that particular trigger does
   not exist. Not determinable from source.
3. **Whether every live environment has every migration applied.** The four
   `42P01` fail-opens are conditional on this. The base schema contains
   `pilot.training_holds`, so a from-scratch provision is fine; migrations are
   operator-applied with no boot-time runner, so a partially-migrated environment
   is possible. Needs the migration ledger for each environment.
4. **Whether the two unbounded `fetch` calls ever actually hang in production.**
   Graph and IMDS both normally answer in milliseconds. The finding is about the
   absence of a bound, not an observed hang.
5. **190 of 228 routes and 106 of 125 screens were not opened.** Selection was by
   safety keyword and by the audit-write census. There may be fail-open handling
   in a route this pass did not read; the count of 9 is a floor for the surfaces
   examined, not a ceiling for the platform.
6. **No code was run.** Every claim is source reading. Rule 5 of `AGENT_KERNEL.md`
   applies: code-reading alone is not runtime proof. Reproduce before acting on
   any severity.
7. **`apps/research-bridge` failure behaviour was not audited** beyond inclusion
   in the catch census.
