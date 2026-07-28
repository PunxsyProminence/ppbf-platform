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

### 3.4 Capabilities advertised with no implementation  **[U]**

`shadowChatCapabilities.ts:30` — `canManageSessions`, `canExportConversationHistory`, and
`canRequestDeletion` are all reported `true` to the client, but no UI reaches a route that
implements them. Reported by an agent; the absence of session delete/rename/export controls
in `app/shadow/page.tsx` is consistent with this, but I did not verify each route.

### 3.5 Evidence citations are persisted, served, then discarded  **[U]**

Reported at `shadowSessions.ts:122`: `parseMessage` drops citations that both APIs return.
Consistent with the parser I read (it whitelists five fields), and with
`getShadowChatCapabilities` hardcoding `canViewEvidence: false`. Worth confirming.

---

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
- Rate limiting, the two-stage safety validator, conversation persistence, and
  `assertConversationAccess` are all substantively implemented.

---

## 6. Not audited

Lost to the session-token limit. No conclusions should be drawn about these:

**Wiring:** capabilities-and-roles · safety-evidence-pipeline · jobs-feedback-unlocks ·
sibling-chat-surfaces (`/admin/shadow` internals, `/shadow/scout`, workspace-embedded chat)

**ML:** classification-routing-evidence · library-knowledge-readmodels ·
spec-vs-implementation (the conformance table against `docs/SHADOW_ML_ARCHITECTURE_SPEC.md`)

Also unexamined: `src/server/pilot/shadowChat.test.ts.disabled` — a disabled safety-validator
test suite, invisible to the 890-test baseline. Worth diffing against the live suite to see
what coverage was dropped and why.

---

## Suggested order of work

1. **`jest.config.js`** — add `.test.tsx` + jsdom. Without this nothing below stays fixed.
2. **§1.4** — add `credentials: 'include'` to all 9 `/admin/shadow` fetches. One-line-each
   fix that also unblocks the learning loop's only human-approval path.
3. **§1.1, §1.2, §1.3** — three independent always-fails bugs, each small.
4. **§2.1** — carry `evidenceTier` and `handoff` through persistence and restore. The safety
   banner loss is the most consequential single defect in the report.
5. **§2.4** — either wire `/research/chat` to a real endpoint or stop calling it "The
   Library" and stop routing users there for evidence.
6. **§2.2, §2.3** — make Quick Round honour the routing it displays.
7. **§3.1** — decide: build the worker, or delete the async scaffolding and the UI that
   depends on it. Leaving it half-present is what produced the unreachable unlock.
8. **§3.3** — delete or wire the orphaned modules; collapse the two competing tier systems.
9. Re-run the 7 unaudited dimensions and the verification pass.
