# Pass 15 — Data egress & integrations

Pinned to `origin/main` at `04dd116b`, on branch `docs/full-spectrum-audit-2026-08-18`.
Read-only. No application code was modified and no outbound network call was made;
this file is the pass's only write.

This pass asks one question end to end: **what data about a child leaves this
system, to whom, and what stands between it and the door?** Every other pass
asks who may reach a record from inside. This one follows the record out.

No secret, connection string, `AZURE_*` value, API key, SAS token, PIN, account
id or real name appears below. Where a value is load-bearing it is described by
shape and redacted.

---

## Method

**Read in full**: `apps/web/src/server/pilot/blob.ts` (301);
`shadowFilmStudy.ts` (256); `videoScan.ts` (196); `videoScanSweep.ts` (~210);
`videoScanPolicy.ts` (decision function, 134–200); `shadowEmbeddings.ts` (90);
`graphMailer.ts` (172); `magicLinkStore.ts` (149); `researchBridgeAuth.ts` (129);
`researchBridgeExport.ts` (137); `research-bridge/src/telemetry.ts` (111);
`document-intake/` — all nine modules (`audit.ts` 33, `auth.ts` 44,
`classifier.ts` 91, `config.ts` 41, `dataverse.ts` 118, `googleDrive.ts` 71,
`sanitize.ts` 11, `sharepoint.ts` 76, `types.ts` 52); `apps/web/next.config.ts`
(72); `staticwebapp.config.json`; and eight route files in full —
`api/document-ingest`, `api/pilot/admin/export/roster` (+ its `csv.ts`),
`api/pilot/video/[videoId]`, `api/pilot/video/review-link`,
`api/pilot/intake/document-link`, `api/pilot/payments/webhook`,
`api/pilot/shadow/research-bridge/export`, `api/public/store`, `api/pilot/wall`.

**Read in part, with the surrounding function opened before quoting**:
`shadowJobProcessor.ts` (1–80, 150–260, 300–470, 620–1000);
`app/api/pilot/shadow/chat/route.ts` (740–1000, 1215–1265, `routeLlmCall`
341–401); `shadowChat.ts` (`retrieveShadowContext` 380–470);
`shadowContextBuilder.ts` (all 257); `shadowHeavyBag.ts` (60–200);
`paymentConnect.ts` (1–60, 100–264); `federatedAuth.ts` (60–160);
`guardianConsent.ts` (60–215); `http.ts` (`jsonError` 71–176);
`db.ts` (39–100); `magicLink.ts` (105–170);
`app/api/pilot/admin/video-compliance/route.ts` (1–180);
`app/api/pilot/shadow/video-analysis/route.ts` (80–140);
`app/api/pilot/video/upload/route.ts` (1–80);
`app/parent/consent/page.tsx` (100–220);
`.github/workflows/deploy-production.yml` (300–470) and
`deploy-staging.yml` (180–300).

**Grepped, not read in full**: every `fetch(` / `axios` / `http.request` under
`apps/`, `packages/`, `scripts/`, `infra/` (server-side hits reduce to nine
call sites, all enumerated below); every `getPilotVideoSasUrl` /
`getPilotShadowSasUrl` / `generateBlobSASQueryParameters` / `blob.core.windows.net`
call site (13 non-test hits); every `console.log|error|warn|info|debug` under
`apps/web/app` and `apps/web/src` (70 non-test hits, all 70 listed and read as
one-liners); `Content-Disposition` / `text/csv` / `application/pdf` (13 hits);
`sendgrid|nodemailer|twilio|smtp|EmailClient` (0 hits outside `graphMailer`/
`magicLink`); `googleapis` (2 non-comment hits); `pdfkit` (1 hit, a dev script);
`third.part|Microsoft|Google|Azure|OpenAI|vision model|processor|vendor|shared with`
across every guardian- and athlete-facing page under `app/parent`, `app/athlete`,
`app/admin/consent` (0 hits); `privacy polic|sub-processor` across `apps/web`
and `docs/DATA_RETENTION.md` (0 hits).

**Dependency inventory**, read from `package.json` rather than assumed:
`apps/web` ships nine runtime dependencies — `@azure/storage-blob`, `googleapis`,
`jose`, `next`, `pdf-parse`, `pdfkit`, `pg`, `react`, `react-dom`. **There is no
analytics, telemetry, error-reporting, session-replay or A/B SDK in the web app
at all** — no Sentry, no Application Insights, no GA/GTM, no PostHog, no
Datadog, no LogRocket. `apps/research-bridge` is the only workspace carrying
telemetry (`@azure/monitor-opentelemetry`), and it is a separate process that
never touches athlete data. This is a real finding in the negative and is
recorded under *Checked and found sound*.

**De-duplicated against**: `docs/capabilities/NETWORK_STATUS.md` (read from
`origin/docs/agent-handoff-briefs`, since it is not on this branch);
`docs/audit-2026-08-18/PASS-02-authorization.md`, `PASS-03-minors-consent.md`,
`PASS-04-safety-gates.md`; and `git log --oneline origin/main -40`. Pass 3 owns
consent policy; this pass owns egress mechanics. Where they overlap
(60-minute SAS, Film Study enqueue-time consent) I re-derived the fact from
source and say below whether I confirm, correct or extend it.

**Not reached**: nothing was executed and no network call was made, so per this
audit's own standard nothing here is runtime proof. I could not inspect live
Azure blob container ACLs, whether a CDN or reverse proxy sits in front of the
Container App ingress, whether Defender for Storage is on, or the actual
contents of any deployed environment variable. Those are recorded under
*Could not establish* rather than guessed.

---

## Every egress path

Server-side outbound calls in this repository reduce to **nine** call sites.
Below they are grouped with the non-network egress surfaces (downloads,
anonymous reads) that also move a child's data past the platform boundary.

"Consent checked when" means the guardian media-consent gate
(`assertGuardianMediaConsent`), the only consent gate that gates anything —
see Pass 3.

| # | Egress path | What leaves | To whom | Authorised by | Consent checked when | Audited? |
|---|---|---|---|---|---|---|
| 1 | **Video content screen** — `videoScan.ts:143` `analyzeFramesWithVision` via `videoScanSweep.ts` | up to **12 JPEG frames** of a minor's uploaded video, base64-inlined in a chat-completions body | Azure OpenAI vision deployment (`AZURE_AI_ENDPOINT`, Microsoft) | **nobody** — a background sweep on the worker tick; no principal exists | **never** | verdict only (`scan_detail`, `video.scan_settled` event). No record that frames were transmitted, no actor |
| 2 | **Film Study** — `shadowJobProcessor.ts:900` `analyzeFramesWithVision` | up to **90 JPEG frames** of a minor, plus the athlete UUID in the job payload | same vision deployment | job-time re-validation of the enqueuing coach (account, org, role, athlete access) | **at enqueue only** (`shadow/video-analysis/route.ts:106`); never re-checked at execution | job row + `shadow_film_study_proposals`; no egress-specific audit event |
| 3 | **SHADOW chat (sync)** — `shadow/chat/route.ts` → Azure chat completions | the caller's free-text message, up to 10 prior turns, the athlete UUID, and **verbatim recorded near-miss incident text** for that child | same Azure OpenAI endpoint | `requirePrincipal` + `assertActorCanAccessAthlete` | **never** | yes — `pilot.shadow_chat_audit` (org, user, role, athlete_id, topic, state; message body redacted) |
| 4 | **SHADOW chat (background)** — `shadowJobProcessor.ts:382` `callAI` | the same, sliced to 12,000 chars of authorized context | same | job-time re-validation | **never** | yes, same table, `<state:queued>` |
| 5 | **Heavy Bag (sync)** — `shadowHeavyBag.ts:109` | same as #3, routed to a per-request deployment | same | as #3 | **never** | as #3 |
| 6 | **Library embeddings** — `shadowEmbeddings.ts:49` | up to 8,000 chars of **research-library text**, not athlete data | same Azure OpenAI account, embeddings deployment | server-side call from library search | n/a — no child data on this path | no |
| 7 | **Magic-link email** — `graphMailer.ts:139` → Graph `sendMail` | one plain-text body: a sign-in URL, a 15-minute notice, and the recipient address | Microsoft Graph, sending as one fixed mailbox | `assertSenderIsExpected`, managed identity | n/a — **no child data in subject or body** | token row in `pilot.magic_link_tokens`; the sent copy is retained in the mailbox |
| 8 | **Microsoft OIDC** — `federatedAuth.ts:84,145,273` | OAuth authorization code, client id/secret, PKCE verifier | `login.microsoftonline.com` | the sign-in flow itself | n/a | session issuance is audited elsewhere (Pass 1) |
| 9 | **Stripe Connect** — `paymentConnect.ts:141` | an OAuth code and the platform secret; **nothing about any child** | `connect.stripe.com` | admin-initiated, HMAC-signed state | n/a | `pilot.payment_accounts` row |
| 10 | **Document ingest → Dataverse** — `dataverse.ts:87` | the **entire uploaded PDF as base64** plus a 6,000-char extracted-text preview | Microsoft Dataverse org named by `DATAVERSE_ORG_URL` | `requireRole(['organization_admin','admin'])` only | **never** | `pilot.document_ingest_audit` row (file name, org id, uploader, destination ids) |
| 11 | **Document ingest → SharePoint** — `sharepoint.ts:51` | the **raw PDF bytes** | Microsoft Graph, one site+drive+folder from env | same | **never** | same row |
| 12 | **Document ingest → Google Drive** — `googleDrive.ts:46` | the **raw PDF bytes** | **Google LLC**, one service account + folder from env | same | **never** | same row |
| 13 | **Roster CSV export** — `admin/export/roster/route.ts:169` | every athlete's **full name, date of birth, weight class, emergency-contact name/phone/email, every guardian's name + relationship + phone + email, athlete sign-in id, attendance rate** | the requesting org admin's laptop | `requireMicrosoftAuthenticatedPrincipal` + `requireRole(['organization_admin'])`; `platform_owner` deliberately excluded | **never** | **yes, and blocking** — the audit row is written before the file is returned |
| 14 | **Video stream SAS** — `video/[videoId]/route.ts:62` | a **60-minute bearer URL** to a minor's video | whoever holds the URL | `requirePrincipal` + `assertActorCanAccessAthlete` at issue time only | **never** | **no** |
| 15 | **Compliance-queue SAS (bulk)** — `admin/video-compliance/route.ts:130-131` | **one 60-minute bearer URL per pending publication**, beside that child's full name | whoever holds the URL | `requireRole(['admin','organization_admin'])` | consent is checked on *approval*, not on *issuing the link* | **no** |
| 16 | **Video review-link SAS** — `video/review-link/route.ts:46` | a **15-minute** bearer URL to a quarantined/refused video | whoever holds the URL | `VIDEO_REVIEW_VIEW_ROLES` + `authorizeVideoScanReview` | n/a (pre-consent state) | **yes**, per issuance, with athlete id and expiry |
| 17 | **Intake document SAS** — `intake/document-link/route.ts:39` | a **15-minute** bearer URL to a child's intake paperwork | whoever holds the URL | `requireRole(['organization_admin','coach'])`, org-scoped, **no athlete scope** | **never** | **yes**, per issuance |
| 18 | **Research-bridge export (service)** — `shadow/research-bridge/export/route.ts` | sanitized research needs + approved evidence; opaque SHA-256 ids; email/phone/SSN/token-redacted text | an Entra service principal (`Research.Export` role), staging host only | JWT verified against tenant JWKS, audience, issuer, `azp` allow-list | n/a — **de-identified by construction** | no per-request audit row |
| 19 | **Research-bridge export (session)** — `research-bridge/session-export/route.ts` | same payload, **for every organization on record** when the caller holds `has_master_shadow_access` | logged-in session | `requirePrincipal` + master-shadow flag or org-admin | n/a | no per-request audit row |
| 20 | **Research-bridge → Azure AI Search** — `research-bridge/syncCore.ts` | the sanitized export, indexed | Azure AI Search index | managed identity | n/a | telemetry span only |
| 21 | **Research-bridge telemetry** — `research-bridge/telemetry.ts:11` | span names, error *shapes* (`error.name`, `code`, `statusCode`), never messages or bodies; HTTP instrumentation explicitly disabled | Azure Monitor / App Insights | connection string, optional | n/a | n/a |
| 22 | **Anonymous reads** — `api/pilot/wall`, `api/pilot/announcements/public`, `api/public/store` | wall board with **athlete display names in the operator-configured mode (default initials)** and an opaque hashed key; public notices; gear catalogue | the open internet, no session | none — IP budget on the wall | n/a | no |
| 23 | **Inbound: Stripe webhook** — `payments/webhook/route.ts` | (inbound) deauthorization events | from Stripe | HMAC-SHA256 over `t.body`, 5-minute tolerance, `timingSafeEqual` | n/a | yes |

### What is *not* here, and was checked for

No SMS or push provider exists anywhere in the repository. No mail path exists
other than the magic link. No client-side third-party script can run or call
out: `next.config.ts:30` sets `"connect-src 'self'"`, and the only external
origin the browser may load at all is blob storage for video
(`next.config.ts:29`). Portrait bytes and gym-wall photographs never get a SAS
URL at any point — `blob.ts:132-147` states the policy and I verified it holds:
`getPilotProfileContainerName` appears at no SAS call site.

---

## What a guardian is told vs. where the data actually goes

The guardian's only consent surface is `/parent/consent`. It says this:

> `              Nothing here blocks your child from training. It controls one thing: whether photos or videos of your`
> `              child may be used in gym publications. You can grant or withdraw consent at any time. If your child`
> `              has more than one guardian, every guardian must consent before anything is published.`
> — `apps/web/app/parent/consent/page.tsx:112-114`

Set that against rows 1, 2, 3, 10, 11 and 12 of the table above.

- The word **"publications"** describes a destination *inside* the gym. It does
  not describe an external vision model, and a guardian reading it has no way to
  learn that frames of their child's face are transmitted to a Microsoft-hosted
  inference endpoint on **every single upload**, before consent has any bearing
  at all.
- A grep for `third.part|Microsoft|Google|Azure|OpenAI|vision model|processor|vendor|shared with`
  across `app/parent/**`, `app/athlete/**`, `app/admin/consent/**` returns
  **zero hits**. There is no privacy policy, no processor list and no
  sub-processor disclosure anywhere in `apps/web` or in `docs/DATA_RETENTION.md`.
- **Not one recipient named in the table above is named in any guardian-facing
  text.** Not Microsoft, not Azure OpenAI, not Google, not Stripe.
- The two switches the guardian *is* shown ("Include video", "Allow public use")
  are read by no conditional — Pass 3's first HIGH, independently confirmed here
  by grepping `covers_video|coversVideo|public_use_allowed|publicUseAllowed`
  across `apps/`, `infra/`, `packages/`, `scripts/`: every hit is a column
  definition, a select list, an insert parameter, a type declaration or an API
  echo. Not one `if`, `filter`, `&&` or `where`.

The gap is therefore not "the consent form is imprecise". It is that the consent
form describes an internal-use decision while the platform's default behaviour
is an external transmission that the form does not mention and that no consent
state can prevent.

---

## Findings

### E-01 [CRITICAL] — Frames of every uploaded video of a child are sent to an external vision model with no consent check anywhere, and that transmission is the *only* path by which a video becomes visible to the consent gate at all

**What is wrong.** A coach uploads a video. It is born `quarantined`. The
in-process worker's sweep claims it, downloads the bytes, extracts up to twelve
frames, and posts them base64-inlined to the Azure OpenAI vision deployment:

> `export const VIDEO_SCAN_MAX_FRAMES = 12;`
> — `apps/web/src/server/pilot/videoScan.ts:34`

> `    const bytes = await downloadPilotVideoFile(blobPath);`
> — `apps/web/src/server/pilot/videoScan.ts:131`

> `    const analysis = await analyzeFramesWithVision({`
> `      frames,`
> `      prompt: VIDEO_CONTENT_SCREEN_PROMPT,`
> — `apps/web/src/server/pilot/videoScan.ts:143-145`

and `analyzeFramesWithVision` puts each frame on the wire as an image data URI:

> `    ...options.frames.map((frame) => ({`
> `      type: 'image_url',`
> `      image_url: { url: \`data:image/jpeg;base64,${frame.toString('base64')}\` },`
> — `apps/web/src/server/pilot/shadowFilmStudy.ts:202-205`

A repo-wide grep for `guardianConsent|GuardianMediaConsent|consent` across
`videoScanSweep.ts`, `videoScan.ts`, `videoScanPolicy.ts`, `videoSessions.ts`
and `app/api/pilot/video/upload/route.ts` returns **zero hits**. There is no
consent check on the upload, none in the sweep, none in the scan, and none in
the policy.

And this is not an optional side path — it is the mandatory gate:

> `  // Every enabled gate reported an affirmative pass. This is the ONLY path to`
> `  // a readable video.`
> — `apps/web/src/server/pilot/videoScanPolicy.ts:174-175`

So the ordering is: **every** video that Film Study's `assertGuardianMediaConsent`
gate could ever be asked about has *already* had frames of that child sent to the
vision model, by a background sweep, before any guardian consent was consulted.
The gate the platform is proud of guards a door the data has already gone
through.

It is live in production, not theoretical:

> `              PPBF_VIDEO_CONTENT_SCAN=vision \`
> — `.github/workflows/deploy-production.yml:441`

with the vision deployment name set on the line immediately above it (value
redacted here) and the worker started by:

> `              PPBF_SHADOW_WORKER_ENABLED=true \`
> — `.github/workflows/deploy-production.yml:437`

**Refutation attempted, four ways, all failed.**

1. *Is the vision endpoint really "external"?* It is an Azure OpenAI deployment,
   plausibly inside the organisation's own subscription. But the codebase itself
   settles this: the *same function*, called on the *same footage*, is treated as
   requiring guardian consent when Film Study calls it —
   `shadow/video-analysis/route.ts:106` calls `assertGuardianMediaConsent` with
   the comment "Film Study opens the same footage to AI analysis and must not be
   a side door around that gate." The platform's own doctrine says this call
   needs consent. The scan is the side door nobody named.
2. *Is it off by default?* `runContentScreen` returns `null` when
   `isFilmStudyVisionConfigured()` is false, and the sweep no-ops when
   `isVideoScanConfigured` is false. Both are satisfied in production by the
   workflow lines quoted above. The refutation fails on the deployed config.
3. *Is it audited after all?* Partly, and I decline to claim otherwise. The
   sweep writes `gates_enabled`/`gates_passed`/`content_verdict` into
   `scan_detail` and emits a `video.scan_settled` event
   (`videoScanSweep.ts`, settle block). So there *is* a durable record that the
   content gate ran. What there is not is any record framed as a disclosure —
   no actor, no recipient, no "N frames of athlete X were transmitted to
   deployment Y at time T". The finding rests on the **absent consent check**,
   not on an absent audit.
4. *Is a safety screen legitimately exempt from consent?* This is the strongest
   defence and it is a real one: a platform holding minors' video arguably must
   screen it before any human sees it, and making that screen consent-gated
   would mean unscreened footage of children sitting in storage. I accept that
   as a defensible design. It does not rescue the finding, because the guardian
   is never told. An exemption a guardian is not informed of is not an
   exemption; it is an undisclosed transfer. The fix that costs nothing and
   narrows no gate is disclosure on `/parent/consent`.

**Consequence for a real child.** A parent who has never signed anything, or who
has actively withheld media consent, has their child's face sent to a
third-party inference endpoint within roughly thirty seconds of a coach pressing
Upload. The frames are deleted from the container afterwards
(`videoScan.ts:158`, a `finally` block — verified) but they left the building
first, and the guardian's consent decision — granted, withheld, or never asked —
had no bearing on it whatsoever.

---

### E-02 [HIGH — corroborates Pass 3, with one correction and one extension] Film Study's consent check happens at enqueue and never again; the queue driver *is* establishable, and a retry widens the window well past one tick

**Confirmed independently.** The route gates correctly:

> `    await assertGuardianMediaConsent(principal.organizationId, video.athlete_id);`
> — `apps/web/app/api/pilot/shadow/video-analysis/route.ts:106`

and the executor re-validates identity, not consent. `processNextShadowJob`
re-checks three things and consent is not among them:

> `    const currentActor = await loadCurrentJobActor(job);`
> `    if (currentActor.role !== job.role) {`
> `      throw new Error('SHADOW_JOB_AUTHORIZATION_CHANGED');`
> `    }`
> `    if (job.subjectId) {`
> `      await assertActorCanAccessAthlete(currentActor, job.subjectId);`
> `    }`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:172-179`

**Correction to Pass 3.** Pass 3 recorded under *Could not establish* that it
"could not establish *anything* that drives the queue", and concluded the
enqueue→egress window "is therefore not bounded by anything I can see in this
repository". That is not correct on current `main`. The driver is the Next.js
instrumentation hook:

> `  const { processNextShadowJob } = await import('./src/server/pilot/shadowJobProcessor');`
> — `apps/web/instrumentation.ts:31`

started only when the flag is set:

> `  return env.PPBF_SHADOW_WORKER_ENABLED === 'true';`
> — `apps/web/src/server/pilot/shadowJobWorker.ts:28`

which production sets (`deploy-production.yml:437`). Default cadence is 30
seconds, clamped 5–600 (`shadowJobWorker.ts:20-22`), five jobs per tick. So in
the normal case the window is tens of seconds, not unbounded. **The severity of
the race is lower than Pass 3 implied and I am recording that in the direction
that argues against my own pass.**

**Extension Pass 3 did not draw.** The window is *not* uniformly tens of
seconds. `shadowJobQueue.ts` gives every job `retry_count`/`max_retries` and a
lease, and a job whose lease expires is reclaimed
(`shadowJobQueue.ts:355` — `AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())`).
A Film Study job that fails its first attempt — vision provider down, blob read
timeout, a `SHADOW_FILM_OBSERVATION_FILTERED` throw — is retried later. There is
no upper bound in the code on how long after enqueue a retried job may run, and
its consent snapshot is still the one taken at enqueue. A withdrawal that lands
between attempt one and attempt two changes nothing.

**Refutation attempted.** I looked for the consent re-check the publish path
already has — `assertGuardianMediaConsentWithClient` with `for share`, which
exists precisely to serialise against a withdrawal (`guardianConsent.ts:150-183`).
It is called from `publications/publish` and `admin/video-compliance` and from
nowhere on the async path: grepping `assertGuardianMediaConsent` across
`shadowJobProcessor.ts`, `shadowJobQueue.ts`, `shadowJobWorker.ts` and
`app/api/pilot/shadow/jobs/**` returns nothing. The refutation failed.

**Consequence for a real child.** As Pass 3 states, with the retry path added:
a guardian withdraws on Tuesday, is truthfully told published media has been
retracted, and a Film Study job that failed once on Tuesday afternoon runs on
Wednesday, sends ninety frames of their child to the vision model, and writes a
durable observation about them.

---

### E-03 [HIGH] `POST /api/document-ingest` ships whole uploaded PDFs to *three* separate external destinations — including Google — with no consent check, no athlete scoping, and one global destination shared by every organization

**What is wrong.** One route, gated only on role:

> `    requireRole(principal, ['organization_admin', 'admin'])`
> — `apps/web/app/api/document-ingest/route.ts:95`

takes an uploaded PDF and fans it out. The whole file, base64-encoded, plus a
6,000-character extract of its text, goes into a Dataverse record:

> `      documentbody: pdfBase64,`
> — `apps/web/src/server/document-intake/dataverse.ts:72`

and the raw bytes go, in parallel, to SharePoint and to Google Drive:

> `        await Promise.all([`
> `          uploadToSharePoint(getPipelineConfig().sharepoint, fileName, rawBuffer),`
> `          uploadToGoogleDrive(getPipelineConfig().googleDrive, fileName, rawBuffer),`
> `        ])`
> — `apps/web/app/api/document-ingest/route.ts:247-250`

Three things make this worse than "an admin uploads a document".

*One — the content is exactly the child data this platform exists to protect.*
The classifier's own rule table tells you what it expects to receive:
`['safety', 'incident', 'injury']`, `['parent', 'guardian', 'family']`,
`['athlete', 'round', 'sparring', 'workout']`
(`classifier.ts:11-53`). An incident note, a guardian form, a medical release.
Nothing filters, redacts or classifies before transmission — `classifyPdfText`
runs *for routing*, not for gating, and the extracted text is sent regardless of
what it matched.

*Two — there is no consent check of any kind.* Not `assertGuardianMediaConsent`,
not a waiver read, nothing. The document is not linked to an athlete at all, so
there is nothing to check consent against even in principle.

*Three — the destination is not organization-scoped.* `getPipelineConfig()`
reads one set of process-wide environment variables:

> `      serviceAccountJson: required('GOOGLE_SERVICE_ACCOUNT_JSON'),`
> `      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,`
> — `apps/web/src/server/document-intake/config.ts:37-38`

`principal.organizationId` is used for the audit row and for nothing else. Every
gym on a multi-tenant deployment writes into **the same Google Drive folder, the
same SharePoint drive and the same Dataverse table**, under a filename derived
only from the original name and a timestamp (`sanitize.ts:1-11`). The tenancy
boundary the rest of this codebase enforces obsessively is absent the moment the
bytes leave.

**Refutation attempted, and it succeeded in part — which is why this is HIGH and
not CRITICAL.** I checked whether this can actually fire. Neither
`deploy-production.yml` nor `deploy-staging.yml` sets `DATAVERSE_*`, `GRAPH_*`,
`SHAREPOINT_*` or `GOOGLE_SERVICE_ACCOUNT_JSON` — a grep for those names across
`.github`, `infra`, `docs` and `scripts` returns hits only in
`docs/archive/BACKEND_TRUTH_AUDIT.md`. `required()` throws on a missing
variable (`config.ts:11-17`), and `getPipelineConfig()` is called *before* the
first outbound call, so an unconfigured deployment **fails closed** with a 500
and a `failure` audit row. `PPBF_INGEST_MOCK_MODE` is likewise unset, so the
mock branch is not what is protecting it — the missing credentials are.
**As deployed today, nothing leaves through this route.** I could not verify the
live Container App's variable set, only the workflows that write it, so this is
"no configured path in the repository", not "proven inert in production".

That leaves a route that is compiled, deployed, reachable by any org admin, and
one environment-variable change away from a three-vendor egress of children's
paperwork with no consent gate and no tenant isolation. It also has no UI: a
grep for `document-ingest` across `apps`, `packages`, `scripts` and `.github`
finds the route, a dev script, and generated Next type files — no page calls it.
A capability nobody can see is a capability nobody reviews.

**Consequence for a real child.** An admin uploads a safety incident report
naming a twelve-year-old and describing an injury. On the day the credentials
are set, that PDF is copied to Google's servers under a service account this
repository configures but does not scope, to a SharePoint folder shared with
every other gym on the deployment, and into a Dataverse row carrying the full
document body and six thousand characters of its text. No guardian was asked and
no guardian could have refused.

---

### E-04 [MEDIUM] `shadowFilmStudy.ts`'s own header states the opposite of what the module now does — anyone assessing egress from the docstring concludes no child's frames leave

**What is wrong.** The module that performs both vision calls opens with:

> `// This is prerequisite scaffolding, not the feature. #103 orders measured`
> `// facts (vision latency and token spend per frame batch, in-container`
> `// extraction time) BEFORE the executor is written, so this module currently`
> `// powers only the admin measurement diagnostic`
> `// (/api/pilot/shadow/film-study/diagnostic). The film_study job type stays`
> `// SHADOW_JOB_TYPE_UNAVAILABLE in shadowJobProcessor.ts until those`
> `// measurements exist and the safety design on #103 is approved.`
> — `apps/web/src/server/pilot/shadowFilmStudy.ts:4-10`

Both sentences are false on current `main`. The unavailable set is empty:

> `const UNAVAILABLE_JOB_TYPES = new Set<JobType>([]);`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:80`

and the module powers three things, not one: the diagnostic (synthetic frames
only), the Film Study executor (`shadowJobProcessor.ts:900`), and the content
screen that runs on every upload (`videoScan.ts:143`). The third is not
mentioned in the header at all.

**Refutation attempted.** I checked whether the header is merely stale in a
harmless way — whether some other comment in the module names the content
screen. It does not; `runContentScreen` lives in `videoScan.ts` and imports
across. So the only place a reader is told what this module does says it does
almost nothing.

**Why this is an egress finding and not a docs finding.** `shadowFilmStudy.ts`
is where an auditor, a reviewer, or the next agent goes to answer "does a child's
face leave this platform?". The file answers "no, this is scaffolding". Pass 12
owns doc drift in general; this specific instance is the one that would cause a
reader to *miss E-01*, so it belongs here.

---

### E-05 [MEDIUM] Four responses carrying SAS bearer URLs to minors' video and intake paperwork set no `Cache-Control`, while every sibling response holding minor data sets `no-store`

**What is wrong.** `getPilotVideoSasUrl` defaults to sixty minutes — verified
directly, as instructed, rather than taken from Pass 3:

> `export function getPilotVideoSasUrl(blobPath: string, expiryMinutes = 60): string {`
> — `apps/web/src/server/pilot/blob.ts:122`

and the arithmetic is minutes (`blob.ts:114`). Pass 2 and Pass 3 both record the
expiry and the missing audit. What neither records is that the *responses* are
not marked uncacheable. `video/[videoId]` returns the URL in a bare JSON body:

> `    return NextResponse.json({`
> `      ...row,`
> `      blob_path: undefined,`
> `      stream_url: sasUrl,`
> `    });`
> — `apps/web/app/api/pilot/video/[videoId]/route.ts:64-68`

No `Cache-Control`, no `Pragma`, nothing. The same is true of
`admin/video-compliance` (returns `NextResponse.json({ ok: true, items, ... })`
at line 167, with a SAS per row), `video/review-link` (line 65) and
`intake/document-link` (line 57).

Compare what the platform does everywhere else it hands out minor data:

> `        'Cache-Control': 'no-store, no-cache, must-revalidate',`
> — `apps/web/app/api/pilot/admin/export/roster/route.ts:180`

> `  'cache-control': 'private, no-store, max-age=0',`
> — `apps/web/app/api/pilot/shadow/research-bridge/session-export/route.ts:36`

and the portrait route serves bytes with `private, no-store` (`blob.ts:143-146`
states the stance; `profile/photo/[accountId]/route.ts` implements it).

**Refutation attempted.** Next.js route handlers are dynamic by default and Next
does not add a caching header for them, but it does not add `no-store` either —
so the response leaves with no cache directive, and an intermediary applying
heuristic freshness to a 200 JSON body is standard behaviour. I then checked
whether anything upstream compensates: `next.config.ts:38-51` sets CSP, XFO,
nosniff, Referrer-Policy, Permissions-Policy and HSTS — **no `Cache-Control`** —
and `staticwebapp.config.json` sets no headers at all (it is routing and
navigation fallback only, and `next.config.ts:59-61` notes the static-export
path ignores the header block anyway). I could not establish whether a CDN or
reverse proxy sits in front of the Container App ingress; that is the fact that
would settle whether this is exploitable rather than merely inconsistent, and it
is recorded below.

**Consequence for a real child.** A shared or proxied cache retaining one
compliance-queue response retains a batch of one-hour bearer URLs to videos of
named children, each usable by anyone who obtains it, from any address, with no
session and no further check.

---

### E-06 [MEDIUM] Every athlete-scoped SHADOW turn sends that child's recorded near-miss incident text to an external model, and a minor can trigger it about themselves

**What is wrong.** When a chat turn names an athlete, the authorized context is
not a bare scope statement — it carries the child's recorded safety events
verbatim:

> `      return \`- [E:${nearMiss.near_miss_id}] ${date} ${nearMiss.severity.toUpperCase()}: ${description}\`;`
> — `apps/web/src/server/pilot/shadowChat.ts:443`

with `description` sliced to 240 characters of freeform incident prose
(`shadowChat.ts:442`). That string is joined into `authorizedContextOutput`
(`shadow/chat/route.ts:854-868`) and posted to the Azure chat-completions
endpoint. There is no consent check on this path: grepping
`assertGuardianMediaConsent|guardianConsent` in `app/api/pilot/shadow/chat/route.ts`
returns nothing.

The caller need not be an adult. `/api/pilot/athlete/chat` forwards straight
into the same handler and pins the subject to the caller's own athlete id:

> `    requireRole(principal, ['organization_admin', 'admin', 'athlete']);`
> — `apps/web/app/api/pilot/athlete/chat/route.ts:12`

> `        ...(principal.role === 'athlete' ? { athleteId: principal.athleteId } : {}),`
> — `apps/web/app/api/pilot/athlete/chat/route.ts:24`

So a child asking SHADOW a training question causes their own recorded near-miss
history — the platform's record of times they were nearly hurt — to be
transmitted to an external inference endpoint, along with whatever they typed.

**Refutation attempted, and it succeeded in part.** Three real controls exist and
I record them rather than omitting them:

1. High-risk classifications never reach the provider. `routeLlmCall` returns the
   canned fallback **before** building the prompt:
   > `  if (highRiskClassification && highRiskClassification in FALLBACK_RESPONSES) {`
   > `    return {`
   > `      llmResponse: FALLBACK_RESPONSES[highRiskClassification],`
   > — `apps/web/app/api/pilot/shadow/chat/route.ts:355-357`
   A child's concussion question is answered locally and is not sent anywhere.
2. The turn **is** audited — `pilot.shadow_chat_audit` records org, user, role,
   `athlete_id`, topic and state, with the message body deliberately replaced by
   `` `<redacted:${effectiveTopic}>` `` (`shadow/chat/route.ts:1226-1233`). So the
   *fact* of an athlete-scoped external call is recoverable. That is why this is
   MEDIUM, not CRITICAL.
3. `assertActorCanAccessAthlete` runs before the context is built
   (`shadowChat.ts:384-395`), so the near-miss text belongs to a child the caller
   may already read.

What survives all three: no consent state is consulted, and no guardian-facing
text names an external model as a recipient of anything, let alone of their
child's incident history.

**Consequence for a real child.** The gym records that a fourteen-year-old was
nearly injured, in a coach's own words. Every subsequent SHADOW question about
that athlete — including ones the athlete asks themselves — republishes those
words to a third-party endpoint. The guardian has consented to "photos or videos
… used in gym publications" and to nothing else.

---

### E-07 [LOW] Two log statements pass a raw error object straight to `console`, against this codebase's own written and implemented doctrine

**What is wrong.** The doctrine is stated and implemented in `db.ts`:

> `// Bounded, sanitized log payload for an idle-connection pool error. Never`
> `// includes the client object, connection parameters/string, credentials,`
> `// query text/parameters, socket internals, or the original error message --`
> — `apps/web/src/server/pilot/db.ts:49-51`

Sixty-eight of the seventy `console.*` call sites in `apps/web/app` and
`apps/web/src` honour it — they log a fixed event name plus, at most, a
validated SQLSTATE, an `errorClass`, or an HTTP status. Two do not:

> `    console.error('document-ingest-audit-write-failed', error)`
> — `apps/web/src/server/document-intake/audit.ts:31`

> `    console.warn('Durable rate limit unavailable, falling back to in-memory limiter', error);`
> — `apps/web/src/server/pilot/rateLimit.ts:64`

The first is the more interesting one: the row whose insert just failed carries
`file_name`, a `message`, and a `details` JSON holding `organizationId` and
`uploadedByAccountId`. A `pg` `DatabaseError` for a constraint or type failure
can carry `detail`, `table`, `column` and `where` — the exact class of value the
`db.ts` helper exists to keep out of logs — and it is serialised whole.

**Refutation attempted.** I checked whether `pg` errors are safe to log wholesale
here: they are not, which is precisely why `sanitizedSqlState` and
`sanitizedPoolErrorLog` were written, and why routes such as
`admin/video-compliance/route.ts:27-33` and `payments/webhook/route.ts:40-45`
extract only the code. Two call sites simply predate or missed the pattern.
I also checked whether either is on a path handling child data: the second is
not (a rate-limit connection error), which is why this is LOW rather than
MEDIUM. The first is.

**Consequence for a real child.** Small and indirect: a log aggregator entry
containing a document filename and an organization id at the moment an ingest
audit failed. It matters mainly because the platform's log hygiene is otherwise
good enough that a reader will reasonably assume it is uniform.

---

### E-08 [LOW] `api/public/store` asserts it is the only route answering an anonymous caller with organization data; three routes do, and one of them serves children's display names

**What is wrong.**

> ` * This is the only route in the platform that answers an anonymous caller with`
> ` * organization data, so it is written to be boring on purpose:`
> — `apps/web/app/api/public/store/route.ts:10-11`

`GET /api/pilot/wall` and `GET /api/pilot/announcements/public` both answer
without a session. Neither calls `requirePrincipal` — grepping for it in either
file returns nothing — and the wall route says so itself:

> ` * Unauthenticated, like GET /api/pilot/announcements/public and for the same`
> ` * reason: the client is a browser on a television that nobody logs into`
> — `apps/web/app/api/pilot/wall/route.ts:17-18`

The wall payload carries athlete display names, gated per athlete by
`wallDisplay.ts` with the operator default `initials`.

**Refutation attempted, and the wall came out clean.** I checked whether the wall
is actually an exposure and it is not: the org id is never taken from the caller
(`wall/route.ts:49`), `athlete_id` never appears, names default to initials, the
read is IP-budgeted (`wall/route.ts:38`), it carries `Cache-Control: no-store`,
and its catch deliberately avoids `jsonError` so no diagnostic reaches a screen
in a public room. The defect is the *claim*, not the route.

**Consequence for a real child.** None directly. It matters because the comment
is exactly the sort a reviewer trusts when deciding whether a change widens the
anonymous surface — and it would tell them, wrongly, that there is only one such
surface to reason about.

---

## Checked and found sound

Recorded because a pass that reports only defects gives a false picture of a
platform that gets a great deal of this right.

- **No third-party analytics, telemetry, error reporting or session replay in
  the web app, at all.** Nine runtime dependencies, none of them a tracker.
  Nothing ships request data, user ids or stack traces off-box from `apps/web`.
  The only telemetry in the repository is `research-bridge`'s Azure Monitor
  span emitter, which disables HTTP, SDK, database, redis and console
  instrumentation explicitly (`research-bridge/src/telemetry.ts:16-25`), reduces
  every error to its *shape* rather than its message
  (`telemetry.ts:51-86`), and runs in a process that only ever handles the
  de-identified export.
- **The browser cannot call a third party.** `"connect-src 'self'"`
  (`next.config.ts:30`). The single external origin permitted is blob storage,
  for video only (`next.config.ts:29`).
- **Portraits and gym-wall photographs never receive a SAS URL.** The stance is
  written down (`blob.ts:132-147`) and, unlike the video container, it holds:
  `getPilotProfileContainerName` appears at no SAS call site.
- **The roster CSV export is the best-governed egress in the platform.**
  Organization admin only with `platform_owner` deliberately excluded
  (`export/roster/route.ts:127-132`); a Microsoft-authenticated session required;
  org id taken from the session and never the query; the column set is a
  separate allowlist read by key rather than by iterating the row, so a widened
  query cannot widen the file (`csv.ts:1-12`); formula-injection guarded; and the
  audit row is written **before** the file is returned, so an unwritable audit
  fails the export. It moves a great deal of child data and it does so
  answerably.
- **`assertGuardianMediaConsent` fails closed on a child with no guardian on
  file.** I specifically tested this hypothesis — an empty guardian list making
  `missingParentIds` empty and the check vacuously pass — and it is guarded in
  both variants: `checkGuardianMediaConsent` returns `ok: false`
  (`guardianConsent.ts:111-113`) and the transactional variant throws
  (`guardianConsent.ts:168-170`).
- **The magic link is the only email this platform sends, and it contains no
  child data.** One function, plain text only, no attachments, no HTML, no bulk
  (`graphMailer.ts:25-31`); the sender is asserted against config
  (`assertSenderIsExpected`); the Graph error *body* is never logged because it
  echoes the recipient, and only an error code matching a shape an email address
  cannot have is passed through (`graphMailer.ts:92-102`). The body names no
  child, no gym record and no third party (`magicLink.ts:148-158`).
- **The research-bridge export is genuinely de-identified**, not merely
  described as such: subject-linked rows are filtered out by key
  (`researchBridgeExport.ts:60-63`), ids are opaque SHA-256 digests
  (`:52-58`), and free text is scrubbed of emails, US phone numbers, SSNs,
  bearer tokens and secret assignments before it leaves
  (`:34-50`). Its service-account door verifies issuer, audience, tenant, `azp`
  against an allow-list and a `Research.Export` role, and is inert outside a
  named staging host (`researchBridgeAuth.ts:26-35, 113-120`).
- **The Stripe webhook is the only inbound integration and it is properly
  authenticated**: timestamp tolerance, HMAC-SHA256 over `t.body`, and
  `timingSafeEqual` with a length pre-check (`paymentConnect.ts:231-264`).
  Unknown event types are acknowledged and ignored. Nothing about any child
  crosses this boundary in either direction.
- **`jsonError` cannot leak internals.** The 500 branch replaces the message
  entirely and logs only a sanitized class name and a pattern-validated code
  (`http.ts:154-171`).
- **High-risk chat classifications never reach the model** (`chat/route.ts:355`),
  and the AI provider's response body is never read, persisted, returned or
  logged on failure — stated and implemented at both call sites
  (`shadowFilmStudy.ts:231`, `shadowJobProcessor.ts:409`).
- **Extracted video frames never persist.** Both the Film Study executor
  (`shadowJobProcessor.ts:948-952`) and the content screen
  (`videoScan.ts:157-159`) remove the temp directory in a `finally`, on every
  path out.
- **The Film Study diagnostic uses synthesised footage only** — `testsrc2` via
  lavfi, "nothing is read from disk or network"
  (`shadowFilmStudy.ts:65-67`) — so the measurement path sends no real child's
  frames anywhere.
- **`/api/pilot/admin/athlete-pin-directory` returns `has_pin` as a boolean,
  never a PIN or a hash** (`route.ts:35`).
- **Logging discipline is, with the two exceptions in E-07, excellent**: 68 of
  70 call sites log a fixed event name plus a validated code or class. No SAS
  URL, no request body, no provider response body and no athlete name appears in
  any log statement in the repository. Account ids and, in two places, athlete
  ids do appear — these are opaque identifiers, re-identifiable only by someone
  who also holds the database, which is a defensible line and is noted rather
  than filed.

---

## Could not establish

Stated as holes rather than filled in, and each paired with what would settle it.

1. **Whether a CDN, WAF or caching reverse proxy sits in front of the Container
   App ingress.** This decides whether E-05 is an exploitable retention of
   bearer URLs or only an inconsistency. *Settled by*: the Azure Front Door /
   ingress configuration for the production Container App, or a live
   `curl -I` against a SAS-bearing endpoint showing what an intermediary
   returns.
2. **The actual environment-variable set on the deployed apps.** I read the two
   deploy workflows, which are what *writes* the variables — but `az containerapp
   update --set-env-vars` cannot unset, and the workflow comments say so
   explicitly (`deploy-production.yml:305-307`). A stale `DATAVERSE_*`,
   `GRAPH_*` or `GOOGLE_SERVICE_ACCOUNT_JSON` set by hand at any point in the
   past would still be live and would make E-03 active rather than latent.
   *Settled by*: `az containerapp show --query properties.template.containers[].env`
   for both apps.
3. **Which Azure region and tenant the AI endpoint resolves to, and what the
   provider's data-retention terms are for it.** `AZURE_AI_ENDPOINT` is a
   secret reference; nothing in this repository reveals whether the deployment
   has abuse-monitoring retention enabled or is zero-retention. This materially
   changes how long frames of a child persist on the provider side after
   E-01's transmission. *Settled by*: the Azure OpenAI resource configuration
   and its data-processing addendum.
4. **Whether Microsoft Defender for Storage malware scanning is enabled on the
   storage account.** Both workflows deliberately leave `PPBF_VIDEO_MALWARE_SCAN`
   unset and say why (`deploy-production.yml:403-412`), so the content screen is
   the *only* gate — which is what makes E-01's vision call unavoidable rather
   than one option among two. *Settled by*: the storage account's Defender
   configuration.
5. **Whether the `pilot.document_ingest_audit` table carries an
   `organization_id` column or only the `details` JSON.** `audit.ts:14-20`
   inserts five columns and puts the org id inside `details`. I did not read the
   migration. This affects whether an ingest egress is queryable per gym.
   *Settled by*: the `document_ingest_audit` migration in `infra/azure/`.
6. **Whether any operator has ever exercised `/api/document-ingest`.** No UI
   calls it and no gate script drives it, so the only evidence would be rows in
   the audit table. *Settled by*: `select count(*) from pilot.document_ingest_audit`.
7. **Whether the research-bridge session export has ever been called with
   `has_master_shadow_access`**, and therefore how many organizations' sanitized
   payloads have been returned in one response. The route writes no audit row.
   *Settled by*: adding one, or by request logs.

---

## De-duplication note

- **Pass 3** owns the consent model and the guardian-facing scope switches;
  E-02 corroborates its Film Study finding and **corrects** its "could not
  establish what drives the queue" conclusion, and E-05 extends rather than
  repeats its SAS finding (Pass 3 owns expiry and audit; this pass adds the
  missing cache directive). The 60-minute default was re-derived from
  `blob.ts:122` as instructed, not taken on trust — it is correct as recorded.
- **Pass 2** records the video-detail SAS route as MEDIUM for expiry and audit;
  E-05 does not re-file that. It also records eleven coach-reachable routes
  checking only role — `intake/document-link` is one of them, and this pass adds
  only that the object handed out there is a bearer URL to a child's intake
  paperwork.
- **NETWORK_STATUS.md** contains no egress analysis; nothing here duplicates it.
- **`git log --oneline origin/main -40`** shows `a20fde5a` ("Gate Film Study
  analysis requests on guardian media consent") and `e0d25505` ("File a safety
  escalation for terminal video scan verdicts"). E-01 is the observation that
  those two commits touch the same footage and only one of them consults a
  guardian — it is not fixed by either.
