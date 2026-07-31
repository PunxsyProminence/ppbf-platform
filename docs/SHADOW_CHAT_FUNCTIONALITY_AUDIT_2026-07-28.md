# SHADOW Chat Functionality Audit — 2026-07-28

Scope: every SHADOW chat surface and the ML/learning layer behind it.

**Baseline:** `npm run typecheck` clean. Jest: 99 suites / 890 tests, all passing.
Every defect in this report is invisible to both gates. Finding 0 explains why.

## Verification status — read this first

Findings are tagged by how they were established:

- **[V]** — verified directly against source by the auditor. Line numbers checked.
- **[U]** — reported by an audit agent but **not** independently verified. The verification
  pass was lost to a session-token limit, so these are leads, not conclusions.

Of 13 planned dimensions, 6 completed in the first pass and 7 were cut short by a token limit.
A follow-up pass closed 3 of those 7 (safety-evidence-pipeline → §2.4a/§2.4b,
capabilities-and-roles → §3.4/§3.5/§3.6, library-knowledge-readmodels → §3.0) and upgraded
§2.5 and §2.6 from [U] to [V]. **4 dimensions remain unaudited**, listed in §6.

Everything still tagged **[U]** — now confined to §4.2 — has had no adversarial verification.
Treat that list as a to-check queue, not as established fact. This report is a floor on what is
wrong, not a ceiling.

---

## Status since publication

> **Re-verified 2026-07-31 against `4e09b03`.** Every finding below this box was checked
> against the current tree, not assumed from PR titles. The short version: **everything in
> §1–§3 is fixed.** What remains open:
>
> - **§4.1** — fixed in the same change that updates this notice: the learning loop now loads
>   the durable assistant message text itself, so an approved thumbs-up can write
>   `communication_style`.
> - **§4.2** — the unverified [U] leads are still the to-check queue, minus three now
>   resolved: the locked-feature test gap and the research-failure misattribution are pinned
>   by tests in `shadowLearningLoop.test.ts`, and the duplicate tier-system lead died with
>   §3.3's module deletions. The scout-report-unlock lead changed shape: the job pipeline now
>   exists (see §3.1 below), so re-check it rather than assume it.
> - **§6** — two of the four unaudited dimensions were since covered by the PR #106 audit
>   passes (`/admin/shadow` internals; spec conformance, which archived the fiction spec).
>   Still uncovered: **jobs-feedback-unlocks** end to end (newly worth doing — the worker is
>   real now) and the remainder of **classification-routing-evidence**.
> - **Two activation steps, not code:** the SHADOW job worker ships OFF until a deployment
>   sets `PPBF_SHADOW_WORKER_ENABLED=true` (`instrumentation.ts`), and Library semantic
>   search waits on the `text-embedding-3-small` Azure deployment (#108's other half).
> - The one live regression in the retired `shadowChat.test.ts.disabled` (its Test 11 — bare
>   unevidenced directives validate) is recorded as a `test.todo` in `shadowChat.test.ts`;
>   the disabled file itself is deleted.
>
> Later fixes verified in the current tree: §2.2 (`modelUsed` now derives from the deployment
> that actually answered, `chat/route.ts`), §2.3 (router rewritten — explicit `quick_round`
> stays `quick_round`, `shadowRouter.ts`), §2.4 (`/research/chat` now queries the real
> Library via `askLibrary`; unsupported answers file research requirements), §2.4a (all three
> validator holes closed in `shadowChat.ts` with regression tests), §2.6 (the send path now
> clears a dead conversation id on 404 and says so), §3.1 (**built, not deleted**:
> `shadowJobWorker` + `shadowJobProcessor` + `jobs/process` route), §3.2 (`useSearchParams`
> wired), §3.3 (all three orphaned modules deleted), §3.4 (session rename/delete UI shipped —
> `src/client/shadowSessions.ts` issues the PATCH/DELETE), §3.5 (citations rendered), §3.6
> (`chat/route.ts` imports `MANUAL_OVERRIDE_ROLES` from `shadowRoleSets`), and the
> post-publication bare-path fetch item (**zero** bare `/api` fetches remain in `app/` and
> `components/`).

The original notice follows. Eight findings had been fixed when this report was written; each
row below was re-verified against the merged tree at `d59bad7`, not assumed from the PR titles.

| Finding | Status | Fixed by |
|---|---|---|
| 0 — client layer untestable (`jest.config.js`) | ✅ fixed | #39 |
| §1.1 — `/api/pilot/board/chat` 503s on every request | ✅ fixed | #41 |
| §1.2 — `platform_owner` logged out by a thumbs-up | ✅ fixed | #41 |
| §1.3 — athlete "message your coach" 400s | ✅ fixed | #41 |
| §1.4 — `/admin/shadow` sends no credentials | ✅ fixed | #39 |
| §2.1 — restore drops evidence grade and handoff | ✅ fixed | #39 |
| §2.5 — feedback failures are silent | ✅ fixed | #41 |
| §3.0 — SHADOW Library has no ingestion path | ✅ fixed | **#43** |

§3.0 was fixed independently of this audit's follow-up work. All four routes
(`library/{sources,documents,chunks,capability-coverage}`) now exist with real handlers, and all
seven previously-orphaned `shadowLibrary.ts` exports are wired to them. `seed:shadow:library`
now has endpoints to POST to.

**This materially changes §4.** That section concluded the learning loop was not closed partly
because its only human-approval path ran through an `/admin/shadow` page that could not
authenticate. With §1.4 fixed, that path works. The loop is now *closed behind a manual
approval step and a 20-approval unlock* — still demanding, and still gated by
`communication_style` being unwritable (§4.1), but no longer broken. Read §4 with that
correction in mind.

**Everything else in this report was re-verified as still live**, including: §2.2 (displayed
model is not the model that answered), §2.3 (`quick_round` escalates to `heavy_bag`), §2.4
(`/research/chat` is still a hardcoded keyword mock), §2.4a (validator passes `proven`, bare
percentages, and volunteered weight-cut directives), §2.6 (a 404 wedges the conversation), §3.1
(`resolvedAsync: false` on all paths — the async pipeline is still dead), §3.2 (query params
still ignored), §3.3 (`shadowExplainability`, `shadowPersonalization`, `shadowProfileProgression`
still have zero non-test importers), §3.4 (still no UI calling session rename or delete), §3.5,
and §3.6 (`chat/route.ts` still redeclares `MANUAL_OVERRIDE_ROLES`).

One item found after publication and not yet written up as a numbered finding: **39 bare-path
`/api/...` fetches across 13 files** (`AthleteWorkspace` 9, `admin/page` 6, `CoachWorkspace` 6,
`schedule` 4, …) versus 76 using `apiBase()`. In the SWA static-export deployment `apiBase()`
returns the Container App FQDN, so bare paths reach the static host instead of the API — the
same class as §1.4 but wider. `app/athlete/progression-intelligence/page.tsx` uses both styles,
which suggests an unfinished migration rather than a deliberate split.

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

### 2.5 Feedback failures are silent  **[V]** — upgraded from [U]

`sendFeedback` (`page.tsx:580-595`) has exactly one branch in its `catch`: 401/403 → clear
session and redirect. There is no `else`, no state update, no message. So every other failure is
swallowed with **zero** user-visible effect — the thumb stays unclicked, `feedbackSent` is never
set, and nothing indicates anything happened.

Two failures reach this path in normal use: 404 (`'The SHADOW message was not found.'`, which
§1.2's role mismatch and any expired correlation produce) and 429 (the route's own 30/min limit).
Because the UI gives no signal, the natural user response is to click again — spending more of
the rate limit on a request that cannot succeed.

### 2.6 A 404 wedges the conversation  **[V]** — upgraded from [U]

`setConversationId` is called at five sites: the declaration (274), `handleNewChat` → `undefined`
(494), restore success (533), restore-404 handling → `undefined` (553), and send success (606).
It is **not** called in `handleAIFallback` (737-756).

So when the chat POST returns 404 — which `chat/route.ts:773-789` does for
`SHADOW_CONVERSATION_NOT_FOUND`, reachable once a conversation is deleted via the `DELETE` route
in §3.4 — the dead `conversationId` stays in React state. Every subsequent send re-attaches it
and 404s again, showing only *"SHADOW could not process that request."* The chat is wedged until
the user happens to find "New chat", which nothing points them toward.

The asymmetry is what makes this an oversight rather than a design choice: the **restore** path
explicitly clears a stale id on 404 (line 553), and drops the session from the list with an
explanatory notice. The **send** path does neither.

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

### 3.0 The SHADOW Library has no ingestion path — `seed:shadow:library` 404s  **[V]**

Found in the follow-up pass. This is the strongest single finding after §2.1, because it closes
a chain the first pass could only guess at.

`package.json:18` registers `seed:shadow:library` as the supported way to populate the Library.
`scripts/seed-shadow-library.mjs` is an HTTP client — it logs in with an admin PIN and POSTs to
four endpoints. **None of those four routes exist:**

| Endpoint the seed script POSTs to | Exists? |
|---|---|
| `api/pilot/shadow/library/sources` | ❌ **404** |
| `api/pilot/shadow/library/documents` | ❌ **404** |
| `api/pilot/shadow/library/chunks` | ❌ **404** |
| `api/pilot/shadow/library/capability-coverage` | ❌ **404** |
| `api/pilot/shadow/library/claims` | ✅ |
| `api/pilot/shadow/library/search` | ✅ |

`ls app/api/pilot/shadow/library/` returns exactly `claims` and `search`.

That explains six orphaned exports in `shadowLibrary.ts` precisely — they are the handlers those
missing routes would have called: `createShadowLibrarySource`, `listShadowLibrarySources`,
`createShadowLibraryDocument`, `createShadowLibraryChunk`, `upsertShadowCapabilityMap`,
`recomputeShadowCapabilityCoverage`, `listShadowCapabilityCoverage`.

Note the shape of the gap: the **read** path is wired (`searchShadowLibrary` ← `shadowEvidence.ts`
← chat), and the **review** path is wired (`evidence/review/route.ts` calls the review-queue and
`completeShadowLibraryDocumentIndexing` functions). Only the **write** path is absent — and
`completeShadowLibraryDocumentIndexing` is reachable while the three functions that must run
before it are not. Also note `shadow/upload/route.ts` inserts into `pilot.shadow_intake`, not the
Library tables, so uploads are not a back door either.

**The verified cascade.** Because nothing can put content into the Library through any supported
path, on any environment where the seed was attempted and appeared to fail:

1. `searchShadowLibrary` returns empty →
2. `retrieveShadowEvidenceBundle` returns no evidence →
3. `deriveEvidenceTier` receives `citationCount: 0` and unavailable availability, so every
   response lands on the same tier →
4. the four-tier evidence shading in the chat UI (§2.1) is decorative in practice →
5. the `citations` array at `chat/route.ts:750` is always empty, which makes §3.5 moot in
   practice even though the wiring gap is real.

So the entire evidence story — the retrieval, the grading, the shading, the citation plumbing —
rests on a Library that cannot be filled. `getShadowChatCapabilities` hardcoding
`canViewEvidence: false` turns out to be honest, just for a different reason than its comment
gives.

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

- **library-knowledge-readmodels** → §3.0 (no ingestion path; the export/caller map for all 14
  `shadowLibrary.ts` functions is in that section)
- **§2.5 and §2.6** upgraded from [U] to [V]

**Still not audited. No conclusions should be drawn about these:**
- **jobs-feedback-unlocks** — partially covered by §3.1, §3.0 and §4, but the
  `verifyShadowFeedbackCorrelation` path and the `shadowMetrics` read side were never traced
  end to end
- **sibling-chat-surfaces** — `/admin/shadow`'s 1667 lines of internals and `/shadow/scout`
  beyond what §1.4/§1.5/§2.4 cover
- **classification-routing-evidence (ML)** — partially covered by §2.2/§2.3
- **spec-vs-implementation (ML)** — the conformance table against
  `docs/SHADOW_ML_ARCHITECTURE_SPEC.md` was never built

**Still true:** this is a floor on what is wrong, not a complete accounting. Every **[U]**
finding remaining in §4.2 lacks an adversarial verification pass — the verifier agents all died
on the same token limit, so those are leads, not conclusions. Treat the §4.2 list as a to-check
queue, not as established fact.

---

## Suggested order of work

Items marked ✅ have since landed; see *Status since publication* above.

1. ✅ **`jest.config.js`** — add `.test.tsx` + jsdom. Without this nothing below stays fixed.
2. ✅ **§1.4** — add `credentials: 'include'` to all 9 `/admin/shadow` fetches. One-line-each
   fix that also unblocks the learning loop's only human-approval path.
3. ✅ **§1.1, §1.2, §1.3** — three independent always-fails bugs, each small.
4. ✅ **§2.1** — carry `evidenceTier` and `handoff` through persistence and restore. The safety
   banner loss is the most consequential single defect in the report.
5. ✅ **§2.4a** — close the response-validator gaps: make `proven` a trigger, catch bare
   percentages without a framing phrase, and gate weight cutting on the response side as well as
   the request side. (Test 11's bare-directive case survives as a `test.todo` — see the
   2026-07-31 notice above.)
6. ✅ **§3.0** — build the four missing `library/{sources,documents,chunks,capability-coverage}`
   routes so `seed:shadow:library` can actually run, or remove the script and stop shipping an
   evidence pipeline whose source of truth cannot be filled. Everything in the evidence story —
   retrieval, grading, the four-tier shading, the citation plumbing — is downstream of this.
7. ✅ **§2.4** — either wire `/research/chat` to a real endpoint or stop calling it "The
   Library" and stop routing users there for evidence.
8. ✅ **§2.2, §2.3** — make Quick Round honour the routing it displays.
9. ✅ **§3.1** — decide: build the worker, or delete the async scaffolding and the UI that
   depends on it. (Built: worker + processor + `jobs/process`; OFF until
   `PPBF_SHADOW_WORKER_ENABLED=true`.)
10. ✅ **§3.3** — delete or wire the orphaned modules; collapse the two competing tier systems.
11. ✅ **§3.4** — build the UI for session rename/delete, or stop advertising
    `canManageSessions`. The backend is already done and tested.
12. ✅ **§3.6** — have `chat/route.ts` import `MANUAL_OVERRIDE_ROLES` from `shadowRoleSets`
    instead of redeclaring it. Cheap, and it removes a latent repeat of §1.2.
13. Audit the dimensions still uncovered (§6 — now down to jobs-feedback-unlocks and the rest
    of classification-routing-evidence) and run the adversarial verification pass over the
    remaining **[U]** findings in §4.2.
