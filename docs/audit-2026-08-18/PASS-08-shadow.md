# Pass 8 — SHADOW subsystem

Read-only. Branch `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main`
at `04dd116b`. No application code was modified; this file is the pass's only
write.

**Headline result, because it is the one thing other passes are waiting on:**
the SHADOW job processor is driven by an in-process worker loop started from
`apps/web/instrumentation.ts`, and it is **enabled in production and staging**
by the deploy workflows. Nothing calls the `shadow/jobs/process` HTTP route —
pass 3 was right about that — but the route was never the driver. Section
*What drives the job processor* has the evidence.

---

## Method

1. Read `AGENT_KERNEL.md`, then `docs/capabilities/NETWORK_STATUS.md` from
   `origin/docs/agent-handoff-briefs` (it is not on `main` or on this branch),
   then the three canonical SHADOW documents named in the brief:
   `SHADOW_AUTHORITY_MODEL.md`, `SHADOW_EVENT_MODEL.md`,
   `SHADOW_PHASE1_HARDENING_CHECKLIST.md`.
2. Read `docs/audit-2026-08-18/README.md` and `git log --oneline origin/main -40`
   for de-duplication, plus the relevant sections of `PASS-03-minors-consent.md`
   for the Film Study consent finding this pass was asked to bound.
3. Enumerated the SHADOW surface mechanically: 186 files matching `shadow` under
   `apps/web`, then read the authority, event, job-queue, job-worker,
   job-processor, read-model, metrics, library-claim, medical-status and
   archival modules in full.
4. Treated `SHADOW_AUTHORITY_MODEL.md` §8, §16, §19 and §20 and the hardening
   checklist as a specification and checked each clause against source.
5. For the job-processor question, searched exhaustively rather than by
   inference: `.github/workflows/`, `infra/`, `scripts/`, all Dockerfiles,
   `staticwebapp.config.json`, `package.json`, `firebase.json`, `.env.example`,
   and a repo-wide `grep` for `jobs/process` excluding `node_modules` and
   `.next/`.
6. Every finding below carries a verbatim quote with `path:line`, and a
   refutation attempt with its result. Two candidate findings were **dropped**
   after refutation; they are recorded in *Checked and found sound* rather than
   quietly deleted.

**What I did not do.** No code was run — no test suite, no live request, no
production observation. Every claim here is source-derived. Three things I could
not settle from the repository are named at the end rather than guessed.

---

## What drives the job processor

**Answer: an in-process `setTimeout` loop inside the running Next.js server,
started by the Next instrumentation hook, gated on one environment variable that
both deploy workflows set to `true`.** It is not a cron, not an Azure timer, not
an external scheduler, and not the HTTP route.

The chain, each link quoted.

**1. The route is explicitly not the driver, and says so in its own header.**

`apps/web/app/api/pilot/shadow/jobs/process/route.ts:1-6`:

```
// POST /api/pilot/shadow/jobs/process — manual drain of the SHADOW job queue.
//
// The routine drain is the in-process worker loop (see instrumentation.ts and
// shadowJobWorker.ts); this route remains for operations -- draining on
// demand, or an external scheduler in an environment where the in-process
// worker is not enabled. Claims and executes at most one job per invocation.
```

**2. The instrumentation hook starts the loop.**

`apps/web/instrumentation.ts:18-29`:

```
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { isShadowWorkerEnabled, resolveShadowWorkerIntervalMs, startShadowJobWorker } = await import(
    './src/server/pilot/shadowJobWorker'
  );

  if (!isShadowWorkerEnabled()) {
    return;
  }
```

and `apps/web/instrumentation.ts:38-40`:

```
  const handle = startShadowJobWorker({
    processOne: () => processNextShadowJob(),
    intervalMs,
```

**3. The gate is one environment variable, compared to the exact string.**

`apps/web/src/server/pilot/shadowJobWorker.ts:25-29`:

```
export function isShadowWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PPBF_SHADOW_WORKER_ENABLED === 'true';
}
```

Default in `.env.example:57` is `PPBF_SHADOW_WORKER_ENABLED=false`, which is
what makes a source-only reading conclude nothing drives it.

**4. Both deploy workflows set that variable to `true` on the Container App.**

`.github/workflows/deploy-production.yml:414-418, 437` — the same
`az containerapp update --set-env-vars` block:

```
          az containerapp update \
            --name "$CONTAINER_APP_NAME" \
```
```
              PPBF_SHADOW_WORKER_ENABLED=true \
```

`.github/workflows/deploy-staging.yml:278` carries the identical line.

**5. The production workflow records when and why it was turned on.**

`.github/workflows/deploy-production.yml:332-338`:

```
      # PPBF_SHADOW_WORKER_ENABLED is stated explicitly (set-env-vars cannot
      # unset, so every variable is declared). It was deliberately false until
      # staging demonstrated a full enqueue -> drain -> render cycle through
      # the E2E gate; that condition was met by run 30567888858 (2026-07-30,
      # SHA 7cfde83): gate step 14 enqueued a background Heavy Bag, the
      # instrumentation worker drained job 324e7a76, and the answer read back
      # through the sessions API as message 1497ba24 with matching citations
```

**6. The deployment shape supports a long-lived loop.** `apps/web/next.config.ts`
sets `output: staticExportEnabled ? "export" : "standalone"`, and the runtime
image ends `CMD ["node", "apps/web/server.js"]` (`Dockerfile:52`) on Azure
Container Apps. That is a persistent Node process, not a per-request function,
so a chained `setTimeout` survives between requests. Next is pinned at
`"next": "16.3.1"` (`apps/web/package.json:248`), where the instrumentation
hook is stable and requires no config flag.

**Cadence and blast radius, for whoever needs to reason about timing:**
default interval 30 s (`DEFAULT_WORKER_INTERVAL_SECONDS = 30`,
`shadowJobWorker.ts:20`), clamped 5–600 s, up to 5 jobs per tick
(`DEFAULT_MAX_JOBS_PER_TICK = 5`, `shadowJobWorker.ts:23`). Neither deploy
workflow sets `PPBF_SHADOW_WORKER_INTERVAL_SECONDS`, so production runs the
30-second default.

**Exhaustive negative result, stated because it is the half pass 3 found.**
Repo-wide `grep -rn "jobs/process"` excluding `node_modules` and `.next/`
returns only: the route itself, its test, two source comments, and documentation
(including this audit's own PASS-02 and PASS-03). No workflow, no script, no
Dockerfile, no `staticwebapp.config.json` entry, no `package.json` script, no
bicep template invokes it. The only `schedule:`/`cron:` entries in
`.github/workflows/` are `backup.yml:56` and `retention-cleanup.yml:50`, neither
of which touches SHADOW jobs.

**This corrects a stale document.**
`docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md:363` reads:

```
- No `schedule:`/`cron` in any `.github/workflows/*.yml`, so `jobs/process` is never drained.
```

That was true on 2026-07-28 and is false today; the flag flipped on 2026-07-30
per the production workflow's own comment. It is the likely origin of the belief
that nothing drives the queue.

**Consequence for the rest of this audit.** Pass 3 listed *"What drives the
SHADOW job queue in production"* as one of two things it could not establish,
and said it *"bounds Finding 3 in either direction"* (the Film Study consent
race). It is now bounded — see *Findings*, entry B-1, where I bound it in both
directions rather than only the alarming one.

---

## Authority model: specified vs built

`SHADOW_AUTHORITY_MODEL.md` is doctrine plus a self-audit. Clause by clause,
against source. Where they disagree I say which is wrong.

### §5 Source Authority Rule — "must not ... fabricate certainty"

> `docs/SHADOW_AUTHORITY_MODEL.md` §5: "SHADOW must not invent knowledge, guess missing facts, or fabricate certainty."

**Built: contradicted in one place.** `createShadowLibraryClaim` emits a numeric
confidence chosen from three literals by a row count. See finding M-2.

### §8 Authority Model — "Nothing operational exists outside SHADOW"

> `docs/SHADOW_AUTHORITY_MODEL.md:682`: "Nothing operational exists outside SHADOW."
> `docs/SHADOW_AUTHORITY_MODEL.md:701`: "SHADOW is the organizational event spine."

**Built: partly, and deliberately not.** `writePilotAuditEvent` mirrors every
audit row into `pilot.shadow_events` — except where a caller opts out, and 32
call sites across 20 route files do exactly that. See finding L-1. The doc has
no exception clause for the privacy reason the code actually has, so **the doc
is the thing that is wrong here**, not the code.

### §16 Human Authority Rule — "may not ... replace medical professionals"

> `docs/SHADOW_AUTHORITY_MODEL.md` §16: "replace medical professionals"

**Built: the constraint is real for the model, absent for the clearance record
the model reads.** `shadowRecommendations.ts` and `shadowDecisions.ts` genuinely
cannot clear anyone — the read-only import discipline is enforced by a comment
and by module shape, and `assertMedicalStatusAllowsRecommendation` fails closed.
But the record they consult can be set to `'cleared'` by any assigned coach with
no medical provenance and no expiry. See finding H-1.

### §17 Managed Domains — Phase 1 includes "Authority"

**Built: as a table and a logger, not as a chokepoint.** Three call sites, none
of which can deny under any input the system controls. Section
*assertShadowAuthority — independent verdict* below.

### §19 Alignment Matrix — six rows are false against current code

The matrix has no "as of" date and no staleness banner. §20 partially corrects
it in prose, but §19 itself still reads as current, and one row is materially
wrong in the dangerous direction.

| §19 row | Says | Source says |
|---|---|---|
| 9. telemetry: MISSING (`:979-981`) | "no dedicated server telemetry writer or telemetry table in apps/web/src/server/pilot." | `shadowTelemetry.ts` writes `pilot.shadow_telemetry_events`. **False.** |
| 11. research gap workflow: MISSING (`:988-990`) | "no backend research requirement creation workflow under apps/web/src/server/pilot." | `shadowResearch.ts` / `pilot.shadow_research_requirements`. **False.** |
| 14. source confidence: MISSING (`:1003`) | — | `verification_state` exists on two tables; per-table, not general. **Overstated.** |
| 15. recommendation accountability: MISSING (`:1007`) | — | `pilot.shadow_recommendation_effectiveness` + `shadowMetrics.ts`. **False.** |
| 16. failure learning: MISSING (`:1011`) | — | `shadowLearningLoop.ts` / `pilot.shadow_learning_events`. **False.** |
| 17. video and sensor readiness: PARTIAL (`:1015-1018`) | "no production video or sensor ingestion/analysis backend in pilot services." | **False and consequential** — see finding M-3. |

§20 covers rows 9, 11, 14, 15 and 16 in its dated re-verification. It does **not**
cover row 17, which is the one that matters most.

### §19 Conflict Notes

> `docs/SHADOW_AUTHORITY_MODEL.md:1022`: "No direct hard conflict found where current pilot code explicitly violates SHADOW doctrine. Most gaps are capability absence, naming mismatch, or centralization immaturity."

**Built: no longer true.** §5's prohibition on fabricated certainty and §8's
event-spine claim are both contradicted by current code (findings M-2 and L-1).
This sentence should not survive the next edit of the document.

### §20 items 1, 2, 4 — spot-checked and accurate

Item 1's claim that `pilot.shadow_events.event_name` is "unconstrained `text`"
holds: `infra/azure/pilot_slice_postgres.sql:167` is `event_name text not null`
with no check constraint, and `audit.ts:44` synthesises
`` `SHADOW_AUDIT_${normalizedEventType}_${normalizedEntityType}` `` at runtime.
Item 2's "only four modules import it" is now three route files plus the module
itself — close enough that I am not calling it a drift. Item 4's
`pilot.shadow_authority_checks` exists as described.

### Hardening checklist §1 — one box is checked that should not be

`docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md:37` is honestly **un**checked
("Require authority checks before all managed writes") and matches the code:
`athletes`, `goals`, `sessions` and `coach-reviews` routes do not call
`assertShadowAuthority`. Credit where due.

`docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md:40` is checked and is false. See
finding M-1.

---

## assertShadowAuthority — independent verdict

Pass 4 reported, via `NETWORK_STATUS.md`:

> "`assertShadowAuthority` cannot deny at any of its three call sites. Every caller passes `restrictionConflict: false` and no action string matches its forbidden list, so it records `allowed: true` for every medical and waiver write. It is an audit logger wearing the name of a gate."

**Verdict: CONFIRMED in substance, with one factual correction and one
sharpening.** I read the module and all three call sites myself.

### The decision function

`apps/web/src/server/pilot/shadowAuthority.ts:34-43`:

```
function isForbiddenAutomaticClearanceAction(action: string): boolean {
  const normalized = action.toLowerCase();
  return (
    normalized.includes('clear')
    || normalized.includes('concussion')
    || normalized.includes('sparring')
    || normalized.includes('weight_cut')
    || normalized.includes('medical_decision')
  );
}
```

Every one of the six denial branches in `decideShadowAuthority`
(`shadowAuthority.ts:45-71`) is reachable only through a caller-supplied input.
Three of them additionally require `automationMode === 'automatic'`.

### The three call sites, with the inputs they hardcode

**1. `apps/web/app/api/pilot/shadow/upload/route.ts:103-114`:**

```
    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: 'intake.shadow_upload',
      automationMode,
      confidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceVerificationState: 'unverified',
      lowRisk: true,
      reversible: true,
      withinApprovedOptions: true,
      restrictionConflict: false,
```

`'intake.shadow_upload'` matches none of the five forbidden substrings.
`lowRisk`, `reversible`, `withinApprovedOptions` are literals. **No input,
including `automation_mode: 'automatic'`, can make this deny.**

**2. `apps/web/app/api/pilot/intake/domain-upsert/route.ts:47-56`:**

```
    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: `intake.domain_upsert.${entityType}`,
      automationMode,
      confidenceTier: 'SUFFICIENT_FOR_REVIEW',
      lowRisk: true,
      reversible: true,
      withinApprovedOptions: true,
      restrictionConflict: false,
```

`entityType` is one of eight literals declared at `route.ts:34`:
`'emergency_contact' | 'medical' | 'waiver' | 'assessment' | 'attendance' | 'readiness' | 'coach_note' | 'guardian_link'`.
`intake.domain_upsert.medical` does **not** contain `medical_decision`, and no
member contains `clear`, `concussion`, `sparring` or `weight_cut`. **No input
can make this deny** — and this is the route that writes medical intake
(including `clearance_status`) and waivers for a named child.

**3. `apps/web/app/api/pilot/intake/review-action/route.ts:81-90` — the
correction:**

```
    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: `intake.review_action.${action}`,
      automationMode,
      confidenceTier: action === 'promote' ? 'SUFFICIENT_FOR_REVIEW' : 'SUFFICIENT_FOR_LOW_RISK_ACTION',
      lowRisk: action !== 'promote',
      reversible: action !== 'promote',
      withinApprovedOptions: true,
      restrictionConflict: false,
```

Here `lowRisk` and `reversible` are **not** literals. With
`action === 'promote'` both are `false`, so a caller who also sends
`automation_mode: 'automatic'` reaches
`shadowAuthority.ts:58-60`:

```
  if (input.automationMode === 'automatic' && !input.lowRisk) {
    return { allowed: false, reason: 'Automatic action must be low risk.' };
  }
```

and is denied. **So the literal claim "cannot deny at any of its three call
sites" is false at one of the three.** I am correcting it rather than
confirming it wholesale.

### What the corrected claim should say

The denial that exists is **opt-in by the actor being gated**. `automationMode`
is read straight off the request at
`review-action/route.ts:76` (`const automationMode = body.automation_mode ?? 'assisted';`)
and `domain-upsert/route.ts:42` (identical), and **no shipped client sends the
field** — a repo-wide grep for `automation_mode` across `apps/web/app` (pages),
`apps/web/components` and `apps/web/src/client` returns nothing outside the API
routes themselves. So every real request defaults to `'assisted'`, under which
all three automatic-mode branches are unreachable, `restrictionConflict` and
`withinApprovedOptions` are hardcoded to non-denying values at all three sites,
and `confidenceTier` is hardcoded to a tier that is neither `INSUFFICIENT` nor
`CONFLICTED`.

The accurate formulation is therefore: **`assertShadowAuthority` cannot deny for
any input the system controls. The single reachable denial requires the caller
to volunteer a flag no client sends, on one of the three actions, and would deny
the caller's own request.** Pass 4's characterisation — "an audit logger wearing
the name of a gate" — survives that correction intact.

Two further observations pass 4 did not make, both of which sharpen it:

- **The check runs before the real gate.** At
  `domain-upsert/route.ts:47` the authority call precedes
  `await assertActorCanAccessAthlete(principal, athleteId);` at `:62`. So
  `pilot.shadow_authority_checks` records `allowed: true` on a medical or waiver
  write that the very next line may refuse. The governance table over-reports
  permitted writes on minors.
- **The forbidden list is written for exactly the risk it never sees.** It names
  `clear`, `concussion` and `sparring`. The one route in the codebase that
  actually writes a clearance record — `POST /api/pilot/shadow/medical-status`,
  whose whole job is setting a child's status to `'cleared'` — **does not call
  `assertShadowAuthority` at all**. See finding H-1.

**Refutation attempted.** I looked for a fourth call site that could pass
`restrictionConflict: true` or a forbidden action string, including inside
`shadowChat.ts`, `shadowDecisions.ts`, `shadowRecommendations.ts` and the job
processor. There is none: `grep -rn "assertShadowAuthority"` over `apps`,
`packages` and `scripts` returns the module, three routes, and two test files
that mock it. I also checked whether a check constraint on
`shadow_authority_checks.automation_mode` might make a garbage value fail the
insert and thereby fail closed by accident — it would not:
`infra/azure/pilot_slice_postgres.sql:156` is `automation_mode text not null`
with no `check`.

---

## Findings

Severity is assigned against this pass's brief: CRITICAL only where SHADOW can
act on a minor without the authority it claims to require, or a minor's data
leaves the system without consent.

**No CRITICAL is reported.** That is a result, not an omission. The two
candidates I tested for it — the medical-clearance write path and the Film Study
consent race — both come back HIGH after refutation, for reasons given in each
entry. Reaching for a CRITICAL here would have required ignoring a mitigation I
found.

---

### [HIGH] H-1 — The clearance record three safety gates read has one writer, and any assigned coach can set it to `cleared` with no document, no authority check, and no expiry

**What is wrong.** `pilot.shadow_medical_administrative_status` is consulted by
three separate gates: `contactClearanceGate.ts:141`,
`shadowRecommendations.ts:48` and `shadowDecisions.ts:64`. Its single writer
declares itself as such:

`apps/web/src/server/pilot/shadowMedicalStatus.ts:19-24`:

```
// The ONLY write path for this table. Never import this function from
// shadowRecommendations.ts / shadowDecisions.ts -- those modules must only
// ever call getLatestMedicalAdministrativeStatus() below. This is what
// makes MedicalAdministrativeStatus a read-only gate to recommendation
// logic rather than something a recommendation could influence.
export async function setMedicalAdministrativeStatus(input: {
```

That writer's only route is `POST /api/pilot/shadow/medical-status`, gated by
`apps/web/app/api/pilot/shadow/medical-status/route.ts:57`:

```
    requireRole(principal, [...SHADOW_PHI_ROLES]);
```

and `SHADOW_PHI_ROLES` includes `coach` —
`apps/web/src/server/pilot/shadowRoleSets.ts:48-52`:

```
export const SHADOW_PHI_ROLES: readonly PilotRole[] = [
  'coach',
  'organization_admin',
  'admin',
];
```

The payload validation accepts `'cleared'` with everything else optional —
`medical-status/route.ts:64`:

```
      || (body.sourceReference !== undefined && !boundedString(body.sourceReference, 500))
```

`sourceReference` is the only field that could carry provenance, it is optional,
and it is free text. There is no expiry: the reader is
`shadowMedicalStatus.ts:80-81` — `order by effective_at desc / limit 1` — and
the gate at `contactClearanceGate.ts:144` is a bare equality:

```
  if (record?.status === 'cleared') {
```

So a `cleared` row written three years ago still passes the contact gate today.
And `assertShadowAuthority` — whose forbidden-action list names `clear`,
`concussion` and `sparring` — is **not on this path at all**.

**Refutation attempted, and it partly succeeded — which is why this is HIGH and
not CRITICAL.** Three mitigations are real:

1. **The design intends a coach to set it.** The gate's own remediation text
   says so — `apps/web/src/server/pilot/contactClearanceGate.ts:14-16`:

```
const DEFAULT_LESSON =
  "Ask your coach or gym admin to set an explicit 'cleared' medical administrative status "
  + 'on file for this athlete before contact continues.';
```

   The record is named *administrative*, not clinical. A coach recording "the
   office has a clearance on file" is a defensible design, and I am not going to
   call a documented design a critical defect.
2. **The gate is detective, not preventive.** `contactClearanceGate` runs
   *after* a contact observation is recorded and files a near miss; it blocks
   nothing. So `cleared` suppresses an alert, it does not admit a child to
   sparring.
3. **The write is audited inside its own transaction.**
   `shadowMedicalStatus.ts:55-63` calls `writeShadowAuditEntry` with the
   transactional client, so the actor and role are recorded and cannot be lost
   to a partial failure.

**What survives the refutation.** The same coach who logs a child's contact can
pre-emptively write `cleared` and the near miss is never filed — silently,
because the gate returns `{ flagged: false }` at `:164`. Nothing requires a
physician's name, a document id, a date of examination, or a review. Nothing
expires. And the platform's own generalised authority check, written with
`clear` and `sparring` in its denylist, never runs on the one route that clears.

**Consequence.** The safety signal that a child took contact without a current
medical clearance can be turned off by the person with the most incentive to
turn it off, permanently, in one request, and the audit trail records only that
they did it — not on what basis.

**Not previously reported.** `NETWORK_STATUS.md` records the *clearance
register* (`pilot.activity_clearance_requirements`) as having zero callers and
blocked on vocabulary; that is a different table. This is
`shadow_medical_administrative_status`, which does have callers — three of them.

---

### [MEDIUM] M-1 — The hardening checklist claims authority tests that do not exist, and the two tests that touch the module stub it out

**What is wrong.** `docs/SHADOW_PHASE1_HARDENING_CHECKLIST.md:40`:

```
- [x] Add test cases for allowed and forbidden actions per role.
```

There is no `shadowAuthority.test.ts`. `decideShadowAuthority` — the function
containing the `clear`/`concussion`/`sparring`/`weight_cut` denylist — has zero
direct tests. The only two test files that name the module replace it with a
no-op:

`apps/web/app/api/pilot/intake/review-action/route.test.ts:30`:

```
jest.mock('@/src/server/pilot/shadowAuthority', () => ({ assertShadowAuthority: jest.fn() }));
```

`apps/web/app/api/pilot/intake/domain-upsert/route.test.ts:30-33`:

```
jest.mock('@/src/server/pilot/shadowAuthority', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowAuthority');
  return { ...actual, assertShadowAuthority: jest.fn() };
});
```

**Refutation attempted.** I searched for the assertions elsewhere: a
`pilot_slice` pg test, a route-level integration test, a workflow test.
`grep -rln "decideShadowAuthority\|shadowAuthority"` across all `*.test.ts` and
`*.test.tsx` under `apps/web` returns exactly those two files. Neither exercises
a denial. The claim is false as written.

**Consequence.** The denylist could be deleted, inverted, or have `'clear'`
removed, and nothing in CI would notice. That matters more than an unticked box
because the checklist's own exit criterion for §1 is *"denied operations return
consistent error shape"* — a behaviour with no test at all.

**De-dup note.** Pass 10 owns tests and CI. This is reported here rather than
deferred because it is a *checklist-versus-code* claim about the authority
subsystem, which is this pass's scope; pass 10 should not re-report it.

---

### [MEDIUM] M-2 — `createShadowLibraryClaim` returns a fabricated numeric confidence, chosen from three literals by a row count

**What is wrong.** `apps/web/src/server/pilot/shadowLibrary.ts:1250-1259`:

```
  if (distinctSourceCount >= 2 && evidence.length >= 2) {
    status = 'supported';
    confidence = 0.78;
  } else if (evidence.length >= 1) {
    status = 'weak';
    confidence = 0.46;
  } else {
    status = 'unsupported';
    confidence = 0.12;
  }
```

`distinctSourceCount` is `new Set(evidence.map((item) => item.source_id)).size`
(`:1243`) over the results of a text search. The number 0.78 is not derived from
authority tier, verification state, publication date, study design, or agreement
between the sources — only from "two different `source_id`s came back". It is
returned to the client whole:
`apps/web/app/api/pilot/shadow/library/claims/route.ts:54`:

```
    return NextResponse.json({ ok: true, claim });
```

This contradicts `SHADOW_AUTHORITY_MODEL.md` §5 ("must not ... fabricate
certainty") and §14, which specifies confidence as a function of *source
strength and verification state*.

**Refutation attempted, and it lowers the severity.** No shipped UI renders it —
a grep for `confidence` across `apps/web/app/**/*.tsx` finds no claim or library
surface reading the field. The three-way `status` label
(`supported`/`weak`/`unsupported`) is defensible as a coarse count; it is the
*number* that overstates. And `createShadowLibraryClaim` does the right thing on
the empty case: it opens a research requirement (`:1261`) and answers
`'SHADOW Library does not currently have qualifying evidence for this question.'`
(`:1275`) rather than guessing — which is §5 being honoured in the same
function.

**Consequence.** An API consumer — including a future dashboard tile — receives
`0.78` and has no way to know it means "two rows matched". The fix is to drop
the field or derive it from `authority_tier` and verification state, not to
relabel it.

---

### [MEDIUM] M-3 — The authority model's own alignment matrix says there is no production video-analysis backend; there is one, and it sends a minor's video frames to an external model

**What is wrong.** `docs/SHADOW_AUTHORITY_MODEL.md:1015-1018`:

```
17. video and sensor readiness: PARTIAL
Evidence:
- planned UI placeholders: apps/web/app/coach/video-analysis/page.tsx and apps/web/app/athlete/video-analysis/page.tsx
- no production video or sensor ingestion/analysis backend in pilot services.
```

That last line is false. `executeFilmStudyJob`
(`apps/web/src/server/pilot/shadowJobProcessor.ts:873`) downloads a child's
video, extracts frames, and posts them base64-encoded to an Azure OpenAI vision
deployment — `apps/web/src/server/pilot/shadowFilmStudy.ts:204-209`:

```
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: options.prompt },
    ...options.frames.map((frame) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` },
    })),
  ];
```

and it is configured in production —
`.github/workflows/deploy-production.yml:440`:

```
              AZURE_AI_VISION_DEPLOYMENT_NAME=gpt-5-vision-shadow \
```

which is the exact condition `isFilmStudyVisionConfigured` requires
(`shadowFilmStudy.ts:42-49`) and which the enqueue route fails closed on when
absent (`video-analysis/route.ts:59`).

**Refutation attempted.** I checked whether §20's dated re-verification covers
row 17. It does not — §20 addresses items 1–9 of the *gap list*, and its
coverage of the matrix reaches rows 9, 11, 14, 15 and 16 only. I also checked
whether row 17 might be defensible on "sensor", since no sensor pipeline exists;
but the row's evidence line makes a conjoined claim about video *and* sensor,
and the video half is now wrong.

**Consequence.** The document a new contributor is told to read as "canonical
doctrine and architecture source of truth" tells them the most externally
exposed path in the subsystem does not exist. Combined with the `Conflict Notes`
sentence at `:1022` — "No direct hard conflict found where current pilot code
explicitly violates SHADOW doctrine" — the doc actively discourages looking.

---

### [MEDIUM] M-4 — `NETWORK_STATUS.md` is half right about the Knowledge Graph: "Pattern" is permanently empty, "Finding" is not

**What is wrong.** `NETWORK_STATUS.md` records, under *Unclaimed*:

> "Knowledge Graph's "Pattern" and "Finding" columns are permanently empty — nothing emits an event matching those filters."

The filters are `apps/web/src/server/pilot/shadowReadModels.ts:487-495`:

```
      if (event.event_name.toUpperCase().includes('PATTERN')) {
        type = 'Pattern';
      } else if (event.event_name.toUpperCase().includes('FINDING')) {
        type = 'Finding';
```

I enumerated every `eventName` reaching `emitShadowEvent`. The static ones
(`shadowLibrary.ts` ×7, `shadowFilmStudy`/video ×3, `painReportAlert.ts:141`,
the three intake routes, `upload/route.ts:198`) contain neither substring. But
`audit.ts:44` synthesises names from the entity type:

```
    eventName: `SHADOW_AUDIT_${normalizedEventType}_${normalizedEntityType}`,
```

and `apps/web/app/api/pilot/admin/local-findings/route.ts:88` writes:

```
      entity_type: 'local_finding',
```

with `organization_id: principal.organizationId` set and no `shadow_mirror:
false`. The emitted name is therefore `SHADOW_AUDIT_CREATE_LOCAL_FINDING`, which
uppercased contains `FINDING`, and which also passes the
`SHADOW`/`INTAKE`/`AUDIT` admission filter at `:497-503`. The same route's
`PATCH` (`:142-147`, `event_type: 'update'`) emits
`SHADOW_AUDIT_UPDATE_LOCAL_FINDING`. **Raising or advancing a local finding
populates the "Finding" column.**

"Pattern" is confirmed permanently empty: no static event name contains it, no
`entity_type` literal in the codebase contains it, and no member of
`AUDIT_EVENT_TYPES` (`apps/web/src/server/pilot/auditEventTypes.ts:22-55`)
contains it.

**A second, separate defect in the same surface.** The columns are not computed
over the knowledge base — they are computed over the most recent page of events.
`apps/web/app/knowledge-graph/page.tsx:43` requests `{ limit: 120 }`,
`getShadowKnowledgeProjection` passes that straight to `listShadowEvents`
(`shadowReadModels.ts:477-480`), and the type classification and
`SHADOW`/`INTAKE`/`AUDIT` filter are applied **after** the query, in JavaScript.
A finding raised 200 events ago is invisible, and the page's own
`{ label: 'Node Count', value: String(nodes.length) }` (`page.tsx:72`) is
therefore a count of survivors from the last 120 rows, presented as the size of
the graph.

**Refutation attempted.** I tried to break the `local_finding` chain three ways:
(a) is the route's audit write suppressed? No — `shadow_mirror: false` does not
appear in `local-findings/route.ts`; (b) is `organization_id` ever null there,
which would short-circuit at `audit.ts:35`? No, it is `principal.organizationId`;
(c) does the admission filter at `:497-503` exclude it? No — the name contains
`AUDIT`. The chain holds. What I **cannot** establish is whether any
`local_findings` row exists in the live database, which is why I say the column
*populates*, not that it *is* populated.

**Consequence.** A row on the shared coordination surface reads as a dead
feature when half of it is live. Anyone who picks this up as "unclaimed work"
will spend the afternoon finding what I just found.

---

### [LOW] L-1 — 32 audit writes opt out of the SHADOW event spine; only four of them have a stated reason, and guardian consent withdrawal is not among them

**What is wrong.** `apps/web/src/server/pilot/audit.ts:35-37`:

```
  if (!event.organization_id || event.shadow_mirror === false) {
    return;
  }
```

That early return precedes both `emitShadowEvent` and
`writeShadowTelemetryEvent`, so an opted-out event enters neither
`pilot.shadow_events` nor `pilot.shadow_telemetry_events`. There are 32 such
opt-outs across 20 non-test route files.

The rationale exists, and it is a good one —
`apps/web/src/server/pilot/profileIdentity.privacy.test.ts:136-138`:

```
  it('never mirrors an identity change into the SHADOW event stream', () => {
    // shadow_mirror defaults to ON. A child's identity changes belong in the
    // audit table and nowhere else -- SHADOW's event stream feeds a model.
```

but that test's scope is one directory:
`profileIdentity.privacy.test.ts:31`:

```
const ROUTE_DIR = path.resolve(SERVER_DIR, '../../../app/api/pilot/profile');
```

The other 28 suppressions — in `parent/consent`, `admin/video-compliance`,
`admin/portrait-review`, `publications/publish`, `publications/submit`,
`compliance/violations`, `admin/gym-photos`, `scheduler` — carry no comment and
no test. The consent pair is the sharpest example:
`apps/web/app/api/pilot/parent/consent/route.ts:165` and `:182` both read
`shadow_mirror: false`, on `consent_granted` and `consent_withdrawn` — the two
event types the audit vocabulary went out of its way to create, because
"a guardian granting or withdrawing consent for their child's photo/video is a
safeguarding decision, not bookkeeping" (`auditEventTypes.ts:35-37`).

**Refutation attempted, and it changes who this finding is about.** The privacy
reasoning plainly extends to consent: a consent event names a child and a
guardian, and the SHADOW event stream feeds a model. So the *code* is probably
right. What is wrong is the *document*: `SHADOW_AUTHORITY_MODEL.md:682` and
`:701` state "Nothing operational exists outside SHADOW" and "SHADOW is the
organizational event spine" as unqualified rules, and §8's list of things that
must become SHADOW events includes "administrative action performed". There is
no privacy-suppression clause. I am reporting this as LOW, against the doc.

**Consequence.** A reader of any SHADOW read model — the event timeline, the
Knowledge Graph, the telemetry projection — cannot see that a guardian withdrew
consent for their child, and will reasonably conclude it did not happen, because
the doctrine promised the spine was complete.

---

### [LOW] L-2 — `listShadowAuthorityChecks` is the only SHADOW read model that skips athlete scoping

**What is wrong.** `apps/web/src/server/pilot/shadowReadModels.ts:332-334`:

```
export async function listShadowAuthorityChecks(context: ShadowReadContext, filters: ShadowListFilters = {}): Promise<ShadowAuthorityCheckRow[]> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);
```

No `resolveAthleteScope(context)`. Its three siblings all call it —
`listShadowEvents` at `:219`, the telemetry lister at `:280`,
`getShadowReviewProjection` at `:398` — and the resulting
`restrictToAthleteIds` / `excludeAthleteScoped` predicates appear in each of
their `where` clauses. `listShadowAuthorityChecks` has neither, while the rows
it returns carry `metadata.athlete_id` for every `domain_upsert` medical and
waiver write (`domain-upsert/route.ts:57-59`).

**Refutation attempted, and it succeeds for today.** The route is closed to the
three roles the scope would restrict —
`apps/web/app/api/pilot/shadow/authority/route.ts:17`:

```
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'platform_owner']);
```

and `resolveAthleteScope` returns `{ restrictToAthleteIds: null,
excludeAthleteScoped: false }` for every one of those roles anyway
(`shadowReadModels.ts:148`). The row mapper does apply
`sanitizeAuthorityMetadata` by role (`:376`). So the missing call changes
nothing at present. **This is latent, not live**, and is reported only so that
widening the role list later does not silently open it.

---

### [LOW] L-3 — `pilot.shadow_monthly_stats` is written by two paths, read by no product surface, and stores a hardcoded zero where its effectiveness figure should be

`apps/web/src/server/pilot/shadowArchival.ts:114`:

```
         0 AS avg_effectiveness_score, -- would come from recommendation tracking
```

A repo-wide grep for `shadow_monthly_stats` outside tests returns only two
writers (`shadowArchival.ts:38` and `:107`) and one self-check
(`:239`, inside `verifyArchiveIntegrity`). No route, page or read model consults
it. So the monthly rollup that survives archival carries a fabricated zero in a
column nothing reads — harmless today, and exactly the kind of thing that gets
wired to a dashboard tile later without anyone re-reading the comment.

---

### [LOW] L-4 — Two job types exist in the type union that the processor cannot execute and the route will not accept

`apps/web/src/server/pilot/shadowJobQueue.ts:12-18` declares six `JobType`
members including `'library_update'` and `'learning_loop'`. The processor admits
four (`shadowJobProcessor.ts:63-68`) and its `UNAVAILABLE_JOB_TYPES` set is
empty by design (`:80`). A row of either orphaned type — inserted by a future
caller, or surviving from before the arms were removed — would be claimed by
`claimNextJob`, miss the `UNAVAILABLE_JOB_TYPES` branch, and die in
`executeJob`'s default at `:370`:

```
      throw new Error(`Unknown job type: ${jobType}`);
```

which is a generic failure rather than the purpose-built
`SHADOW_JOB_TYPE_UNAVAILABLE` code, and which will retry up to `max_retries`
before settling. The comment at `:56-62` explains why the arms were removed and
is accurate; the union was simply not narrowed with them.

---

### [LOW] L-5 — Intake promotion writes medical and waiver rows for a body-supplied athlete id that is never reconciled with the intake case's own athlete

`apps/web/app/api/pilot/intake/review-action/route.ts:101-103` scopes the actor
against the *case's* athlete:

```
    if (intakeCase.primary_athlete_id) {
      await assertActorCanAccessAthlete(principal, intakeCase.primary_athlete_id);
    }
```

but the promotion branch writes against the *payload's* athlete —
`:386-389`:

```
    if (promotion.medical) {
      await upsertMedicalIntake({
        organizationId: principal.organizationId,
        athleteId: promotion.athlete.athlete_id,
```

The two ids are never compared, and the check is skipped entirely when
`primary_athlete_id` is null.

**Refutation attempted, and it takes this out of the privilege class.** The
promote branch is `organization_admin`-only (`:275-277`), and
`assertActorCanAccessAthlete` grants an organization admin every athlete in the
organization (`access.ts:296-299`), so no reachable actor gains standing they
did not already have. Promotion is additionally gated on
`intakeCase.status !== 'approved'` (`:278`) and on
`PPBF_INTAKE_PROMOTION_ENABLED` (`:281`), which production does set
(`deploy-production.yml:438`). What remains is a **provenance** defect: the
audit trail can link a medical record for child A to an intake case about child
B, and the shadow event at `:487` will carry the case id, not the mismatch.

---

### [LOW] L-6 — The "New Patterns" tile counts library sources, not patterns

`apps/web/app/admin/shadow/page.tsx:489`:

```
            ['New Patterns', growthMetrics.growth.newLibraryPatterns],
```

backed by `shadowMetrics.ts:161-164`:

```
       (SELECT COUNT(*)
        FROM pilot.shadow_library_sources
        WHERE organization_id = $1
          AND created_at > NOW() - ($2 * INTERVAL '1 day')) AS new_patterns
```

A `shadow_library_sources` row is a registered source — a document, a study, a
doctrine file — not a pattern. Under a panel headed "SHADOW Intelligence — Last
30 Days", next to "Research Created" and "Research Closed", the tile reads as
*SHADOW discovered N patterns* when it means *N sources were uploaded*. It is
the same defect class this module already fixed once and wrote down at
`shadowMetrics.ts:26-30`.

---

## Bounding an existing finding, not a new one

### B-1 — Film Study consent race (pass 3's F-11): the missing fact is now supplied, and it bounds the finding in **both** directions

Pass 3 wrote, at `PASS-03-minors-consent.md:337-339`:

> "no workflow under `.github/workflows/` references `shadow/jobs/process`, and no component or page in `apps/web` calls it either, so I could not establish *anything* that drives the queue ... The window between "consent checked" and "frames sent to the vision model" is therefore not bounded by anything I can see in this repository."

**It is now bounded.** The mechanism is confirmed exactly as pass 3 described it
— consent is asserted once, at enqueue
(`video-analysis/route.ts:106`: `await assertGuardianMediaConsent(principal.organizationId, video.athlete_id);`),
and `executeFilmStudyJob` re-validates only the role
(`shadowJobProcessor.ts:876`: `if (!['coach', 'organization_admin', 'admin'].includes(trust.role)) {`)
before `downloadPilotVideoFile(context.blobPath)` at `:892`. There is no consent
re-check on the async path. Pass 3's finding stands.

What changes is the size of the window, and honesty requires stating both halves:

- **Narrower than feared in the ordinary case.** The worker ticks every 30
  seconds and drains up to five jobs per tick, so a queued Film Study job
  normally executes within a minute of enqueue. The window is not open-ended.
- **But it has a long tail, and the tail is the part that matters.** Job TTL
  defaults to 24 hours (`shadowJobQueue.ts:112`: `if (ttlHours === undefined) return 24;`)
  and the enqueue passes no `ttlHours`. The lease is 300 seconds
  (`JOB_LEASE_SECONDS = 300`, `:108`), and the `stale_running` CTE at `:329-355`
  returns an expired-lease job to `pending` for up to `max_retries` (3, set at
  `:245`). So a job enqueued before a deploy, a restart, or a provider timeout
  can execute — and re-execute up to three times — hours after the consent check
  that authorised it, with no re-check on any attempt.
- **And it is live, not theoretical.** The worker is on in production
  (`deploy-production.yml:437`), and the vision deployment production requires
  is set (`:440`).

**I am not escalating pass 3's severity.** The brief permits CRITICAL where a
minor's data leaves the system without consent, and this path can do that — but
it requires a withdrawal to land inside the window, and establishing the driver
*shrank* the common-case window from unbounded to roughly one tick. Escalating
on the strength of a fact that narrowed the exposure would be reading the
evidence backwards. HIGH is right, and the retry/TTL tail is the part a fix
should target: re-assert consent inside the executor, immediately before
`downloadPilotVideoFile`.

---

## Checked and found sound

Recorded so the next pass does not re-examine them, and because a subsystem this
size deserves its working parts named.

- **The job processor's authority model does what its header claims.** There is
  no worker super-identity. `loadCurrentJobActor`
  (`shadowJobProcessor.ts:103-136`) re-reads the account, the membership and the
  organization status from the live database and throws
  `SHADOW_JOB_AUTHORIZATION_REVOKED`; `:173-178` additionally refuses on role
  drift and re-asserts athlete access for subject-scoped jobs. The route's own
  claim — *"a caller can only cause work already enqueued by authenticated users
  to be processed under the enqueuer's re-validated authority"* — is accurate.
- **`assertMedicalStatusAllowsRecommendation` genuinely fails closed.**
  `shadowRecommendations.ts:49-51`: `if (!status || status.status !== 'cleared')`
  throws. Its comment at `:64-77` records that this guard used to be armed by a
  caller-supplied `isMedicallySensitive` flag and explains why that was wrong
  ("A safety gate the caller decides to arm is not a gate"). That is the correct
  reasoning, correctly applied, and it is the pattern H-1's write path lacks.
- **The Film Study executor's retention rule is real.** The temp directory is
  removed in a `finally` on every path (`shadowJobProcessor.ts:949-954`), the
  frame count and byte size are bounded before the call
  (`shadowFilmStudy.ts:189-195`), the provider response body is never logged
  (`:234-236`), and the safety validation runs **before** the proposal row is
  written (`shadowJobProcessor.ts:912-917`) — with a comment explaining why
  post-hoc validation would be too late. The only durable output is a
  `pending_review` proposal row.
- **`platform_owner` is correctly excluded from PHI.** `SHADOW_PHI_ROLES`
  (`shadowRoleSets.ts:48-52`) omits it deliberately, the comment at `:43-47`
  explains the depth-versus-breadth reasoning, and the medical-status route
  restates it at `:24-26` and `:54-56`. `assertActorCanAccessAthlete`
  (`access.ts:288-290`) refuses `platform_owner` outright.
- **Archival cannot silently truncate the metrics window.**
  `ARCHIVE_COLD_DAYS = 365` (`shadowArchival.ts:151`) and `getGrowthMetrics`
  clamps to `Math.min(365, ...)` (`shadowMetrics.ts:113`), so the deletion
  cutoff and the widest reportable window coincide. I checked this specifically
  expecting a mismatch and did not find one.
- **`resolveArchiveConfig` refuses to delete minors' conversation history with
  nowhere to put it.** `shadowArchival.ts:159-165` returns `null` without a
  storage connection string, and the comment at `:155-158` states the reason.
- **`Effectiveness %` converts its units correctly.**
  `metrics/route.ts:147-150` applies `Math.round(growthMetrics.avgEffectiveness * 100)`
  to a 0–1 score before the page labels it a percentage. I checked this
  expecting an off-by-100 and it is right.
- **The metrics module already fixed one label-versus-population defect and
  documented it.** `shadowMetrics.ts:26-30` records that `recommendationsMade`
  was renamed to `reviewedOutcomes` precisely because the count was review
  throughput rendered as output volume. That is the standard L-6 falls short
  of.
- **Unavailable metrics explain themselves rather than rendering an em dash.**
  `shadowMetrics.ts:177-192` populates `unavailableReasons` with codes including
  `RATING_INPUT_NOT_BUILT`, with a comment explaining that no shipped client
  sends a rating.
- **The chat route will not enqueue async work the worker cannot drain.**
  `shadow/chat/route.ts:675` and `:898` both gate the async branches on
  `isShadowWorkerEnabled()`, returning 503 rather than queueing orphans. Turning
  the worker off strands nothing.
- **Two candidate findings were dropped after refutation.** (a) I expected
  intake promotion to let a coach write a medical record for a child outside
  their standing; it is `organization_admin`-only and org admins already reach
  every athlete in the org — what remains is the provenance issue at L-5.
  (b) I expected `listShadowAuthorityChecks`'s missing athlete scope to be live;
  the route's role list closes it — recorded as latent at L-2.

---

## Could not establish

Named rather than guessed, per the audit's own rule 4.

- **Whether the worker is actually running on the live revision.** I established
  that the deploy workflow sets `PPBF_SHADOW_WORKER_ENABLED=true` and that the
  code starts the loop on that value. I cannot see the Container App's live
  environment, and `--set-env-vars` results are not in the repository. A stale
  revision, a manual `az containerapp update` after the last deploy, or a failed
  deploy could leave the flag unset. **What would settle it:** the log line
  `'SHADOW job worker started'` (`instrumentation.ts:83`) in the Container App's
  startup logs, or `az containerapp show --query properties.template.containers[0].env`.
  Anyone with portal access can answer this in a minute, and it is worth
  answering, because it is the premise under B-1.
- **Whether any `pilot.local_findings` row exists.** M-4 establishes that the
  Knowledge Graph's "Finding" column *populates*; whether it is populated in the
  live database is a data question I cannot reach from source.
- **Whether any `shadow_medical_administrative_status` row has ever been
  written, and by which role.** H-1's practical reach depends on it. The write
  path and its readers are established from source; the population is not.
- **Whether the Film Study proposal path has executed in production.** The
  enqueue route, the executor, the vision call and the production configuration
  all exist. Whether a job has run is Actions/database history nobody in this
  session can see. It does not change the finding — a live path with a
  reachable race is a finding whether or not it has fired — but it changes how
  urgently B-1 should be fixed.
- **Whether `PPBF_SHADOW_WORKER_INTERVAL_SECONDS` is set on the live app.**
  Neither workflow sets it, so the code default of 30 s applies unless it was
  set out of band. Same evidence would settle it as the first item.

---

## De-duplication

Checked against `NETWORK_STATUS.md` (read from
`origin/docs/agent-handoff-briefs`), `docs/audit-2026-08-18/README.md`,
`PASS-02`, `PASS-03`, `PASS-04`, and `git log --oneline origin/main -40`.

- **Not re-reported:** the Film Study consent race (pass 3, F-11 — bounded above
  as B-1, not re-raised); guardian consent scope unenforced (F-12); SAS URL
  exposure (F-14); `assertShadowAuthority` cannot deny (pass 4, F-10 —
  independently verified and **corrected** above rather than restated).
- **Overlaps flagged for the passes that own them:** the README now lists a
  pass 15 (data egress) and a pass 16 (research, library, Knowledge Graph).
  M-2 and M-4 touch pass 16's surface and B-1/M-3 touch pass 15's; they are
  reported here because they are authority-model and event-model conformance
  questions, and are cited rather than duplicated. Pass 16 should treat M-4 as
  settled: the "Finding" column works, the "Pattern" column does not.
- **Corrects an existing record:** `NETWORK_STATUS.md`'s Knowledge Graph row
  (M-4) and `docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md:363` (the job
  processor answer).
- Nothing in the last 40 commits on `origin/main` touches
  `shadowAuthority.ts`, `shadowMedicalStatus.ts`, `contactClearanceGate.ts` or
  the Knowledge Graph projection. #431 (shadow-job list authorization) and #438
  (Film Study consent at enqueue) are adjacent and already accounted for.
