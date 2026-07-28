# SHADOW Chat Functionality Audit — 2026-07-28

Scope: every SHADOW chat surface and the ML/learning layer behind it.

**Baseline:** `npm run typecheck` clean. Jest: 99 suites / 890 tests, all passing.
Every defect in this report is invisible to both gates. Finding 0 explains why.

## Verification status — read this first

Findings are tagged by how they were established:

- **[V]** — verified directly against source by the auditor. Line numbers checked.
- **[U]** — reported by an audit agent but **not** independently verified. The verification
  pass was lost to a session-token limit, so these are leads, not conclusions.

7 of 13 planned audit dimensions did not complete (same limit). They are listed under
*Not audited* at the end. This report is therefore a floor on what is wrong, not a ceiling.

---

## 0. Why the green build proves nothing about the chat UI  **[V]**

`apps/web/jest.config.js:4-5`

```js
testEnvironment: 'node',
testMatch: ['**/*.test.ts'],
```

`testMatch` accepts `.test.ts` only — never `.test.tsx` — and the environment is `node`
with no jsdom and no React test renderer installed.

**Every file under `app/` and `components/` is therefore untestable by construction.**
The 890 passing tests cover server modules and route handlers exclusively. Most findings
below live in the client layer, which is why a fully green suite coexists with a chat page
that mis-renders safety banners and logs users out.

This is the single highest-leverage fix in the report: without it, every client-side
defect below can regress silently the moment it is fixed.

---

## 1. Critical — user-facing actions that always fail

### 1.1 `/api/pilot/board/chat` returns 503 on every request  **[V]**

`app/api/pilot/board/chat/route.ts:22` hardcodes the session type, spread *last* so it
overrides anything the caller sent:

```js
body: JSON.stringify({ ...sanitizedBody, sessionType: 'board_summary' }),
```

The adapter admits `organization_admin` and `admin` — both in `MANUAL_OVERRIDE_ROLES` — so
`resolveSessionType` honours `board_summary`. The canonical route then hits
`chat/route.ts:482-500`:

> `state: 'degraded'` … "This background SHADOW mode is not active until the secure job
> worker is configured." — **HTTP 503**

There is no input that reaches a model. The endpoint is unconditionally dead, and because
the 503 is hardcoded downstream of the adapter, no caller can work around it.

### 1.2 `platform_owner` is force-logged-out by clicking 👍  **[V]**

- `chat/route.ts:330` — `requireRole` **includes** `platform_owner`.
- `feedback/route.ts:58` — `requireRole` **omits** it → 403.
- `app/shadow/page.tsx:586-593` — a 401/403 from feedback is treated as session death:
  `clearRoleSession()` then `router.replace('/login')`.

The one role that can chat but not rate is ejected to the login screen mid-conversation,
losing the conversation view. Note `shadowRoleSets.ts` exists specifically to prevent this
class of divergence, and this list bypasses it.

### 1.3 Athlete "message your coach" always 400s  **[V]**

`components/AthleteWorkspace.tsx:668` posts `sessionType: 'individual_support'`. That value
is not in `SESSION_TYPE_OVERRIDES`, so `chat/route.ts:378-381` rejects it:

> 400 — "Enter a question for SHADOW."

The success copy — *"Message sent. Coach response will appear in your SHADOW conversation
log"* — is unreachable. The same component elsewhere states that in-workspace chat is
unavailable and routes to the real chat, so this form appears to be a leftover.

### 1.4 `/admin/shadow` — "The Office" — sends no credentials on any of its 9 fetches  **[V]**

```
app/shadow/page.tsx          fetches=6  credentials=6
app/shadow/scout/page.tsx    fetches=2  credentials=2
components/ShadowChatButton  fetches=1  credentials=1
app/admin/shadow/page.tsx    fetches=9  credentials=0   ← sole outlier
```

`src/lib/apiBase.ts` returns a **cross-origin absolute URL** whenever
`NEXT_PUBLIC_API_BASE` is set — the documented Azure SWA static-export target
(`next.config.ts:8`, `output: staticExportEnabled ? "export" : "standalone"`).
Cross-origin `fetch` defaults to `credentials: 'same-origin'`, so the session cookie is
never sent and all 9 calls 401 in that deployment.

Blast radius includes the feedback `PATCH` at line 640 — which the page's own comment at
line 324 calls *"the only path that runs"* durable learning promotion. See §4.

### 1.5 `/admin/shadow` has no auth gate and swallows every failure  **[V]**

No `readRoleSession`, no `/login` redirect, no 401/403 handling anywhere in 1667 lines.
Failures are discarded (`if (!response.ok) return;`, e.g. line 562). The chat footer
(`app/shadow/page.tsx:1043-1048`) links "The Office" **unconditionally for every role**, so
a coach, athlete, or parent lands on a fully-rendered but empty shell with no explanation.

---

## 2. High — features that mislead the user

### 2.1 Restoring a session upgrades unevidenced answers and drops safety banners  **[V]**

`src/client/shadowSessions.ts:184-203` preserves only `id, type, text, timestamp, state,
feedbackEligible`. Lost: **`evidenceTier`, `handoff`, `profileTier`, `modelUsed`**.

Two consequences, both wrong in the same direction:

1. **Evidence inflation.** Render falls back to `EVIDENCE_TIER_STYLES[msg.evidenceTier ??
   'EMERGING']` (`page.tsx:916`) — the second-*darkest* style — while the "Evidence:" badge
   renders only `if (msg.evidenceTier)` and so disappears. The design comment at
   `page.tsx:83-90` is explicit: *"the bigger the shadow, the more authentic the message."*
   An answer originally graded `RESEARCH_NEEDED` (deliberately flat and light) reopens
   looking well-evidenced, with no badge to contradict it. Ingest defaults to
   `RESEARCH_NEEDED`; render defaults to `EMERGING`. The two defaults disagree.

2. **Safety banner loss.** `handoff` is dropped, so the red "Human Handoff Required" block
   (`page.tsx:930-935`) vanishes on reopen — including text like *"Talk to your medical team
   and sports nutritionist before changing any weight-cut plan."* The guidance survives;
   the instruction to involve a human does not.

### 2.2 The model name shown to the user is not the model that answered  **[V]**

Every response reports `modelUsed: routing.model.displayName` (`chat/route.ts:747`) — e.g.
*"GPT-5 Mini (Quick Round)"*. But Quick Round calls
`buildAzureAiChatCompletionsUrl(runtime.config)` (`azureAiRuntime.ts:45-47`), which uses the
single env-configured `config.deploymentName` — **not** `routing.model.deploymentName`.
`routing.temperature` and `routing.maxTokens` are discarded too.

Heavy Bag does it correctly (`shadowHeavyBag.ts:57`). So The Corner's routing decision is
computed and displayed on every response but honoured only on the Heavy Bag path — which
is the rarer one.

### 2.3 Asking for the cheap tier gets you the expensive one  **[V]**

`shadowRouter.ts:216-228`:

```js
if (tier === 'quick_round' && !isManualOverride) return 'quick_round';
if (tier === 'heavy_bag') return 'heavy_bag';
if (isManualOverride && canOverride.includes(role)) return 'heavy_bag';
```

`isManualOverride` is `userRequestedTier !== undefined`. A coach who explicitly sends
`tier: 'quick_round'` falls past the first guard, past the second, and lands on the third —
returning **`heavy_bag`**. Explicitly requesting the fast, cheap tier escalates you to the
slow, expensive one.

Reachability: the shipped UI sends `tier: 'heavy_bag' | undefined`, never `'quick_round'`
(`shadowSessions.ts:64`), so the bundled client cannot trip it. Any other API caller can —
including the four legacy adapters, which forward arbitrary request bodies.

### 2.4 "The Library" is a hardcoded keyword mock  **[V]**

`app/research/chat/page.tsx:76-133` is an if/else chain on `question.includes('readiness')`,
`'rpe'`, `'technique'`, `'injury'`… returning canned strings. **Zero AI calls.**

It is linked from the real chat as "The Library", and the chat's own guidance panel
(`page.tsx:824-826`) directs users there: *"When Evidence Is Weak: Use The Library and
Research Intake."* Users are routed from a real assistant to a fake one at precisely the
moment they most need a real answer.

### 2.4a The response safety validator passes unevidenced directives and fabricated stats  **[V, empirically probed]**

Added in the follow-up pass. This is the most consequential finding after §2.1.

`validateShadowResponse` gates **medical** language well and **evidence-framing phrases** well, but
its quantified-claim detection is phrase-list-based rather than semantic, so near-identical
claims get opposite treatment. Measured by calling the real validator directly:

| Response text | `filtered` |
|---|---|
| `Data shows 94% of athletes improve with this plan.` | ✅ true |
| `94% of athletes improve with this plan.` | ❌ **false** |
| `This drill is proven to increase punch power by 30%.` | ❌ **false** |
| `I have seen 247 athletes improve doing this.` | ✅ true |
| `You should cut 8 pounds this week because it is best for your bracket.` | ❌ **false** |
| `Cut water weight by sitting in a sauna the night before weigh-in.` | ❌ **false** |
| `Always spar full contact the day before a bout.` | ❌ **false** |
| `You have a concussion and should rest for 3 weeks.` (control) | ✅ true, 3 reasons |

Three distinct gaps:

1. **Strip the framing phrase and the same statistic passes.** Row 1 is filtered only because
   of `Data shows`; row 2 carries the identical unsupported 94% and is returned as `state: 'ok'`.
2. **The word "proven" is not a trigger at all** — even though `PROVEN` is the platform's own
   top evidence tier, and the injected EVIDENCE BOUNDARY prompt (`chat/route.ts:238`) explicitly
   forbids describing a claim as "proven" without verified evidence. The prompt instructs it;
   the validator does not enforce it.
3. **Weight cutting is gated on the request but not the response.** It is one of only four
   topics with a dedicated `FALLBACK_RESPONSES` entry and `HANDOFF_MESSAGES` entry. Ask for a
   weight-cut directive and the request validator blocks you; if the model *volunteers* one, the
   response validator lets it through with no filter, no reason, and no handoff banner.

All three land as `state: 'ok'` — persisted, rendered, and (per §2.1) reopenable with
"well-evidenced" styling.

### 2.4b `shadowChat.test.ts.disabled` — mostly superseded, but one live regression  **[V]**

I diffed the 220-line disabled suite (30 tests) against the 415-line live suite (33 tests).
Most of it is **obsolete, not lost**, and that is worth stating plainly:

- `blocks diagnosis questions` and `allows educational medical questions` **are** still covered
  live — consolidated into a `test.each` table (`shadowChat.test.ts:28-38`). A name-based search
  suggests coverage was dropped; it was not.
- `blocks board member access to athlete-specific context` and `requires coach assignment
  verification` are obsolete: `board_member` no longer exists in `contracts.ts`, and the
  `organization-level aggregates only` / `not assigned` branches no longer exist in
  `shadowChat.ts`. Authorization now delegates to the canonical `assertActorCanAccessAthlete`
  helper, which the live suite covers *better* (3 tests, including fail-closed).

One assertion is a genuine regression. Disabled Test 11 asserted that
`'You should do X because it is best.'` would be filtered or produce reasons. Run against
today's validator it returns `filtered: false, reasons: []`. That is the same hole §2.4a maps —
the disabled file is the only place in the repo that ever guarded it, and it is invisible to CI.

### 2.5 Feedback failures are silent  **[U]**

`page.tsx:586` catches only 401/403. Every other failure — 404, 429, 500 — is swallowed, so
the thumb click simply does nothing with no message. Not independently verified, but
consistent with the `sendFeedback` body I did read.

### 2.6 A 404 wedges the conversation  **[U]**

Reported at `page.tsx:737`: a 404 from chat leaves the stale `conversationId` in state, so
every subsequent send fails until the user discovers "New chat". Plausible from the code
structure; not independently verified.

---

## 3. Dead — wired but with no effect

### 3.1 The entire async / job pipeline, end to end  **[V]**

- `routeLlmCall` returns `resolvedAsync: false` on **all five** return paths and never
  assigns `asyncJobId`. `state: 'queued'` is unreachable from chat.
- Consequently dead in `app/shadow/page.tsx`: `pollQueuedShadowJob` (lines 661-735, ~75
  lines), the *"Your Heavy Bag Session is queued. Job ID:"* branch, `isAsync`, `jobId`, and
  the *"· Processing…"* label.
- `executeHeavyBagAsync`, `generateScoutReport`, `shouldRunAsync` — **zero non-test
  callers.**
- No `schedule:`/`cron` in any `.github/workflows/*.yml`, so `jobs/process` is never drained.
- `preferAsync` is validated by the request schema, then ignored.
- Knock-on: the `aggressive_research_generation` unlock needs 12 completed `scout_report`
  jobs (`shadowUnlocks.ts:59-67`), which nothing can create → permanently unreachable.

The chat's completion message tells users to *"Open Scout Reports to review the
server-validated result"* — a page that can never be populated, via a message that can
never be shown.

### 3.2 `/shadow` ignores every query param the entry button sends  **[V]**

`ShadowChatButton.tsx:69` builds `/shadow?mode=&role=&context=&subject=`. The page hardcodes
`const context = ''; const subject = '';` (`page.tsx:258-259`); `mode` comes from the
capabilities API and `role` from the session.

Dead as a result: the `subject` branches of `buildWelcomeMessage` and `buildHeading`, the
`Context:` header line (`page.tsx:800`), and the `subject` prop at all 17 call sites.
`useSearchParams` is never called, so the `<Suspense>` boundary at `page.tsx:1087` guards
nothing.

### 3.3 ~665 lines of orphaned ML modules  **[V]**

Imported only by their own test, or by nothing at all:

| Module | Lines | Status |
|---|---|---|
| `shadowProfileProgression.ts` | 219 | **Zero importers, not even a test.** A second bronze/silver/gold tier system competing with `shadowProfiling.ts` |
| `shadowPersonalization.ts` | 216 | Own test only. A complete parallel personalization implementation |
| `shadowExplainability.ts` | ~230 | Own test only. The chat client declares `ExplainabilityChain` (`page.tsx:50-57`) that the server never populates |
| `updateCommunicationStyle` (`shadowUserProfile.ts:115`) | — | Zero non-test callers; `shadowLearningLoop.ts:485` duplicates it with inline SQL |
| `getShadowUserContext`, `buildUserShadowContext` | — | Dead / transitively dead via `shadowPersonalization` |

Two independent bronze/silver/gold implementations is the notable part — it means the
medal shown next to each message has two competing definitions in the tree.

### 3.4 Session rename and delete are fully built, tested, and unreachable  **[V]** — upgraded from [U]

`shadowChatCapabilities.ts:30` reports `canManageSessions: true`. The backend genuinely
delivers it: `sessions/[conversationId]/route.ts` implements `PATCH` (rename, via
`renameConversation`, line 52) and `DELETE` (line 74), both with tests
(`route.test.ts:116`). They authorize correctly and return sensible 400/404s.

No UI calls either one. Grepping `method: 'DELETE'` and `PATCH` across `app/` and
`components/` returns only test files — `app/shadow/page.tsx` calls the `GET` and nothing else.
So this is not an unimplemented capability; it is a complete, tested backend with no front end.
Users are told they can manage sessions and have no control that does it.

`canExportConversationHistory: true` and `canRequestDeletion: true` are likewise advertised
with no UI affordance.

### 3.5 Chat citations are computed, returned, and silently dropped  **[V]** — corrected from [U]

The agent claimed `shadowSessions.ts:122` discards citations the restore APIs return. **That
mechanism is wrong** and I am refuting it: neither `sessions/route.ts` nor
`sessions/[conversationId]/route.ts` mentions citations or evidence at all, so there is nothing
on the restore path for the parser to drop.

The real defect is on the live chat path. `chat/route.ts:750` returns a `citations` array built
from the evidence bundle, and the client never references the field anywhere — not in
`ShadowAIResult`, not in `ShadowMessage`, not in the renderer. Every request pays for evidence
retrieval and citation extraction, and the result is discarded on arrival. That is also why
`getShadowChatCapabilities` can hardcode `canViewEvidence: false` while the server does the work.

---

### 3.6 `MANUAL_OVERRIDE_ROLES` is duplicated in the one file that matters most  **[V]**

`shadowRoleSets.ts` exists specifically to stop this. Its header comment says so outright:
*"these lists were copy-pasted across route files -- DECISION_LOOP_ROLES existed identically in
six files ... Divergence between copies is invisible in review and is exactly how platform_owner
ended up locked out of routes it was expected to reach."*

`chat/route.ts` does not import `shadowRoleSets` at all. It declares its own
`const MANUAL_OVERRIDE_ROLES = new Set<PilotRole>([...])` at line 299, parallel to the canonical
export at `shadowRoleSets.ts:64-69`.

The two lists are **identical today** (`coach`, `admin`, `organization_admin`, `platform_owner`),
so there is no live bug — this is a latent one, filed at low severity. But it is the exact
failure mode the module was written to prevent, reproduced in the highest-traffic consumer, and
§1.2 is a working example of what role-list divergence costs.

## 4. The ML layer: is the learning loop closed?

**No — not without a manual human step that is itself broken in the documented deployment.**

I initially judged this loop "narrowly closed." That was too generous; the gate chain is
stricter than it first appears. Corrected trace  **[V]**:

1. A user clicks 👍 → `feedback/route.ts:180` sends `verificationState: 'durable_client'`.
2. `processLearningSignal` **early-returns** at `shadowLearningLoop.ts:82-97` for anything
   that is not `human_reviewed`. It records metrics and queues for review. **No profile
   write, no fact extraction, nothing that can affect a future answer.**
3. To progress, an org admin must open `/admin/shadow` and `PATCH`-approve each item
   (`feedback/route.ts:286`, `verificationState: 'human_reviewed'`).
   **That page sends no credentials — §1.4 — so this step 401s in SWA deployment.**
4. Even when it succeeds, `handlePositiveOutcome` (`shadowLearningLoop.ts:176`) requires
   `isFeatureEnabled(unlockState, 'strong_personalization')`, else:
   *"Strong personalization remains locked (observation mode)."*
5. That unlock needs **20** `shadow_feedback` rows for that same user with `helpful = true`
   and rating null-or-≥4 (`shadowUnlocks.ts:49-53`).
6. Only then does `extractAndStoreFacts` → `upsertRememberedFact` run.
7. And `buildPersonalizationPrompt` in the chat route is gated on **the same** unlock —
   so the facts and their injection unlock together.

So the circuit exists in code but requires 20 admin-approved thumbs-ups per user, routed
through a page that cannot authenticate cross-origin.

### 4.1 `communication_style` can never be written  **[V]** — corrects my earlier claim

`maybeUpdateCommunicationStyle` (`shadowLearningLoop.ts:292`) returns early on
`!signal.responseText`, and `inferCommunicationPreference` (`:466`) guards on it again.
`responseText` is optional on `LearningSignal` (`:33`) and **neither** call site in
`feedback/route.ts` (lines 169, 286) supplies it.

`profile.communication_style` therefore stays `'unknown'` forever, so the
"Communication Preference" branch of `buildPersonalizationPrompt` (`shadowProfiling.ts:177`)
never fires. I had earlier cited `shadowLearningLoop.ts:485` as a live writer — it is
unreachable. The audit agent was right on this point.

### 4.2 Further ML findings — all **[U]**

These come from the two ML dimensions that completed. None were verified; several are
specific enough to be worth checking directly:

- `getScorecard` (`shadowLearningLoop.ts:555`) is fully dead, while the UI renders a section
  called "The Scorecard" from a different source.
- Every thumbs-up permanently flags its topic as "needing review" on the admin dashboard,
  with no code path that can clear the flag (`shadowLearningLoop.ts:82`).
- "Human Escalations" on the metrics dashboard is structurally always zero — nothing emits
  the `escalated_to_human` signal (`metrics/route.ts:247`).
- The chat banner tells users features are "close to unlocking" when those features can
  never unlock (`shadowUnlocks.ts:333`) — consistent with §3.1's dead scout-report threshold.
- `open_questions` is read in six places and written in none (`shadowUserProfile.ts:192`).
- `shadow_notes` is never written, so the Heavy Bag "## Context Notes" section is always
  empty (`shadowContextBuilder.ts:124`).
- 25 of the 100 points in `classifyProfileTier` come from columns nothing writes, making
  Gold effectively unattainable (`shadowProfiling.ts:132`).
- Two contradictory bronze/silver/gold definitions are shown to users simultaneously
  (`metrics/route.ts:361`) — corroborates §3.3.
- Admin `profileCompletionRate` is capped at ~40% because three of five factors are
  unwritable (`metrics/route.ts:253`).
- `shadowContextWeights.ts` is unreachable from generation except `detectQueryType`.
- Near misses and decision outcomes have routes but **no UI caller and no
  generation-path reader** (`shadowNearMisses.ts:24`).
- `shadowLearningLoop.test.ts:51` forces all unlock features to `true`, so production's
  locked-feature behaviour — the path that actually runs — has zero coverage.
- A research-requirement failure is logged in the durable learning audit as a library-flag
  failure that did not occur (`shadowLearningLoop.ts:215`).

**Bottom line:** SHADOW is an LLM wrapper with extensive, well-structured learning
scaffolding that is not yet load-bearing. The safety and persistence layers are real and
carefully built. The learning layer captures a great deal and feeds almost none of it back
into generation.

---

## 5. Verified as working

Hypotheses I checked and **refuted** — these are fine:

- All four tables in `assertShadowRuntimeReadiness` exist in
  `infra/azure/pilot_slice_postgres_shadow_runtime_migration.sql`.
- All four "(Planned)" footer links resolve to real pages (98-376 lines each). No 404s.
- The manual Heavy Bag *toggle* works: `shadowClassifier.ts:131-141` short-circuits before
  the complexity heuristic. (The inverse case, §2.3, does not.)
- Restored assistant messages **are** feedback-eligible (`shadowSessions.ts:201`).
- The human-review approval UI genuinely exists (`admin/shadow/page.tsx:640`) — it is the
  credentials bug, not absence, that breaks it.
- Rate limiting, conversation persistence, and `assertConversationAccess` are all substantively
  implemented. The safety validator is real and effective **on medical language specifically** —
  see §2.4a for where it stops.
- No role passes `requireRole` on the chat route and then hits a surprise 403 mid-flow.
  `retrieveShadowContext` returns `authorized: false` in exactly one place
  (`shadowChat.ts:345`), for athlete-context denial delegated to the canonical access helper.
  `platform_owner`, `staff`, and `volunteer` are all fine here. Hypothesis refuted.
- The live `shadowChat.test.ts` is *better* than the disabled suite it replaced on role
  authorization — it tests delegation to one canonical helper, including the fail-closed case,
  rather than duplicating role logic. See §2.4b.

---

## 6. Not audited

Originally 7 dimensions were lost to a session-token limit. A follow-up pass closed the two
highest-value ones. Current state:

**Closed in the follow-up pass:**
- **safety-evidence-pipeline** → §2.4a (validator gaps, empirically probed) and §2.4b
  (`shadowChat.test.ts.disabled` diffed and resolved)
- **capabilities-and-roles** → §3.4 (rename/delete unreachable), §3.5 (citations dropped),
  §3.6 (role-set duplication), plus the mid-flow-403 hypothesis refuted in §5

**Still not audited. No conclusions should be drawn about these:**
- **jobs-feedback-unlocks** — partially covered by §3.1 and §4, but the feedback correlation
  path and `shadowMetrics` read side were never audited end to end
- **sibling-chat-surfaces** — `/admin/shadow`'s 1667 lines of internals, `/shadow/scout`, and
  workspace-embedded chat beyond what §1.4/§1.5/§2.4 cover
- **classification-routing-evidence (ML)** — partially covered by §2.2/§2.3
- **library-knowledge-readmodels (ML)** — `shadowLibrary.ts` is 1208 lines and largely unexamined
- **spec-vs-implementation (ML)** — the conformance table against
  `docs/SHADOW_ML_ARCHITECTURE_SPEC.md` was never built

**Still true:** this is a floor on what is wrong, not a complete accounting. Note also that
every remaining **[U]** finding in §2.5, §2.6 and §4.2 lacks an adversarial verification pass —
the verifier agents all died on the same token limit, so those are leads, not conclusions.

---

## Suggested order of work

1. **`jest.config.js`** — add `.test.tsx` + jsdom. Without this nothing below stays fixed.
2. **§1.4** — add `credentials: 'include'` to all 9 `/admin/shadow` fetches. One-line-each
   fix that also unblocks the learning loop's only human-approval path.
3. **§1.1, §1.2, §1.3** — three independent always-fails bugs, each small.
4. **§2.1** — carry `evidenceTier` and `handoff` through persistence and restore. The safety
   banner loss is the most consequential single defect in the report.
5. **§2.4a** — close the response-validator gaps: make `proven` a trigger, catch bare
   percentages without a framing phrase, and gate weight cutting on the response side as well as
   the request side. Then re-enable disabled Test 11 (§2.4b) as a regression guard — it is the
   only thing in the repo that ever caught this, and it is currently invisible to CI.
6. **§2.4** — either wire `/research/chat` to a real endpoint or stop calling it "The
   Library" and stop routing users there for evidence.
7. **§2.2, §2.3** — make Quick Round honour the routing it displays.
8. **§3.1** — decide: build the worker, or delete the async scaffolding and the UI that
   depends on it. Leaving it half-present is what produced the unreachable unlock.
9. **§3.3** — delete or wire the orphaned modules; collapse the two competing tier systems.
10. **§3.4** — build the UI for session rename/delete, or stop advertising
    `canManageSessions`. The backend is already done and tested.
11. **§3.6** — have `chat/route.ts` import `MANUAL_OVERRIDE_ROLES` from `shadowRoleSets`
    instead of redeclaring it. Cheap, and it removes a latent repeat of §1.2.
12. Audit the 5 dimensions still uncovered (§6) and run the adversarial verification pass over
    the remaining **[U]** findings.
