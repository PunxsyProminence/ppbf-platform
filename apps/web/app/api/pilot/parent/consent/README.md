# Guardian linking and media consent -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

Two things that only make sense together:

1. **Guardian linking** -- who counts as a guardian of a child.
   `pilot.parents` holds guardian records; `pilot.guardian_links` links a
   guardian record to an athlete. `src/server/pilot/guardianAccess.ts` is the
   one definition of a guardian's *reach* -- which athletes a signed-in parent
   account may act on.
2. **Media consent** -- whether a child's photograph or video may be approved,
   published or analysed. `src/server/pilot/guardianConsent.ts` is a thin layer
   over `pilot.waivers` rows of `waiver_type = 'photo_media'`, one per guardian,
   append-only (a new row supersedes the last).

Surfaces:

- `app/api/pilot/parent/consent/route.ts` -- the guardian's own side. `GET`
  their children's consent state, `POST` `grant` or `withdraw`.
- `app/api/pilot/admin/athlete-consent/route.ts` -- the org-wide, read-only
  consent audit for an organization admin.
- The three consumers that ask the gate before acting on a child's footage:
  `app/api/pilot/admin/video-compliance/route.ts` (approve),
  `app/api/pilot/publications/publish/route.ts` (publish), and
  `app/api/pilot/shadow/video-analysis/route.ts` (AI Film Study).

## What "consent" means here, exactly

Every one of an athlete's guardians in `pilot.guardian_links` must have a
**current** (latest by `created_at`) `photo_media` waiver with `status = 'signed'`.

- One guardian's `withdrawn` or `declined` row fails the whole check.
- An athlete with **zero** linked guardians fails too. That reads as *missing*,
  not as vacuously satisfied: an empty `guardian_links` set is far more likely
  to be a data gap than a child with no guardians.

## What it may do

- Let a guardian grant and withdraw consent for **their own** linked children,
  and nobody else's.
- Retract already-published media on withdrawal, in the same request
  (`publication.ts:suppressPublishedMediaForAthlete`), not on a timer.
- Block approval, publish and Film Study analysis when consent is not complete,
  with a message that says which of a child's guardians are missing.
- Show an organization admin every athlete's consent state, unpaginated, so a
  lapse cannot be hidden below a page boundary.

## What it may NOT do

- It may not act on a child the caller does not guard (gate 2).
- It may not write a consent row under the wrong child's guardian record
  (gate 3).
- It may not be reached by a coach, an admin or an athlete acting *as* a
  guardian (gate 1) -- the write side is `parent`-role only.
- It may not approve, publish or analyse a minor's footage without complete
  consent (gate 4), and it may not be outrun by a concurrent withdrawal
  (gate 5).
- It may not silently swallow a failed retraction sweep (gate 6).
- It does **not** match consent *scope* against what is being done. See
  "Deliberately not gated" -- this is the most important honest limit on this
  page.

## What must be true before a minor's footage is approved or published

| # | Must be true | If it is not | Who can make it true |
|---|---|---|---|
| 1 | A live, non-bootstrap session | 401 `Unauthorized` / 403 `Forbidden: PIN change required...` | Sign in |
| 2 | Role is `admin` or `organization_admin` | 403 `Forbidden` | An admin decides |
| 3 | The publication exists in the caller's organization | 404 `Not found` (`hiddenNotFound()`) | Nothing -- tenancy boundary |
| 4 | The publication is in `pending_review` (approve) / `approved` + `passed` (publish) | 400 `Unsupported: publication was already decided by another reviewer` / 409 with the current status | Reload; act on the real state |
| 5 | The athlete has **at least one** linked guardian | 409 `Blocked: this athlete has no guardians on file, so guardian media consent cannot be verified. Link a guardian before approving media of this athlete.` | An admin links the guardian (intake / roster import) |
| 6 | **Every** linked guardian has a current `signed` `photo_media` waiver | 409 `Blocked: guardian media consent is missing or withdrawn for N of this athlete's guardians. Every guardian must have a current, signed photo/video consent on file before this can be approved.` | Each guardian signs at `POST /api/pilot/parent/consent` |
| 7 | Condition 6 still holds at the instant of the commit | 409, same message, transaction rolled back | Re-check after the withdrawal is resolved |

Rejecting and requesting changes are **not** gated on consent -- neither
publishes anything, so there is nothing for consent to block. Retracting is not
gated either: it *removes* distribution.

## Gates

### Gate 1 -- only a `parent`-role session may write consent

- **What it checks:** a valid non-bootstrap session, then
  `requireRole(principal, ['parent'])` on both `GET` and `POST`.
- **Where it runs:** `app/api/pilot/parent/consent/route.ts:GET` / `:POST`, via
  `src/server/pilot/http.ts:requirePrincipal` and `http.ts:requireRole`.
- **What it refuses with:** 401 `Unauthorized`; 403
  `Forbidden: PIN change required before using this account`; 403 `Forbidden`
  (the bare message `http.ts:requireRole` throws).
- **Why it exists:** consent is a guardian's decision. A coach or an
  organization admin cannot record it on a guardian's behalf from this route,
  and an athlete cannot consent to their own image being published. Note that
  `credentialPolicy.ts` puts `parent` in `MAGIC_LINK_ROLES`, so the session
  behind this write is an emailed one-time link -- weaker than Microsoft, and
  chosen deliberately: "requiring a Microsoft account of every parent at a
  community gym is an adoption wall rather than a security control."

### Gate 2 -- the caller must actually guard this child

- **What it checks:** that the caller-supplied `athlete_id` is in the set
  returned by `guardianAccess.ts:guardianAthleteIds` for this account and
  organization. That query joins `pilot.guardian_links` to `pilot.parents`
  **organization-scoped on both levels**: the link row and the parent row must
  each name the same gym.
- **Where it runs:** `app/api/pilot/parent/consent/route.ts:POST`, before any
  write. The same helper gates `GET /api/pilot/training-holds` for a parent and
  the parent branch of `access.ts:assertActorCanAccessAthlete` (via
  `isGuardianLinkedToAthlete`).
- **What it refuses with:** **404** `Not found` (`hiddenNotFound()`), not 403.
- **Why 404 and not 403:** a 403 would confirm that the `athlete_id` a stranger
  guessed is a real child in this gym. `http.ts:hiddenNotFound` exists so
  "doesn't exist" and "exists but not yours" are indistinguishable.
- **Why it exists:** "a caller-supplied `athlete_id` being well-formed proves
  nothing about who it belongs to." Without this, any parent account could
  withdraw consent for -- and therefore retract published media of -- any child
  in the gym, or grant consent for a child whose guardian had refused.
- **The organization predicate on the `parents` join is the load-bearing half.**
  `guardianAccess.ts`'s own header records that this join was hand-written in
  six places before the module existed -- "six chances for one of them to forget
  the organization predicate on the parents join and let a parent account
  provisioned in one gym reach a child in another."

### Gate 3 -- the acting guardian record is resolved *per athlete*, never "the first one"

- **What it checks:** which specific `pilot.parents` row this account holds
  **that is a real `guardian_links` guardian of this named athlete**.
- **Where it runs:** `guardianConsent.ts:resolveActingParent` ->
  `guardianAccess.ts:guardianParentIdForAthlete`, called after gate 2 and before
  the write.
- **What it refuses with:** 400
  `Unsupported: no guardian record on file for this account` -- reached only when
  gate 2 passed but no matching `pilot.parents` row exists, which is a data
  inconsistency, not a caller error, and deliberately does not read as "missing
  consent".
- **Why it exists:** this is a fixed bug, documented at length in
  `guardianConsent.ts:resolveActingParent`'s header. `pilot.parents` has no
  uniqueness constraint on `account_id` -- only on `(organization_id,
  parent_id)` -- so one account can legitimately back a different parent row per
  child. A first cut resolved "the account's first parent row" with no athlete
  scoping and no `ORDER BY`; a grant or withdraw for child B could silently
  write under child A's `parent_id`, passing gate 2 while never touching the row
  `checkGuardianMediaConsent(B)` reads. A withdrawal that writes to the wrong
  child's record is a withdrawal that does nothing.
- **The read side uses a SET, not a single row.**
  `guardianConsent.ts:callerParentIdSet` returns every `parent_id` this account
  backs, membership-tested per row, so `GET` marks every one of the caller's own
  guardian rows as "you" rather than whichever arbitrary first pick landed.

### Gate 4 -- consent is checked before approve, publish and AI analysis

- **What it checks:** `assertGuardianMediaConsent(organizationId, athleteId)` --
  at least one linked guardian, and a current `signed` `photo_media` waiver for
  every one of them.
- **Where it runs:** three call sites, all on `main`:
  - `app/api/pilot/admin/video-compliance/route.ts:POST`, only on
    `decision === 'approve'`;
  - `app/api/pilot/publications/publish/route.ts:POST`, before
    `publishToResearchLibrary`;
  - `app/api/pilot/shadow/video-analysis/route.ts:POST`, before `enqueueJob`.
- **What it refuses with:** **409** and one of the two
  `GuardianConsentMissingError` messages quoted in the table above. 409 is
  assigned by type in `http.ts:jsonError`, not by message prefix -- see
  `errors.ts:ConflictError`: "a precondition on a *different* resource than the
  one addressed". A 403 would say the admin may not do this (they may); a 400
  would blame their input; a 500 would hide the reason entirely.
- **Why the third call site matters:** `status = 'ready'` on a video means the
  content-safety scan passed. It says nothing about guardian consent. Film Study
  opens the same footage to AI analysis, so without this it was a side door
  around the publication gate.
- **Blocked attempts are audited.** All three sites catch
  `GuardianConsentMissingError` and write an audit event
  (`publication_compliance_approve_blocked_by_consent`,
  `publication_publish_blocked_by_consent`) recording who tried to act on
  unconsented footage of this child, and when, before rethrowing. A refusal is
  itself a safeguarding-relevant fact.

### Gate 5 -- the check is re-run inside the committing transaction

- **What it checks:** the same consent condition, on the **same** transaction
  client, immediately before the compare-and-set write --
  `assertGuardianMediaConsentWithClient`, whose `guardian_links` read takes
  `FOR SHARE`.
- **Where it runs:** as the `verifyBeforeCommit` hook of
  `publication.ts:decidePublicationCompliance` (approve) and
  `publication.ts:publishToResearchLibrary` (publish). On the publish path the
  hook is **required, not optional** -- the type demands it, "because this hook
  is where the guardian consent re-check runs, and its `guardian_links FOR
  SHARE` is the race lock the withdrawal sweep serializes against."
- **What it refuses with:** the same 409; the transaction rolls back and nothing
  commits.
- **Why it exists:** a Round-8 review finding. The plain `SELECT` pre-check of
  gate 4 completes and returns before the CAS transaction even opens, so a
  guardian's withdrawal can commit in the gap between "checked" and "approved".
  The withdrawal sweep (`suppressPublishedMediaForAthlete`) takes `FOR UPDATE`
  on the same `guardian_links` rows. Either this transaction commits first and
  the sweep then retracts what it published, or the sweep's lock wins and this
  re-check runs after the withdrawal committed and refuses. "In no interleaving
  does a publish outlive a withdrawal unsuppressed."
- **Why the query is duplicated rather than shared:** a `PoolClient`'s `query()`
  returns `{ rows }` and `db.ts`'s module-level `query()` returns a bare array.
  The same asymmetry `decidePublicationCompliance` already works around.

### Gate 6 -- a withdrawal that cannot suppress published media fails loudly

- **What it checks:** that `suppressPublishedMediaForAthlete` succeeded.
- **Where it runs:** `app/api/pilot/parent/consent/route.ts:POST`, in the
  `withdraw` branch.
- **What it refuses with:** **500** with an explicit body:
  `Your consent withdrawal was recorded, but suppressing already-published media failed. Withdraw again to retry, or contact your organization admin.`
  Plus an audit row with
  `action: 'consent_withdrawal_suppression_failed'`.
- **Why it exists:** every other audit write on this route is best-effort and
  swallowed -- a lost audit row must not tell a guardian their consent decision
  failed when it committed. The sweep is the exception, and the comment says
  why: "Unlike an audit row, a failed sweep is a SAFETY action that did not
  happen: it must surface loudly, never be swallowed." The withdrawal itself is
  already committed either way; retrying re-runs the sweep, and the compliance
  console's manual Retract lever is the operator fallback.
- **Without the audit row** an auditor could not distinguish "withdrawal with no
  published media" from "withdrawal whose suppression failed".

### Gate 7 -- the org-wide consent audit is deliberately unpaginated

- **What it checks:** nothing; this is a refusal to add a limit.
- **Where it runs:** `guardianConsent.ts:listOrganizationConsentStatus` -- `page`
  is opt-in and defaults to unbounded; `app/api/pilot/admin/athlete-consent/route.ts`
  calls it without one.
- **Why it exists:** "this function backs the org-wide consent AUDIT: a default
  cap would silently drop athletes from the one screen whose entire purpose is
  catching a missing or lapsed consent. Hiding the finding this route exists to
  surface is worse than the query being slow." Athletes with zero guardian links
  are included, because that is itself the finding an admin needs to see.
- **The route is org-admin only:** `requireRole(principal, ['admin',
  'organization_admin'])`, read-only, no `POST`.

## Deliberately not gated

- **Consent SCOPE is recorded and not enforced.** `pilot.waivers` carries
  `covers_video` and `public_use_allowed`, `POST /api/pilot/parent/consent`
  accepts both, `GET` reports both -- and **no gate reads either one**.
  `assertGuardianMediaConsent` checks only `status = 'signed'`. So a guardian who
  signs with `covers_video: false` still satisfies the gate for a **video**
  publication, and one who leaves `public_use_allowed` false still satisfies it
  for a publish to the research library. `guardianConsent.ts`'s header calls
  this out as "a documented MVP cut, not an oversight". It is the largest live
  gap in this capability and it is invisible to the guardian, because the UI
  collects the two switches as if they meant something. Note the request-body
  defaults compound it: `covers_video` defaults to **true**
  (`body?.covers_video !== false`) while `public_use_allowed` defaults to false.
- **Who may become a guardian is not gated on the guardian's own account.**
  `POST /api/pilot/intake/domain-upsert` with `entity_type: 'guardian_link'`
  writes `pilot.parents.account_id` straight from the request payload. Nothing
  checks that the id names an account at all, that it is a `parent`-role
  account, or that it belongs to this organization -- there is no analogue of
  `access.ts:assertActiveCoachAccount` on this path. Because `upsertGuardian`'s
  `ON CONFLICT ... DO UPDATE SET account_id = excluded.account_id`, a caller may
  also repoint an **existing** guardian record at a different account. The
  sibling path, `POST /api/pilot/intake/review-action`, does not have this gap:
  it runs `createOrUpdateMicrosoftStaffAccount({ role: 'parent' })` first. This
  is recorded as a finding in `docs/capabilities/GATES.md`; **it is not fixed
  here** and this file does not claim otherwise.
- **The relationship string is free text.** `relationship_to_athlete` defaults
  to `'guardian'` and is otherwise whatever the caller sends. Nothing validates
  it, and nothing reads it for an access decision.
- **A guardian cannot see who else guards their child.** `GET` returns each
  guardian's `parent_id` and consent status but no name, and marks only the
  caller's own rows. That is a deliberate non-disclosure, not a gap.
- **There is no lower bound on guardians.** Nothing requires an athlete to have
  a guardian link at all. The consequence is contained -- a childless
  `guardian_links` set makes consent *unverifiable*, which fails the gate -- so
  the failure direction is safe. But no route refuses to create a minor with no
  guardian.
- **No expiry on consent.** A `signed` row is current until a newer row
  supersedes it. There is no annual re-consent, no `consent_version` check
  beyond the literal `'v1'` written by `grantMediaConsent`, and nothing that ages
  a signature out.
- **Withdrawal does not reach the research library rows directly** from this
  route's own code; `suppressPublishedMediaForAthlete` handles both the
  publication status and the library suppression. Named here so nobody adds a
  second sweep.

## Verified by

- `src/server/pilot/guardianConsent.test.ts` --
  `checkGuardianMediaConsent` (zero guardians is not-ok; one withdrawn guardian
  fails the set; newest row per guardian wins), `assertGuardianMediaConsent`
  (both `GuardianConsentMissingError` messages),
  `grantMediaConsent / withdrawMediaConsent` (both write append-only
  `photo_media` rows with the right status),
  `assertGuardianMediaConsentWithClient` (the `FOR SHARE` read and the
  same refusals on a transaction client), `resolveActingParent` and
  `callerParentIdSet` (the per-athlete resolution of gate 3),
  `listConsentForGuardian`, `listOrganizationConsentStatus`.
- `src/server/pilot/guardianAccess.test.ts` -- `isGuardianLinkedToAthlete`,
  `guardianAthleteIds`, `guardianParentIds`, `guardianParentIdForAthlete`, and
  a conformance test (`consolidation holds: no new hand-written viewer-scoped
  guardian join appears`) that fails the build if a route hand-writes the
  guardian join again instead of calling this module.
- `app/api/pilot/parent/consent/route.test.ts` -- `GET` and `POST`: the
  `parent`-role gate, the `hiddenNotFound` for an unguarded `athlete_id`, the
  `grant`/`withdraw` decision validation, the retraction sweep on withdrawal and
  the loud 500 plus audit row when it fails.
- `app/api/pilot/admin/video-compliance/route.test.ts` -- its
  `guardian media consent gate (T-008)` block: approve is refused at 409, the
  blocked attempt is audited with `missing_parent_ids`, and reject /
  request_changes / retract are **not** gated on consent.
- `app/api/pilot/admin/athlete-consent/route.test.ts` -- the org-admin-only
  read and that athletes with no guardian links appear.
- `app/api/pilot/shadow/video-analysis/route.test.ts` -- that Film Study is
  refused for a `ready` video whose guardians have not consented.
- `src/server/pilot/guardianMediaConsentMigration.pg.test.ts` and
  `duplicateGuardianCheck.pg.test.ts` / `strandedGuardianCheck.pg.test.ts` --
  schema and data-integrity checks against a real database. **Not run by this
  lane** (`*.pg.test.ts` is excluded here); named so the next reader knows.
