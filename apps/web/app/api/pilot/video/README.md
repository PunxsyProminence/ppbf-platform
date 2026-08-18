# Video capture, quarantine and release -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

Footage of youth athletes, from upload to the moment it becomes watchable.

`pilot.video_sessions` rows are born `status = 'quarantined'`. Every reader in
the platform refuses anything that is not `'ready'`. Two things can promote a
row, and only two: the automated scan sweep, or a named human.

Routes under `app/api/pilot/video/`:

- `upload/route.ts` -- `POST` a file. Always lands `quarantined`.
- `list/route.ts` -- `GET` what this actor may see, per role.
- `[videoId]/route.ts` -- `GET` one video with a short-lived stream URL.
  `'ready'` only.
- `[videoId]/release/route.ts` -- `POST` the **coach's** release of footage the
  scanner deferred.
- `review-link/route.ts` -- `POST` a 15-minute link so a reviewer can *watch*
  a quarantined clip.
- `scan-review/route.ts` -- `POST` the **administrator's** escalation decision on
  a quarantined clip, including one the content screen refused.

Server modules: `videoUploadPolicy.ts` (bytes), `videoScanPolicy.ts` (the
promotion rules, pure), `videoSessions.ts` (claim/settle/review state machine),
`videoScanSweep.ts` + `videoScan.ts` (the worker), `videoScanReview.ts` (shared
human-review authorization).

**Separate capability, separate gates:** whether a `ready` video may be
*published* -- and whether its subject's guardians consented -- is the video
publication compliance console, gated at
`app/api/pilot/admin/video-compliance/route.ts` and documented at
`app/api/pilot/parent/consent/README.md`. `'ready'` means the safety scan
passed. It says nothing about consent.

## What it may do

- Accept a bounded MP4/MOV/AVI/WebM/MPEG upload from a coach or organization
  admin, and hold it unreadable.
- Promote to `'ready'` when **every enabled** scan gate returned an affirmative
  pass.
- Let the coach who filmed a session release footage the scanner could not
  decide.
- Let an organization admin resolve a clip the content screen refused.
- Let either reviewer watch the clip first, and record who watched what.
- Tell an uploader honestly whether anything will actually review their video.

## What it may NOT do

- It may not promote a video on absence of a verdict (gate 3).
- It may not promote anything at all when no scanner is configured (gate 4).
- It may not let a coach overturn a content-screen refusal (gate 6).
- It may not let anyone release a file a malware scanner flagged (gate 7).
- It may not let a late machine verdict erase a human refusal (gate 8).
- It may not let a coach reach a quarantined clip somebody else uploaded
  (gate 9).
- It may not disclose that a video exists to someone not entitled to know
  (gate 10).
- It has no operator "mark ready" button. That option was explicitly rejected.

## What must be true before a video becomes watchable

There are exactly three doors out of `quarantined`, and each has its own list.

**Door A -- the scan sweep promotes it.** All must hold:

| # | Must be true | If it is not |
|---|---|---|
| 1 | At least one scan gate is enabled (`PPBF_VIDEO_MALWARE_SCAN=defender_index_tags` and/or `PPBF_VIDEO_CONTENT_SCAN=vision`) | decision `hold`, `scan_state = 'unconfigured'`, stays quarantined forever |
| 2 | Every enabled gate returned an affirmative pass (`malware = 'clean'`, `content = 'pass'`) | `retry` / `needs_human_review` / `blocked` / `infected` -- never a promotion |
| 3 | The row is still `quarantined` and not `scan_state = 'blocked'` at settle time | the settle is refused; the outcome is appended to `scan_detail` instead |

**Door B -- the uploading coach releases it.** All must hold:

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | Role is `organization_admin` or `coach` | 403 `Forbidden: role not allowed` | -- |
| 2 | The video is in the caller's organization, and a non-admin caller is the **uploader** | 404 `Not found` | -- |
| 3 | `status = 'quarantined'` | 409 `This video has already been released.` / `A video held in "<status>" cannot be released.` | -- |
| 4 | `scan_state` is `needs_human_review` or `unconfigured` | 409, and for `blocked`: `The content screen refused this video. It cannot be released here; ask an administrator to review it.` | Ask an admin (door C) |
| 5 | Conditions 3 and 4 still hold at the instant of the write | 409 `This video changed state before it could be released. Reload and try again.` | Reload |

**Door C -- an organization admin resolves it.** All must hold:

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | Role is `organization_admin` (`VIDEO_REVIEW_DECIDE_ROLES`) | 403 `Forbidden: role not allowed` | An admin decides -- not the coach who filmed it |
| 2 | The video exists in this organization | 404 `Not found`, reason `VIDEO_SESSION_NOT_FOUND` | -- |
| 3 | The row's `athlete_id`, if set, is one the actor may access | 404 `Not found` (same shape) | -- |
| 4 | `status !== 'infected'` | 409 `A scanner found malware in this file. It cannot be released by review.`, reason `VIDEO_SESSION_INFECTED` | Nothing. Ever. |
| 5 | `status === 'quarantined'` | 409 `This video is '<status>', so there is nothing to review.`, reason `VIDEO_SESSION_NOT_QUARANTINED` | -- |
| 6 | `decision` is `approve` or `block` | 400 `Missing decision: expected "approve" or "block"` / `Unsupported decision: ...` | Fix the request |
| 7 | Condition 5 still holds at the write | 409 `This video changed state while you were reviewing it. Reload and check before deciding again.`, reason `VIDEO_SESSION_CHANGED` | Reload |

`block` on door C leaves the row `quarantined`, so a refusal changes nothing
about what anyone can watch.

## Gates

### Gate 1 -- upload is coach-or-admin, and the file is validated before it is stored

- **What it checks:** `requireRole(principal, ['organization_admin', 'coach'])`;
  then transport (multipart, bounded `Content-Length`); then the declared
  name/type/size; then the first 16 bytes against the declared type; then, if an
  `athlete_id` was supplied, `access.ts:assertActorCanAccessAthlete`.
- **Where it runs:** `app/api/pilot/video/upload/route.ts:POST`, using
  `videoUploadPolicy.ts:validateVideoUploadTransport`, `:describeVideoUpload`,
  `:validateVideoUploadSignature`.
- **What it refuses with:** 415 `A multipart video upload is required.`;
  411 `A bounded Content-Length is required.`;
  413 `The video upload is too large.`;
  400 `Missing video file`;
  415 `Only bounded MP4, MOV, AVI, WebM, and MPEG video files are accepted.`;
  415 `The video content does not match its declared file type.`;
  400 `Video title or notes exceed the allowed size.`;
  429 with a `Retry-After` header (`ShadowRateLimitExceeded`, budget
  `video_upload`); and the `access.ts` `Forbidden:` messages at 403 for a
  non-accessible `athlete_id`.
- **Why it exists:** the file is attributed to a named child and stored in the
  gym's container. The signature check is what stops a declared `.mp4` from
  being something else entirely; the athlete check is what stops a coach
  attributing footage to a child they have no standing with.

### Gate 2 -- every upload is born quarantined

- **What it checks:** nothing; it is the literal in the insert.
- **Where it runs:** `app/api/pilot/video/upload/route.ts:POST` inserts
  `status` as the constant `'quarantined'`. `videoSessions.ts`'s own type comment
  records the invariant: "the scan sweep (#49) is the only thing in the platform
  that writes `'ready'`" -- plus the two human doors below.
- **What it refuses with:** the upload returns **202**, not 200, with
  `status: 'quarantined'`, and either
  `Uploaded. The video stays quarantined until an automated scan clears it.` or
  `Uploaded. No video scanner is configured in this environment, so this video will stay quarantined until an administrator enables one.`
- **Why the honest message matters:** before the scan sweep existed, nothing in
  the platform could move a video off `'quarantined'`, "while this response still
  reported it as accepted for security review". The uploader is now told which
  case they are in "rather than being left to infer it from a video that never
  appears."

### Gate 3 -- absence of a verdict is never a pass

- **What it checks:** promotion requires `gatesPassed.length === gatesEnabled.length`,
  where a gate counts as passed only on `malware === 'clean'` or
  `content === 'pass'`.
- **Where it runs:** `videoScanPolicy.ts:decideVideoScanOutcome`. The four
  malware verdicts are split deliberately: `clean` and `malicious` are verdicts;
  `not_scanned_yet` and `unavailable` are the *absence* of one, and "neither is
  ever treated as permission to promote."
- **What it refuses with:** decision `retry` (reason `SCAN_VERDICT_PENDING` or
  `SCAN_SIGNAL_UNAVAILABLE`), or after `DEFAULT_MAX_SCAN_ATTEMPTS = 8`,
  `needs_human_review` with reason `SCAN_VERDICT_NEVER_ARRIVED`. Both leave
  `status = 'quarantined'`.
- **`uncertain` is a first-class content outcome, not an error.** "A model asked
  to attest that footage is ordinary boxing training will sometimes be unable to
  say so and equally unable to call it a violation -- of a dark clip, a still
  frame, a camera pointed at the ceiling. Collapsing that into `fail` would bury
  genuine problems under false alarms, and collapsing it into `pass` would
  promote unreviewed video of a minor." It routes to a human
  (`needs_human_review`, reason `CONTENT_SCREEN_UNCERTAIN`).
- **The parse is exact.** `videoScanPolicy.ts:parseContentScreenVerdict` accepts
  only `SCAN_PASS` / `SCAN_FAIL` as the whole first line, uppercased. "This is
  the parse step where a sloppy `includes('PASS')` would have turned 'I cannot
  say this is a PASS' into a promotion."
- **Order is deliberate:** malware outranks everything, then a content refusal,
  then uncertainty, then missing verdicts. "Promotion is last and requires the
  complete set."

### Gate 4 -- no scanner configured means nothing is ever promoted

- **What it checks:** `enabledScanGates(config).length === 0`.
- **Where it runs:** `videoScanPolicy.ts:decideVideoScanOutcome` returns
  `{ decision: 'hold', reason: 'NO_SCANNER_CONFIGURED' }`;
  `:scanStateForDecision` maps `hold` to `scan_state = 'unconfigured'`;
  `:videoStatusForDecision` returns `null`, so `status` is untouched.
- **Both gates default OFF.** `resolveVideoScanConfig` treats anything other
  than the exact strings `defender_index_tags` and `vision` as `'off'`. "An
  environment gains a promotion path only by saying so explicitly... the reason a
  deploy cannot start promoting video by surprise."
- **Why `hold` is distinct from `retry`:** "retrying a scan that cannot exist
  would spin the worker every tick and grow `scan_attempts` without bound, which
  is how this would LOOK like it was working while never promoting anything."
- **Why it exists:** "If no gate is configured, nothing is promoted -- ever --
  which is what keeps this from quietly degrading into 'auto-promote on upload',
  the option that was explicitly rejected." The consequence, stated plainly: on
  an unconfigured deployment the **only** way a video becomes watchable is a
  human release (door B, whose `unconfigured` scan_state is admissible for
  exactly this reason).

### Gate 5 -- claim and settle cannot race

- **What it checks:** `FOR UPDATE SKIP LOCKED` on the claim, plus
  `status = 'quarantined'` **and** `scan_state <> 'blocked'` as predicates on
  the settle `UPDATE`.
- **Where it runs:** `videoSessions.ts:claimNextVideoSessionForScan` and
  `:settleVideoSessionScan`.
- **Why it exists:** two replicas, or a sweep overlapping an ops call, can never
  scan the same video concurrently -- "the same guarantee `claimNextJob` gives
  the job queue". `scan_attempts` is incremented **at claim time**, not settle
  time, "so a worker that crashes mid-scan still burns an attempt. Otherwise a
  video that reliably kills the worker would be retried forever." A stale claim
  (older than `SCAN_CLAIM_STALE_SECONDS = 900`) is takeable, chosen to be
  "comfortably longer than a scan's worst case (a 512MB download plus a 120s
  vision timeout)".

### Gate 6 -- a human resolves what the scan could not; a human never overturns what it refused

- **What it checks:** on door B,
  `HUMAN_RELEASABLE_SCAN_STATES = new Set(['needs_human_review', 'unconfigured'])`.
- **Where it runs:** `app/api/pilot/video/[videoId]/release/route.ts:POST` --
  checked as a read guard **and** repeated as
  `scan_state = any($3::text[])` on the `UPDATE`.
- **What it refuses with:** 409 and, for `blocked`,
  `The content screen refused this video. It cannot be released here; ask an administrator to review it.`
  For `pending`/`scanning`:
  `This video is still waiting on its content scan. It can be released by hand only if the scan cannot reach a verdict.`
- **Why it exists:** "'blocked' is the content screen declining footage of a
  minor, and a coach who filmed it is the last person who should be able to
  reverse that." And on the in-flight states: "'pending' and 'scanning' are not
  refusals -- they are a verdict that has not arrived, and releasing ahead of it
  would make the gate optional for anyone willing to click first."
- **The predicate is repeated on the write** so a video that left quarantine
  between the read and the write is never dragged back, "and so two simultaneous
  releases produce one audit record."
- **The refusal message names a surface that exists.** Door C
  (`scan-review`) is what "ask an administrator" points at; before it was built,
  `blocked` had no exit anywhere in the platform -- "the same dead end quarantine
  itself had, one level up."

### Gate 7 -- malware is never a judgement call

- **What it checks:** `video.status === 'infected'` is refused on **every** human
  surface, before any state or role reasoning that could soften it.
- **Where it runs:** `videoScanReview.ts:authorizeVideoScanReview`, shared by
  `review-link` and `scan-review`. Door B reaches it too, via its
  `status !== 'quarantined'` branch.
- **What it refuses with:** 409, reason `VIDEO_SESSION_INFECTED`,
  `A scanner found malware in this file. It cannot be released by review.`
- **Why it exists:** "a malware verdict came from a real scanner, not a judgment
  call, and no amount of human confidence makes the bytes safe. Nothing here may
  become the way a virus leaves quarantine."

### Gate 8 -- the machine does not overturn the human either

- **What it checks:** `scan_state <> 'blocked'` on the settle `UPDATE`.
- **Where it runs:** `videoSessions.ts:settleVideoSessionScan`; when the update
  matches nothing, `:recordScanOutcomeOnBlockedVideo` **appends** the late
  outcome to `scan_detail` under `late_scan_after_human_block`.
- **Why it exists:** this is the converse of gate 6, and the module spells out
  the exact failure it closes. A human `block` leaves `status = 'quarantined'`,
  so the status guard alone never fired for the case that matters most: "a scan
  still in flight when an administrator refused the video could return minutes
  later, set status 'ready' and scan_state 'passed', and -- because `scan_detail`
  is REPLACED here, not merged -- erase the `human_review` record that says a
  person refused it. A video of a child that an administrator blocked would be
  published, with no trace of the decision."
- **The human attestation is merged, not written over.**
  `videoSessions.ts:reviewVideoSessionScan` does
  `scan_detail = scan_detail || $4::jsonb` and records
  `prior_scan_state` -- what the machine had concluded at the moment a person
  overrode it. "A human-released video must never be indistinguishable from one
  the screen passed on its own -- that difference is the entire audit value
  here."

### Gate 9 -- a non-admin reviewer must be the uploader

- **What it checks:** `!isOrganizationAdminRole(principal.role) && video.uploaded_by_account_id !== principal.accountId`.
- **Where it runs:** `videoScanReview.ts:authorizeVideoScanReview` (both review
  surfaces) and `app/api/pilot/video/[videoId]/release/route.ts:POST`.
- **What it refuses with:** 404 `Not found`.
- **Why it exists:** a review-of-#150 finding, quoted from the module: "without
  this the review surfaces were wider than the gate they serve: any coach
  assigned to the athlete could mint a playback link for a quarantined clip
  another coach uploaded, and for unattributed team video -- which has no athlete
  to check -- ANY coach in the organization could, since the athlete branch below
  simply does not run. That made `review-link` an alternate playback path around
  'held until released'."
- **Athlete access is asserted against the ROW's `athlete_id`,** never a
  caller-supplied one.

### Gate 10 -- existence is not disclosed

- **What it checks:** the shape of every refusal, not a condition.
- **Where it runs:** `[videoId]/route.ts` returns `hiddenNotFound()` for "no such
  video", "not `ready`", "athlete not accessible", and "unattributed video and
  you are neither coach nor admin". `videoScanReview.ts` returns the same
  404-shaped `VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404)`
  for non-existence, wrong uploader, and inaccessible athlete -- explicitly
  catching `assertActorCanAccessAthlete`'s throw, "whose throw is a 403 that
  answers the question".
- **State refusals come AFTER existence and access checks,** "so their more
  specific messages are only ever shown to someone already entitled to know the
  video exists."
- **Why it exists:** issue #8's 403-vs-404 disclosure requirement. "A coach whose
  video list does not include a session must not learn it exists by trying to
  release it."

### Gate 11 -- watching is separated from deciding, and every view is recorded

- **What it checks:** two different role sets on the same state machine.
  `VIDEO_REVIEW_VIEW_ROLES = ['organization_admin', 'coach']` for
  `review-link`; `VIDEO_REVIEW_DECIDE_ROLES = ['organization_admin']` for
  `scan-review`.
- **Where it runs:** `videoScanReview.ts` (the constants),
  `review-link/route.ts:POST` and `scan-review/route.ts:POST` (`requireRole`).
- **What it produces:** a `getPilotVideoSasUrl(blob_path, 15)` link, plus a
  `pilot.audit_events` row with `action: 'video_review_link_issued'`, the
  athlete, the file name, the `scan_state` and the expiry -- written **before**
  the response. `scan-review` writes `action: 'video_scan_review'` with the
  decision, the prior scan state and the resulting status, and emits
  `video.scan_settled` with a non-null actor, "which is precisely the distinction
  worth recording" against the sweep's null.
- **Why the view set is wider than the decide set:** door B gave the coach a
  Release button with no way to look at what they were releasing. "A review that
  cannot see the video is a rubber stamp." Why the decide set is narrower: "a
  content screen 'blocked' verdict concerns footage of a minor, and the person
  who filmed it does not get to overturn it." `platform_owner` is absent from
  both -- "releasing one athlete's footage is depth, and Omega is broader in
  breadth but strictly narrower in depth."
- **The reviewer is shown what they are overriding.** `review-link` returns
  `scan_detail` so the reviewer "knows what they are being asked to override
  rather than judging blind".

### Gate 12 -- the read list is per-role, and two branches are deliberately broad

- **What it checks:** five separate query shapes in
  `app/api/pilot/video/list/route.ts:GET`.
  - `athlete`: own `athlete_id` **and** `status = 'ready'`.
  - `parent`: `athlete_id` required, `assertActorCanAccessAthlete` first, then
    `status = 'ready'`.
  - `coach` with an `athlete_id`: `assertActorCanAccessAthlete` first, then no
    status filter.
  - `coach` with no `athlete_id`: unassigned footage **plus** their own
    athletes', no status filter.
  - org admin: the whole organization, optional athlete filter.
  - anything else: 403 `Forbidden: your role does not have permission to list videos`.
- **The two broad things are marked as intended, with a date.** The route's own
  comment records that an audit flagged both on 2026-08-08 and the owner
  confirmed both: unassigned video is general gym footage any coach may triage,
  and a coach must see their own quarantined uploads or "they would be left with
  an upload that silently never appeared." Assignment is still enforced for a
  **named** athlete.
- **Why that comment is in the code and not only here:** "written here rather
  than in a doc because this is where the next audit will look, and it has
  already been raised once."

## Deliberately not gated

- **`'ready'` is not consent.** Nothing in this capability asks whether the
  child's guardians agreed to their footage existing, being watched by staff, or
  being analysed. That gate exists only at the *publication* and *Film Study*
  boundaries (`app/api/pilot/parent/consent/README.md`). A `ready` video is
  watchable by the coach, the athlete, the athlete's guardians and every
  organization admin with no consent check anywhere.
- **No retention or deletion clock on video.** Nothing in this capability expires
  footage of a child. `dataRetentionDeletion` covers other tables; there is no
  sweep that ages a `video_sessions` row or its blob out.
- **Notes and titles are free text, bounded only by length** (200 / 2000). No
  content check, no redaction. A coach can type a child's medical detail into a
  video note and nothing objects.
- **`review-link` mints a SAS URL, unlike portraits.** Portrait bytes are served
  through an authenticated stream precisely because a signed URL "outlives the
  session, survives being pasted into a chat window, and has no idea who is
  holding it" (`app/api/pilot/profile/README.md`, gate 4). Video review
  deliberately accepts that risk with a 15-minute expiry and an audit row.
  `[videoId]/route.ts` does the same with a 60-minute link for `ready` video.
  This asymmetry is real and is not reconciled anywhere.
- **A blocked video keeps its bytes.** Unlike a blocked portrait, which is
  deleted from the container, `reviewVideoSessionScan`'s `block` only sets
  `scan_state = 'blocked'` and leaves the row quarantined. The blob stays.
- **Nothing re-verifies the actor when the Film Study worker runs.** The enqueue
  path records `authenticatedRole` in the job payload and the processor
  "re-validates this actor at execution time"; that is the SHADOW job
  capability's gate, not this one.
- **The refusals render as JSON, not as stamps.** Design-system Law 7 applies to
  whichever surface calls these routes; nothing in this capability's server code
  decides that.
- **There is no operator override, anywhere.** No route sets `status = 'ready'`
  outside the sweep, door B and door C. That is the point.

## Verified by

- `src/server/pilot/videoScanPolicy.test.ts` -- gates 3 and 4: every
  verdict/config combination, that `not_scanned_yet` and `unavailable` never
  promote, the attempt ceiling routing to `needs_human_review`, the
  `NO_SCANNER_CONFIGURED` hold, and `parseContentScreenVerdict` refusing prose
  and embedded tokens.
- `src/server/pilot/videoScanSweep.test.ts` and `videoScan.test.ts` -- the worker
  loop, the settle outcomes, and the escalation filed for a terminal negative
  verdict.
- `src/server/pilot/videoUploadPolicy.test.ts` -- gate 1's transport, extension,
  declared-type and signature checks.
- `app/api/pilot/video/upload/route.test.ts` -- the role gate, the 415/413/400
  refusals, that the row is written `quarantined`, and that the response reports
  whether a scanner is configured.
- `app/api/pilot/video/[videoId]/release/route.test.ts` -- door B in full,
  including its `the scan verdict outranks the coach` block: `blocked`,
  `pending` and `scanning` are all refused at 409 with their own messages, the
  `hiddenNotFound` for a non-uploader, and the CAS 409.
- `app/api/pilot/video/scan-review/route.test.ts` -- doors C and the view
  surface: the admin-only decide gate, `VIDEO_SESSION_INFECTED`,
  `VIDEO_SESSION_NOT_QUARANTINED`, `VIDEO_SESSION_CHANGED`, the merged
  `human_review` attestation, and (its second `describe`) `review-link`'s wider
  role set, uploader check and audit row.
- `app/api/pilot/video/[videoId]/route.test.ts` and `list/route.test.ts` --
  gates 10 and 12: the identical 404 for every refusal reason, and each role
  branch including the two deliberately broad coach branches.
- `src/server/pilot/videoScanPromotion.pg.test.ts`,
  `videoSessionsMigration.pg.test.ts`,
  `videoSessionsSchemaOwnership.test.ts` -- the state machine and schema against
  a real database. The two `*.pg.test.ts` files are **not run by this lane**
  (excluded here); named so the next reader knows they exist.
