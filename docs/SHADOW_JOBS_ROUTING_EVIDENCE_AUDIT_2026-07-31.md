# SHADOW Jobs / Feedback / Unlocks + Classification / Routing / Evidence Audit — 2026-07-31

Completes the two dimensions `SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md` §6 listed as
uncovered, plus adversarial verification of its §4.2 leads. Audited at `22253f4` (the tree
deployed to staging and production 2026-07-31). Every finding was established against source
with file:line evidence; none are assumed from docs or PR titles.

**Context that raises the stakes:** the job worker activated in staging AND production on
2026-07-31 (`PPBF_SHADOW_WORKER_ENABLED=true` in both deploy workflows). The async-path
divergences below are therefore live behavior, not latent. A worker drain smoke test
(film_study probe job, claimed and terminally failed with `SHADOW_JOB_TYPE_UNAVAILABLE`
within one tick, then removed) confirmed the queue→claim→terminal loop works in staging;
10 real completed `heavy_bag_session` jobs predate the probe.

Verdicts: **DEFECT** (wrong behavior, concrete failure scenario), **DESIGN-GAP** (missing
piece someone must decide on), **OK** (traced and sound).

> **Status (same day):** A1–A5, A7 (async parity, with A7's processor half reduced to
> retry-then-log because the job is already completed at that point) and B1 (lease raised to
> 300s) are fixed with pinning tests in the async-parity PR (#120). That work also surfaced a
> finding this audit missed: the output sweep validated the `evidenceTier` label itself, so
> 'PROVEN' — the label earned by 2+ authorized citations — tripped the validator's own
> \bproven\b trigger and safe-filtered the entire job output. The better the evidence, the
> surer the self-filter. Fixed by exempting platform-assigned enum labels from the sweep.
>
> **Status (end of day):** every remaining DEFECT in this report is now fixed and merged:
> C1/C2 (review-queue exit — reject always resolves, approve refuses honestly with a 409,
> #122), E2 (`closeToUnlocking` respects activation mode, #123), D1–D6 (metrics honesty
> pass — reason codes for structurally-dead tiles, `recommendation_type` stores the
> recommendation kind, approval restamps `created_at`, `reviewedOutcomes` rename, queued
> turns audited into the feedbackRate denominator, `viewerUnlocks` rename, #124), B5
> (`generateScoutReport` deleted) + B4 (`recovery_round` fails at enqueue, not post-claim)
> + the residual duplicate tier formula in `getUserMetrics` (#135). E1's missing surface
> was built independently the same day: `FeatureUnlockPanel` in the admin console now
> drives the threshold/activation endpoint, stating WHY a feature is locked.
>
> **Owner decisions, called and executed same day:** C3 — ratings are editable until
> reviewed, immutable after. Bare directives — deliberately allowed; the `test.todo`
> became a passing test pinning the decision. F8 — deleted down to `detectQueryType`,
> whose tie-break now resolves to safety. A6 — evidence joins FIRST, so the 12k slice
> costs the tail, never the evidence boundary. F5 — a broken evidence lookup now says
> "evidence lookup temporarily unavailable" instead of impersonating an empty Library.
> B2 — terminal job rows purge 30 days post-terminal via the worker's housekeeping tick.
> B3 — cancelled jobs surface their reason.
>
> **Deliberately deferred by the owner:** E3/E4 (duplicate fine-tuning metric and the
> four unwritable outcome signals stay as-is until the fine-tuning lane is real — it is
> governance-gated regardless) and F6/F7 (classifier high-risk score and the dual topic
> vocabularies; revisit if review triage ever sorts on that column in practice).

> **Status (later the same day) — items 3, 4 and 5 of the suggested order are DONE.**
> Re-verified against source on 2026-07-31 after this document had already gone stale twice:
> two separate sessions began rebuilding fixes that had already landed, and one of them
> (#121/#122) duplicated real work before the collision was caught. Read this block before
> starting anything below.
>
> | # | Fixed in | Evidence |
> |---|---|---|
> | C1/C2 | #122, pg coverage #121 | review-queue exit for filtered and deleted-session items |
> | D1 | — | `shadowMetrics.ts:191` — `unavailableReasons.avgSatisfaction = 'RATING_INPUT_NOT_BUILT'`, so the dead tile now says why |
> | D2 | — | `shadowLearningLoop.ts:149` — passes `signal.sessionType`, no longer the actor role |
> | D3 | — | `shadowMetrics.ts:89` — `created_at` restamped the first time a row reaches `human_reviewed` |
> | D4 | — | `shadowMetrics.ts:26` — renamed off `recommendationsMade`; the count says what it counts |
> | D5 | — | `chat/route.ts:857` — the queued branch now writes `shadow_chat_audit` before returning, so the denominator includes background turns |
> | D6 | — | `metrics/route.ts:61,209` — renamed to `viewerUnlocks`, which makes the per-viewer scope honest rather than implying an org figure |
> | E2 | #123 | `shadowUnlocks.ts:338` — `closeToUnlocking` gates on `activationMode === 'enabled'` |
> | E1 (UI half) | #131 | `page.tsx:660` `FeatureUnlockPanel` — the threshold/activation endpoint had zero client callers; the panel also names WHICH gate holds a feature (mode vs counter). The write is now audited: `unlocks/route.ts:83`, `entity_type: 'shadow_feature_threshold'`, carrying before/after |
>
> **Still open:** B1's "complete before append" half, and the DESIGN-GAPs — A6, B4, C3,
> E3/E4, F1–F3 and F5–F8. F1/F2/F3 are DEFECTs and are now the highest-value unclaimed
> items in this document.

---

## A. Async/sync safety parity (classification-routing-evidence trace)

The synchronous chat path and the background job path were built to be equivalent. They are
not. Each row is a way a background Heavy Bag answer is treated more permissively than the
same question answered synchronously.

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| A1 | Async branch returns before `routeLlmCall`, whose interception is the only consumer of `requestValidation.classification` — an educationally-framed high-risk question (e.g. concussion) gets the canned safe fallback synchronously but a **generated answer persisted as `ok`** asynchronously | **DEFECT** | `chat/route.ts:803` vs `:334-340`; `shadowChat.ts:256-262` |
| A2 | Background answers never carry a handoff banner: `shadowJobProcessor.ts` calls `appendAssistantMessage` without `handoff` although the parameter and column exist and the sync path computes one | **DEFECT** | `shadowJobProcessor.ts:186-201`; `shadowConversations.ts:395,434`; sync `chat/route.ts:912-922,941` |
| A3 | Async queues human review only when `filtered`; sync also queues on `requiresHumanReview` — a background answer that trips reasons but not the filter displays to the user and no reviewer ever sees it | **DEFECT** | `shadowJobProcessor.ts:218` vs `chat/route.ts:950` |
| A4 | The enqueue-time evidence allowlist omits `platformEvidenceIds` that ARE in the prompt context — the model is told to cite ids the validator then treats as unauthorized, replacing the whole answer with filtered text | **DEFECT** | async snapshot `chat/route.ts:844-847` vs sync `:883-889`; prompt `:768-785` |
| A5 | Async persists non-library citation ids against the library bundle (sync strips them first); the citation insert throws `SHADOW_EVIDENCE_CITATION_NOT_FOUND`, aborts the append, and the **user's answer is permanently lost** | **DEFECT** | `shadowJobProcessor.ts:180,194-199` vs `chat/route.ts:894-896`; `shadowConversations.ts:298-320` |
| A6 | `authorizedContext` is sliced to exactly 12,000 chars with the evidence bundle joined LAST, and the processor's oversize guard checks `> 12_000` so it can never fire — oversized context silently drops the evidence excerpts and instructions | **DESIGN-GAP** | `shadowHeavyBag.ts:156`; `shadowJobProcessor.ts:505-507`; `chat/route.ts:779-784` |
| A7 | `queueHumanReview` failures are swallowed into `console.error` while the response still tells the user a human will review — the one failure mode where the displayed safety posture is strictly false | **DEFECT** | `chat/route.ts:662-664,967-969`; `shadowJobProcessor.ts:230-232` |

## B. Job queue lifecycle (jobs-feedback-unlocks trace)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| B1 | `JOB_LEASE_SECONDS = 120` equals the provider timeout with **no lease renewal**: a generation that runs to the limit appends its answer, then `completeJob` throws on the expired lease, the stale-running CTE re-queues, and the conversation accumulates up to 3 near-duplicate answers while the job records `SHADOW_JOB_LEASE_EXPIRED` | **DEFECT** | `shadowJobQueue.ts:100,372,426,272-299`; timeout `shadowJobProcessor.ts:288`; append-before-complete `:186,217` |
| B2 | Nothing purges `pilot.shadow_jobs` — `expires_at` is honored only for `pending`, only as a side effect of a claim; completed/failed rows and their `output_payload` (plus up to 12k chars of authorized context in `input_payload`) persist forever; `shadowArchival.ts` sweeps only `shadow_chat_audit` | **DEFECT** | `shadowJobQueue.ts:258-271`; `shadowArchival.ts:84` |
| B3 | An expired job's reason is invisible: cancellation writes `error_message='SHADOW_JOB_EXPIRED'` but `toStatusResult` surfaces `error` only when `status='failed'`, and the scout UI has no `cancelled` branch | **DEFECT** (minor) | `shadowJobQueue.ts:159-160,263`; `app/shadow/scout/page.tsx:458-463` |
| B4 | `recovery_round` maps to job type `learning_loop`, which `executeJob` cannot execute — unreachable today only because chat rejects `recovery_round` upstream | **DESIGN-GAP** (latent) | `shadowHeavyBag.ts:307`; `shadowJobProcessor.ts:45-50,260-271` |
| B5 | `generateScoutReport` is a second, fully-implemented, zero-caller scout producer alongside the live chat-route one | **DEFECT** (dead code) | `shadowHeavyBag.ts:273-295` |
| B6 | Read side is sound: polling adopts durable message ids, scout renders behind a completed+passed gate, ownership is enforced owner-only, worker-off fails closed with 503s | **OK** | trace in agent report; `chat/route.ts:617-641`; `shadowJobQueue.ts:170-189` |

## C. Feedback → learning promotion (jobs-feedback-unlocks trace)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| C1 | **The admin review queue has no exit for feedback on filtered messages**: the client marks filtered turns feedback-eligible and the row lands with `human_review_required=true`, but `resolveShadowFeedbackReview` joins `response_state='ok'`, so Approve AND Reject both 404 forever. Since this queue is the only path that promotes learning, stuck items also cap every `human_reviewed` counter in §D | **DEFECT** | `app/shadow/page.tsx:807-809`; `shadowFeedback.ts:306`; `shadowFeedbackReview.ts:46-52`; `feedback/route.ts:266-268` |
| C2 | Same permanent-stick when the session is later soft-deleted (`s.deleted_at IS NULL` in the resolve CTE) | **DEFECT** | `shadowFeedback.ts:307-311` |
| C3 | A rating is immutable: the ON-CONFLICT `DO UPDATE SET feedback_id = feedback_id` no-op means flipping thumbs-down to thumbs-up silently does nothing while the route returns `ok: true` | **DESIGN-GAP** | `shadowFeedback.ts:128-131`; route `:173-176` |
| C4 | Correlation itself is sound (org+account scoped, assistant-role, durable-uuid enforced; filtered messages correlate as non-learning-eligible) | **OK** | `shadowFeedback.ts:176-210` |

## D. Metrics honesty (jobs-feedback-unlocks trace)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| D1 | `avgSatisfaction` / `avg_rating` read `AVG(rating)` and **no client ever writes `rating`** — two dashboard tiles are structurally dead with no `unavailableReasons` entry | **DEFECT** | `shadowMetrics.ts:110-116,163-172`; writer `app/shadow/page.tsx:189-195` |
| D2 | `recordRecommendationEffectiveness` writes the actor **role** into `recommendation_type` (NOT NULL); nothing reads it yet, but any future group-by buckets by `coach`/`athlete` | **DEFECT** (mislabeled data) | `shadowMetrics.ts:48,80` |
| D3 | Effectiveness reads window on `created_at`, which approval never refreshes — approving feedback older than the window silently drops it from every counter, in every window | **DEFECT** | `shadowMetrics.ts:50` vs `:117-137` |
| D4 | `recommendationsMade` is COUNT of reviewed outcomes (identical to `reviewed_outcomes`) rendered as "Recommendations" | **DEFECT** (label) | `shadowMetrics.ts:122-137,181` |
| D5 | `feedbackRate` numerator counts all feedback, denominator counts `shadow_chat_audit` rows — and the background path returns before the audit INSERT, so async-heavy orgs can exceed 100% | **DEFECT** | `metrics/route.ts:240-243`; `chat/route.ts:851-871` vs `:987-1001` |
| D6 | Org dashboard's unlock tile is computed with the **viewing admin's** accountId against a per-user counter — two admins see different org unlock states | **DEFECT** | `metrics/route.ts:116,136,204-213`; `shadowUnlocks.ts:161-172` |
| D7 | Null metrics with explicit `unavailableReasons` codes are honest | **OK** | `metrics/route.ts:149-157,195-202` |

## E. Unlocks (jobs-feedback-unlocks trace + §4.2 #4)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| E1 | `unlocked = activationMode === 'enabled' && satisfied`, and 3 of 4 features default to `observation`/`disabled` — only `strong_personalization` is reachable. The 2026-07-28 audit blamed the scout-report counter for `aggressive_research_generation`; that counter is now live (scout jobs enqueue via `/shadow/scout` and the executor works) — **the actual block is the activation mode**, and no UI calls the threshold-editing endpoint that could flip it | **DEFECT** + **DESIGN-GAP** | `shadowUnlocks.ts:55-72,263`; `unlocks/route.ts:35-77` (zero client callers) |
| E2 | `closeToUnlocking` ignores `activationMode`: users see 100%-progress "close to unlocking" banners, forever, for features that cannot unlock | **DEFECT** | `shadowUnlocks.ts:325-334`; render `app/shadow/page.tsx:1056-1063` |
| E3 | `fine_tuning_pipeline`'s counter query is identical to `org_recommendation_outcomes` plus a `message_id IS NOT NULL` clause that is always true — two metrics, one number | **DEFECT** (duplicate metric) | `shadowUnlocks.ts:173-199` |
| E4 | Unlock queries admit 6 outcome signals; the only producer emits `thumbs_up`/`thumbs_down` — `escalated_to_human`, `followed_advice`, `ignored_advice`, `asked_followup` are unwritable | **DESIGN-GAP** | `shadowUnlocks.ts:178,197` vs `feedback/route.ts:152` |

## F. Classification / evidence-tier honesty (classification-routing-evidence trace)

| # | Finding | Verdict | Evidence |
|---|---|---|---|
| F1 | An explicit `sessionType` override decouples the displayed tier and context depth from the model that runs: `{sessionType:'heavy_bag'}` with no `tier` runs gpt-5.6-sol with a Quick Round context and a "⚡ Quick Round" badge | **DEFECT** | `chat/route.ts:451-456,588-594,695-702`; `page.tsx:1274-1281` |
| F2 | Manual Heavy Bag reports a fabricated complexity of 0.9 to both the model and the user | **DEFECT** (honesty, low blast radius) | `shadowClassifier.ts:132-140`; `chat/route.ts:1026`; `shadowHeavyBag.ts:237` |
| F3 | `PROVEN`/`EMERGING` can be awarded on citation counts that include non-library ids which are then stripped from display — "Evidence: Proven" with an empty Sources list (latent until the Library is populated) | **DEFECT** (latent) | `chat/route.ts:894-898` vs `:906-910` |
| F4 | With the Library empty, every response is `RESEARCH_NEEDED` and the UI says so honestly | **OK** | `shadowEvidence.ts:211-216`; `shadowEvidenceDisplay.ts:18` |
| F5 | Retrieval failure and an empty Library are indistinguishable — bundle errors are swallowed into `unavailableShadowEvidenceBundle()` | **DESIGN-GAP** | `chat/route.ts:739-742` |
| F6 | The classifier's high-risk patterns (+0.6 for concussion/weight-cut/self-harm) influence cost/latency only; no safety gate reads `classification` (safety holds only because `validateShadowRequest` is independent) | **DESIGN-GAP** | `shadowClassifier.ts:28-36,66-68,153-163` |
| F7 | `classification.topic` and the validators' topic write the same review column from two incompatible vocabularies | **DESIGN-GAP** | `chat/route.ts:685-687` vs `:912-922` |
| F8 | `detectQueryType` is decorative (one literal prompt line; its metadata reader has no callers), and its keyword tie-break would resolve "weight cut" to `training` over `safety` if it were ever wired | **DESIGN-GAP** | `shadowContextWeights.ts:181-203`; `shadowContextBuilder.ts:102,122,191-197` |

## G. §4.2 lead verification (all twelve resolved)

| Lead | Verdict |
|---|---|
| `getScorecard` dead while UI renders a Scorecard | **STALE** — function deleted; UI feeds from `/metrics` |
| Thumbs-up flags topic forever, no clear path | **STALE** — review-flags PATCH + admin UI + pg test exist |
| Human Escalations structurally zero | **STALE** — now counts `shadow_human_review_queue`, which is written |
| "Close to unlocking" for unlockable-never features | **CONFIRMED** → E2 |
| `open_questions` read in six places, written in none | **CONFIRMED** — writers exist but the sole caller never passes `questionRaised`/`questionResolved` (`chat/route.ts:976-979`) |
| `shadow_notes` never written; Context Notes always empty | **CONFIRMED** — no `SET shadow_notes` in the repo (`shadowContextBuilder.ts:124`) |
| 25/100 tier points unwritable; Gold unattainable | **STALE** — tier scoring rebuilt on writable factors only |
| Two contradictory tier definitions shown simultaneously | **STALE** — one residual dead copy at `metrics/route.ts:365-367` (unreachable; delete it) |
| `profileCompletionRate` capped ~40% | **STALE** — completeness recomputed on writable factors |
| `shadowContextWeights` unreachable except `detectQueryType` | **CONFIRMED** → F8 |
| Near misses / decision outcomes have no UI caller or reader | **REFUTED** — `coach/decision-loop` calls both; `shadowChat.ts` reads near misses |
| Research-failure misattributed to library flag | **FIXED** — separate failure domains + pinning test |

---

## Suggested order of work

1. **A1–A5, A7 — async safety parity.** The worker is live in production; these are the
   findings where a background answer is treated more permissively than a synchronous one.
   A3/A2/A5 are small processor fixes; A1 and A4 are chat-route enqueue fixes; A7 is a
   decision about failing closed when the review-queue write fails.
2. **B1 — lease vs. provider timeout.** Raise the lease above worst-case execution or renew
   it mid-job; also consider completing the job before appending the message so a re-claim
   cannot duplicate a persisted answer.
3. **C1/C2 — give the review queue an exit.** At minimum, Reject must work for filtered and
   deleted-session feedback; whether Approve should remains a product decision.
4. **E2 (+E1's missing UI) — stop advertising progress toward locked features**, or build
   the threshold/activation UI the endpoints already support.
5. **D1–D6 — metrics honesty pass** (dead tiles, mislabeled column, window bug, >100% rate,
   per-user org tile). Small individually; together they decide whether the admin dashboard
   can be trusted.
6. The remaining DESIGN-GAPs (A6, B4, C3, E3/E4, F5–F8) and dead code (B5, the residual
   tier copy) as cleanup/product decisions.
