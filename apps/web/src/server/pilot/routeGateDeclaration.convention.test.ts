// Convention gate: every exported HTTP handler under app/api declares how it
// decides who may reach it.
//
// WHY THIS EXISTS. Nothing in this repository would have noticed a new route
// shipping with no gate at all. The nearest thing to a check,
// coachingContentAccess.test.ts, derives its subject list from a hardcoded
// three-entry map and never enumerates the directory -- so it has an opinion
// about three routes and no opinion about the other 248 files. That is why the
// same class of defect keeps recurring: the drill-library / cue-library /
// drills divergence, and then session-scripts and workout-templates behind it.
// Each was found by a person reading, one route at a time.
//
// A census of app/api at ec4595d4 found 251 route files and 370 exported
// handlers. This walks all of them, every time.
//
// WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It asserts a DECLARATION, not a policy. It has no opinion about which roles
// may reach which route -- that is the owner's to decide, and several of those
// decisions are open. It asserts only that each handler makes its access
// posture explicit through a named, shared gate, or that somebody wrote down
// what it does instead. An allowlist entry is not an exemption from being
// safe; it is a statement, on the record, of what actually protects the route.
//
// Two questions, asked separately because they are different questions and a
// route can pass one and fail the other:
//
//   1. WHO IS THE CALLER.  Does the handler resolve a principal at all?
//   2. MAY THIS CALLER DO THIS.  Having resolved one, does the handler reach a
//      named authorization gate?
//
// A handler that resolves a principal and then serves every role identically
// is not necessarily wrong -- several here are deliberately open, and say so
// in their own headers -- but it should have to say so once, here, where the
// next reviewer will see it next to the ones that are not deliberate.
//
// DELEGATION. A handler body of `return handleList(request)` with the gate
// inside handleList IS gated, and a scan of handler bodies alone reports it as
// naked. shadow/research-requirements GET is exactly that shape and was
// mis-flagged by the first census pass before a second one caught it. So gate
// resolution follows calls through same-file function bodies to any depth
// (one level is the deepest currently used). It does NOT follow calls into
// other modules: a route whose only gate lives one import away is allowlisted
// below with the module and line named, which keeps the walk cheap and
// deterministic and keeps that indirection visible rather than absorbed.
//
// THE RECOGNISER SETS BELOW WERE ENUMERATED FROM THE TREE, not assumed. Every
// name in them is a function that was read and confirmed to refuse somebody.
// That distinction matters: `assert*` is not a safe wildcard here.
// assertRabbitHoleAnchorType validates an input, assertShadowRuntimeReadiness
// checks a migration, assertSetInProgress checks a row's state -- none of them
// looks at the caller, and a wildcard would have let any of them stand in for
// a gate.
//
// An earlier draft of this file also recognised inline role comparisons
// (`principal.role === ...`) as declarations. That was dropped after checking
// it: auth/session POST and feedback/submit POST both matched, and in both the
// role comparison selects an output shape and refuses nobody. A recogniser
// with known false passes is worse than a longer allowlist, because the
// allowlist is read and the recogniser is trusted.

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const API_ROOT = path.join(WEB_ROOT, 'app', 'api');

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Gates that answer "who is the caller". All four are in http.ts / auth.ts;
 * the last three are the deliberate exceptions requirePrincipal's own header
 * names -- the PIN-change route, the session-read route, and the Microsoft-only
 * tier for privileged operations.
 */
const SESSION_GATES = new Set([
  'requirePrincipal',
  'requirePrincipalAllowingPinChange',
  'requireMicrosoftAuthenticatedPrincipal',
  'resolvePrincipal',
]);

/**
 * Gates that answer "may this caller do this". Each was read before being
 * listed, and each refuses the ACTOR -- on their role, their relationship to
 * the subject, or both.
 *
 *   requireRole                     access.ts / http.ts -- the canonical gate
 *   requireAnnotator                annotatorGate.ts:51 -- wraps requireRole
 *   requireResearchBridgeAccess     researchBridgeAuth.ts:77 -- app-role token
 *   assertActorCanAccessAthlete     access.ts:343 -- the central relationship
 *                                   gate; 92 non-test files call it
 *   accessibleAthleteIds            access.ts -- the batched form of the above
 *   athleteIdsForCoach              access.ts -- "my athletes", actor-scoped
 *   assertCoachAssignedToAthlete    access.ts:77 -- assignment or live coverage
 *   assertAthleteUpdateAllowed      access.ts:518 -- field-level, by actor role
 *   assertViewerMayReachSubject     profileDb.ts:323 -- self, else the above
 *   assertActorCanAccessIntakeCase  intake.ts:390 -- subject, admin, or author
 *   assertCanManageBoardSeats       boardSeats.ts:209 -- admin or the President
 *   assertCanAuthorRabbitHoles      rabbitHoles.ts:449 -- coach or admin
 *   assertCanManageRabbitHole       rabbitHoles.ts:465 -- author or admin
 *   assertShadowAuthority           shadowAuthority.ts:107 -- actor + mode
 *   assertConversationAccess        shadowConversations.ts:133 -- owner + subject
 *   authorizeVideoScanReview        videoScanReview.ts:92 -- admin or uploader
 *
 * Adding a name here is a claim that the function refuses somebody. Read it
 * first, and say in the commit which line does the refusing.
 */
const AUTHORIZATION_GATES = new Set([
  'requireRole',
  'requireAnnotator',
  'requireResearchBridgeAccess',
  'assertActorCanAccessAthlete',
  'accessibleAthleteIds',
  'athleteIdsForCoach',
  'assertCoachAssignedToAthlete',
  'assertAthleteUpdateAllowed',
  'assertViewerMayReachSubject',
  'assertActorCanAccessIntakeCase',
  'assertCanManageBoardSeats',
  'assertCanAuthorRabbitHoles',
  'assertCanManageRabbitHole',
  'assertShadowAuthority',
  'assertConversationAccess',
  'authorizeVideoScanReview',
]);

/**
 * Handlers that resolve no principal. Each is gated by something that is not a
 * session, and the entry says which. These are the routes where getting it
 * wrong is worst, so the reasons are specific enough to check.
 */
const NO_SESSION_GATE_ALLOWLIST = new Map<string, string>([
  [
    'app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts#POST',
    'Bootstrap. It CREATES the first organization and the platform_owner '
      + 'account, so there is no session to require and none to derive an '
      + 'organization from. Gated on the PPBF_PILOT_BOOTSTRAP_KEY environment '
      + 'secret, compared before anything is read from the body, behind a '
      + 'volatile AND durable per-IP budget it shares with the route below so '
      + 'that guessing cannot get a fresh budget by switching endpoint.',
  ],
  [
    'app/api/pilot/admin/bootstrap/route.ts#POST',
    'The retired PIN bootstrap path. It refuses every caller unconditionally '
      + 'and exists only to say so. It still verifies the bootstrap key first, '
      + 'because "invalid bootstrap key" and "Unsupported bootstrap path" are '
      + 'otherwise a live oracle for guessing PPBF_PILOT_BOOTSTRAP_KEY even '
      + 'though neither grants anything.',
  ],
  [
    'app/api/pilot/announcements/public/route.ts#GET',
    'Unauthenticated by product decision: the Gym Notice panel on the '
      + 'signed-out login page. organization_id is never accepted from the '
      + 'caller -- it is fixed to the configured default org, a recorded audit '
      + 'finding -- and placement and kind are pinned to gym_notices/notice, so '
      + 'the only announcements an anonymous caller reaches are the ones an '
      + 'author deliberately placed on the signed-out panel.',
  ],
  [
    'app/api/pilot/auth/activate/route.ts#POST',
    'Unauthenticated by design -- an athlete\'s first contact with the system, '
      + 'before they hold any credential at all. The one-time activation code '
      + 'IS the bearer credential, so the route is rate limited per IP on both '
      + 'the volatile and the durable limiter, and every failure returns the '
      + 'same message whether the code was wrong, expired, already used, or '
      + 'belonged to a suspended organization.',
  ],
  [
    'app/api/pilot/auth/login/route.ts#POST',
    'This route is where a session comes from, so it cannot require one. The '
      + 'credential is account_id plus PIN, checked behind per-account and '
      + 'per-IP budgets on both the volatile and the durable limiter -- the '
      + 'in-memory limiter alone was per-replica, which meant N independent '
      + 'attempt budgets against the same child\'s six-digit PIN.',
  ],
  [
    'app/api/pilot/auth/magic-link/consume/route.ts#GET',
    'Does nothing: returns 405 unconditionally. Mail infrastructure (Safe '
      + 'Links, Defender, gateway antivirus) follows link URLs with GET, so a '
      + 'GET-consumes design burns the single-use token seconds after delivery '
      + 'and only for the users whose mail provider protects them best. '
      + 'Refusing GET is what makes the token survive to the human.',
  ],
  [
    'app/api/pilot/auth/magic-link/consume/route.ts#POST',
    'Redeems a sign-in link, so there is no session yet by construction. The '
      + 'single-use magic-link token in the body is the credential, and a '
      + 'per-IP budget sits in FRONT of the token lookup -- there is no account '
      + 'to key on until the token resolves, and resolving it is the expensive '
      + 'part.',
  ],
  [
    'app/api/pilot/auth/magic-link/request/route.ts#POST',
    'Issues a sign-in link to an address, so the caller is anonymous by '
      + 'construction. Rate limited per address (so one mailbox cannot be '
      + 'flooded) and per IP (so the endpoint cannot be walked across many '
      + 'addresses to build a roster), with attempts recorded even on success '
      + '-- recording only failures would make "no attempt recorded" a signal '
      + 'that the address is real, which is the disclosure this route exists '
      + 'to avoid.',
  ],
  [
    'app/api/pilot/auth/microsoft/callback/route.ts#GET',
    'The OAuth redirect target: it runs before a session exists and is what '
      + 'creates one. Gated on the OAuth exchange -- the state cookie is '
      + 'validated with a replay guard before anything else, and the returned '
      + 'id token is verified against the tenant\'s JWKS for the expected '
      + 'audience and nonce -- then the resolved email must already match an '
      + 'invited account or the caller is bounced to /login?not-invited.',
  ],
  [
    'app/api/pilot/auth/microsoft/start/route.ts#GET',
    'Begins the Microsoft sign-in redirect, so there is nothing to '
      + 'authenticate yet. It reads no caller data beyond the request origin '
      + 'and mints the state, nonce and PKCE verifier that the callback above '
      + 'then checks.',
  ],
  [
    'app/api/pilot/floor-hours/public/route.ts#GET',
    'Unauthenticated by product decision, for a public page. It reads ONLY '
      + 'pilot.v_floor_hours_public through getFloorHoursPublic, a view that '
      + 'carries no person or athlete identifier by construction, and '
      + 'organization_id is fixed to the default org rather than accepted from '
      + 'the caller -- the same audit-finding fix the public announcements '
      + 'route carries.',
  ],
  [
    'app/api/pilot/payments/webhook/route.ts#POST',
    'A Stripe webhook: the caller is Stripe, not a person, so there is no '
      + 'session to resolve. Gated on the webhook signature -- '
      + 'verifyStripeWebhookSignature over the RAW body against the configured '
      + 'webhookSecret -- and the route refuses with a 503 before reading '
      + 'anything when no secret is configured, rather than processing '
      + 'unsigned events.',
  ],
  [
    'app/api/pilot/public-interest/route.ts#POST',
    'The only unauthenticated WRITE endpoint in this app, backing the public '
      + 'marketing site\'s interest form. Every field is attacker-controlled, '
      + 'so: a per-IP volatile-plus-durable budget consumed on EVERY call '
      + 'whether valid or not, a hidden honeypot field, and full server-side '
      + 'validation in publicInterest.ts that never trusts the client-side '
      + 'option lists.',
  ],
  [
    'app/api/pilot/shadow/research-bridge/export/route.ts#GET',
    'A machine-to-machine export with no human session. Gated by '
      + 'requireResearchBridgeAccess (researchBridgeAuth.ts): the feature must '
      + 'be switched on for the request host, the bearer token must verify '
      + 'against the Azure tenant\'s JWKS for the configured audience, and the '
      + 'calling application must carry the Research.Export app role AND '
      + 'appear in RESEARCH_BRIDGE_EXPORT_ALLOWED_CLIENT_IDS. Listed here '
      + 'rather than treated as gated because the guard\'s first question is '
      + 'specifically about a session, and this route deliberately has none.',
  ],
  [
    'app/api/pilot/wall/route.ts#GET',
    'Unauthenticated by product decision: the client is a browser on the gym\'s '
      + 'television that nobody signs into, and a 24-hour session token would '
      + 'take the screen dark every morning. So the payload is built to be safe '
      + 'as a PUBLIC document rather than trusted to stay behind a wall -- '
      + 'organization_id fixed to the default org, athlete names resolved to '
      + 'initials by wallDisplay.ts, athlete_id replaced by an opaque hash so '
      + 'it cannot be scraped for a roster, and nothing medical, injury-related '
      + 'or disciplinary read at all. Budgeted per IP.',
  ],
  [
    'app/api/public/store/route.ts#GET',
    'The public gear store: no session, no principal, no cookie, by design. '
      + 'One verb only (#111 removed a route that let an anonymous request run '
      + 'DDL); it selects PUBLIC_FIELDS in gearCatalog.ts so wholesale cost is '
      + 'never even fetched; and it holds no athlete data of any kind. It names '
      + 'the gym because there is no global store. '
      + 'organizationScope.convention.test.ts allowlists this same route, for '
      + 'the same reason.',
  ],
]);

/**
 * Handlers that resolve a principal and then reach no named authorization
 * gate. Each entry says what actually decides who gets served.
 *
 * Three shapes recur, and they are NOT equivalent -- the wording distinguishes
 * them on purpose, because "self-scoped" and "open to every role" carry
 * different risk and a reader should not have to open the file to tell which
 * one they are looking at:
 *
 *   SELF-SCOPED    the route acts only on principal.accountId and takes no
 *                  identifier that could name somebody else. There is nothing
 *                  for a role gate to decide.
 *   INLINE         the handler refuses by hand instead of calling a shared
 *                  gate. Real, and reviewable only by reading it -- which is
 *                  exactly why it is surfaced here.
 *   OPEN BY DESIGN the route serves every authenticated role deliberately, and
 *                  its own header says so. These are the entries to re-read
 *                  when the payload changes, because the justification is
 *                  always about what the payload IS.
 */
const NO_AUTHORIZATION_GATE_ALLOWLIST = new Map<string, string>([
  [
    'app/api/pilot/admin/activation-codes/route.ts#GET',
    'INLINE. The same-file resolveTargetOrganization refuses any role that is '
      + 'not an organization admin, and refuses a caller naming an '
      + 'organization other than their own. platform_owner is deliberately '
      + 'excluded even though it outranks an org admin elsewhere: an '
      + 'activation code is a bearer credential for one named athlete, and '
      + 'minting one would be a route around the boundary '
      + 'assertActorCanAccessAthlete enforces.',
  ],
  [
    'app/api/pilot/admin/activation-codes/route.ts#POST',
    'INLINE. Same same-file resolveTargetOrganization refusal as the GET '
      + 'above, applied before issueActivationCode is called. The plaintext '
      + 'code is returned exactly once and never enters the audit trail, so an '
      + 'audit reader cannot activate somebody else\'s account.',
  ],
  [
    'app/api/pilot/admin/coach-coverage/route.ts#GET',
    'INLINE. requireMicrosoftAuthenticatedPrincipal, then an '
      + 'isOrganizationAdminRole refusal in the handler body. The organization '
      + 'read is principal.organizationId throughout, so no gym sees another '
      + 'gym\'s live grants.',
  ],
  [
    'app/api/pilot/admin/coach-coverage/route.ts#POST',
    'INLINE. Same isOrganizationAdminRole refusal as the GET. Note that the '
      + 'grantee is separately validated inside grantCoachCoverage '
      + '(assertActiveCoachAccount plus an overlap refusal), which is about '
      + 'who receives access rather than who may hand it out.',
  ],
  [
    'app/api/pilot/admin/coach-coverage/route.ts#DELETE',
    'INLINE. Same isOrganizationAdminRole refusal -- an organization admin '
      + 'grants coverage and the same role takes it back -- and the revoke is '
      + 'scoped to principal.organizationId so one gym cannot end another '
      + 'gym\'s grant by guessing a coverage_id.',
  ],
  [
    'app/api/pilot/admin/data-deletion/route.ts#DELETE',
    'INLINE, twice over. The handler refuses a non-organization-admin with a '
      + '403 before reading the body, and deleteGuardianAccount / '
      + 'deleteAthleteRecord re-check the actor role themselves '
      + '(dataDeletion.ts) and scope every statement to actor.organizationId.',
  ],
  [
    'app/api/pilot/admin/staff/route.ts#GET',
    'INLINE. requireMicrosoftAuthenticatedPrincipal then an '
      + 'isOrganizationAdminRole refusal. The organization is taken from the '
      + 'session and never from the request, so an org admin cannot read '
      + 'another organization\'s roster by changing a parameter.',
  ],
  [
    'app/api/pilot/admin/staff/route.ts#POST',
    'INLINE. Same isOrganizationAdminRole refusal, plus two narrower '
      + 'boundaries this route depends on: assertOrgAdminInvitableRole keeps '
      + 'organization_admin off the invitable list, so an org admin can never '
      + 'unilaterally create another account holding their own authority; and '
      + 'requireGuardianLinkForParentInvite stops a parent account being '
      + 'minted that resolves no child.',
  ],
  [
    'app/api/pilot/admin/staff/route.ts#DELETE',
    'INLINE. Same isOrganizationAdminRole refusal, and removeGuardianLink is '
      + 'scoped to principal.organizationId. Provisioning separately refuses '
      + 'to remove the last link an account holds, so this can never be the '
      + 'step that strands a family.',
  ],
  [
    'app/api/pilot/announcements/post/route.ts#POST',
    'INLINE, through a mapper rather than a comparison. The same-file '
      + 'resolveAuthorRole maps the principal\'s role to an author capacity and '
      + 'returns null for every role that may not post; the handler turns that '
      + 'null into a Forbidden. A board member may only claim a board- seat '
      + 'they were sent, and no other role can claim one at all.',
  ],
  [
    'app/api/pilot/auth/change-pin/route.ts#POST',
    'SELF-SCOPED. Acts only on principal.accountId through changeOwnPin, and '
      + 'requires the current PIN as input. It uses '
      + 'requirePrincipalAllowingPinChange rather than requirePrincipal '
      + 'precisely because an account still holding its bootstrap PIN must '
      + 'reach exactly this route and nothing else. Rate limited per account '
      + 'and per IP on both limiters, because a session cookie alone gets a '
      + 'caller in here and the current PIN is then guessable.',
  ],
  [
    'app/api/pilot/auth/logout-all/route.ts#POST',
    'SELF-SCOPED, and structurally so: the route takes NO account_id '
      + 'parameter and its header records that there must never be one. The '
      + 'account acted on is the caller\'s, read from the resolved principal. '
      + 'revokeAllSessionsForAccountInOrganization additionally refuses a '
      + 'platform owner and an account with no active membership in the '
      + 'organization. Revoking somebody else\'s sessions stays on the admin '
      + 'route.',
  ],
  [
    'app/api/pilot/auth/logout/route.ts#POST',
    'SELF-SCOPED. It ends the one session token carried in the caller\'s own '
      + 'cookie and audits under principal.accountId. There is no identifier '
      + 'in the request that could name another account, so there is nothing '
      + 'for a role gate to decide.',
  ],
  [
    'app/api/pilot/auth/session/route.ts#POST',
    'The "who am I" endpoint, and it declares no role posture on purpose. It '
      + 'uses resolvePrincipal rather than requirePrincipal because answering '
      + '{authenticated: false} to an unauthenticated caller is the route\'s '
      + 'whole job. Its only role reference selects which fields the caller\'s '
      + 'OWN session payload carries (a board member\'s seats) and refuses '
      + 'nobody -- which is why the inline-role recogniser described in this '
      + 'file\'s header was dropped: this handler matched it.',
  ],
  [
    'app/api/pilot/board/seats/route.ts#GET',
    'INLINE, against a module-level READ_ROLES set. The payload is '
      + 'deliberately thin -- the appointment and nothing more about the '
      + 'person, no email, no auth provider, no athlete identifier -- because '
      + 'the board role is aggregate-only and a governance roster must not '
      + 'become the one board-readable surface carrying per-account personal '
      + 'data. The POST/PATCH/DELETE siblings are gated by '
      + 'assertCanManageBoardSeats and are not listed here.',
  ],
  [
    'app/api/pilot/credentials/document/[accountId]/[clearanceTypeId]/route.ts#GET',
    'INLINE, self-or-admin. Only two parties may ever reach a credential '
      + 'document: its own owner, or an organization admin working the '
      + 'verification queue. Every refusal returns the same hiddenNotFound(), '
      + 'never a 403, because "this exists but you may not see it" already '
      + 'discloses that a background-check scan exists for that person. The '
      + 'row is separately fetched scoped to principal.organizationId.',
  ],
  [
    'app/api/pilot/drills/proposals/review/route.ts#POST',
    'GATED ONE MODULE DEEPER THAN THIS WALK FOLLOWS. '
      + 'adoptDrillChangeProposal and declineDrillChangeProposal are passed '
      + 'reviewedByRole: principal.role and call requireEvidenceReviewer on it '
      + '(drillVersioning.ts), which admits only organization_admin, admin and '
      + 'platform_owner (shadowLibrary.ts). The organization is the '
      + 'principal\'s own. This is a real gate in a real place -- it is listed '
      + 'because the walk deliberately stops at the module boundary, not '
      + 'because the route is open.',
  ],
  [
    'app/api/pilot/feedback/list/route.ts#POST',
    'INLINE, with role choosing the scope and a terminal refusal. '
      + 'platform_owner reads every gym with submitters de-identified by the '
      + 'query itself; an organization admin reads their own gym with '
      + 'submitters named; every other role is thrown out. There is no '
      + 'organization parameter and no way to ask for the other shape. Coaches '
      + 'and parents are excluded because some of the people writing here are '
      + 'children writing about being hurt.',
  ],
  [
    'app/api/pilot/feedback/submit/route.ts#POST',
    'OPEN BY DESIGN, to every authenticated role -- "a comment box a child '
      + 'cannot reach is a comment box that does not exist", which is why it is '
      + 'requirePrincipal and not the Microsoft-only gate. SELF-SCOPED as well: '
      + 'the organization, the account and the capacity all come from the '
      + 'session, so a caller cannot file under another gym, another person or '
      + 'another role, and the response deliberately carries back no route, no '
      + 'submission id and no classification.',
  ],
  [
    'app/api/pilot/feedback/triage/route.ts#POST',
    'INLINE. An isOrganizationAdminRole refusal, scoped to the gym that '
      + 'received the submission. platform_owner is deliberately excluded from '
      + 'ACTING even though it may read: acting on a submission means knowing '
      + 'who wrote it, which is exactly what the owner\'s de-identified read '
      + 'does not carry.',
  ],
  [
    'app/api/pilot/gym-photos/[slot]/route.ts#GET',
    'OPEN BY DESIGN to any signed-in member: the gym wall is a shared '
      + 'dashboard surface. The organization comes from the principal only -- a '
      + 'member of gym A asking for gym B\'s wall is not an addressable request '
      + 'in this route\'s vocabulary -- and the slot must be one the manifest '
      + 'names. Served as authenticated bytes rather than a SAS URL so a '
      + 'takedown means something.',
  ],
  [
    'app/api/pilot/gym-photos/route.ts#GET',
    'OPEN BY DESIGN to any signed-in member, same surface as the [slot] read '
      + 'above; this one returns which slots are filled and where to fetch '
      + 'them, not bytes. The organization comes from the principal and nowhere '
      + 'else -- there is no organization parameter to name another gym with.',
  ],
  [
    'app/api/pilot/profile/me/route.ts#GET',
    'SELF-SCOPED, structurally: there is no account_id parameter and the '
      + 'header records that there must never be one, because "a route that can '
      + 'be pointed at an account id is a route that will eventually be pointed '
      + 'at the wrong one". Every read is keyed on principal.organizationId '
      + 'plus principal.accountId. Reading somebody else\'s card goes through '
      + '/api/pilot/profile/card, which runs the visibility gate.',
  ],
  [
    'app/api/pilot/profile/me/route.ts#PATCH',
    'SELF-SCOPED, same rule as the GET: every write (corner, program, '
      + 'nickname) is keyed on principal.organizationId plus '
      + 'principal.accountId, with no identifier in the body that could name '
      + 'another account. The nickname lock is a state check on the caller\'s '
      + 'own row, not an authorization decision about somebody else.',
  ],
  [
    'app/api/pilot/profile/photo/route.ts#POST',
    'SELF-SCOPED, and deliberately so: the route takes no account id, so a '
      + 'coach cannot upload a photograph of an athlete and a guardian cannot '
      + 'upload one of their child. That is a product decision, not an '
      + 'oversight -- taking one DOWN is the direction made easy. OPEN BY '
      + 'DESIGN across roles for the same reason: "who\'s in your corner" only '
      + 'works if the coach has a face too. The blob path is derived from '
      + 'principal.accountId, and the upload is rate limited.',
  ],
  [
    'app/api/pilot/profile/photo/route.ts#DELETE',
    'SELF-SCOPED. Removes the caller\'s own portrait, keyed on '
      + 'principal.accountId, bytes and all. Staff takedown of somebody else\'s '
      + 'portrait is a different route (/photo/review) with its own gate.',
  ],
  [
    'app/api/pilot/scheduler/attendance-summary/route.ts#GET',
    'INLINE, twice. The handler admits only coach and '
      + 'organization_admin/admin and throws Forbidden for everyone else, then '
      + 'refuses again when a coach names a class they do not own (checked '
      + 'against coach_account_id, scheduled_by_account_id and '
      + 'covering_coach_account_id -- the same ownership test the scheduler '
      + 'route applies). The header records that a parent- or athlete-facing '
      + 'attendance view is deliberately deferred to its own scoping decision '
      + 'rather than reusing this route\'s shape.',
  ],
  [
    'app/api/pilot/session-scripts/route.ts#GET',
    'OPEN BY DESIGN to any authenticated role: a session script is the gym\'s '
      + 'own teaching plan and carries no athlete data. What happened on a '
      + 'given night DOES carry athlete data, and lives in '
      + 'pilot.session_script_runs, which this route does not touch. '
      + 'Organization from the session. If this route ever starts joining to '
      + 'runs, this entry is the thing that has to be revisited.',
  ],
  [
    'app/api/pilot/shadow/data/route.ts#GET',
    'SELF-SCOPED. exportOwnShadowData(principal) lists only conversations '
      + 'where organization_id and account_id both match the caller, filters '
      + 'any athlete-bearing row through assertActorCanAccessAthlete, and then '
      + 'reads messages restricted to that conversation id set '
      + '(shadowConversations.ts).',
  ],
  [
    'app/api/pilot/shadow/data/route.ts#POST',
    'SELF-SCOPED. requestOwnShadowDataDeletion(principal) reads and writes a '
      + 'deletion request keyed on the caller\'s own organization_id and '
      + 'account_id, and is idempotent against an already-pending request '
      + '(shadowConversations.ts). Fulfilment is manual review, not an '
      + 'immediate delete.',
  ],
  [
    'app/api/pilot/shadow/memory/route.ts#POST',
    'ACTOR-SCOPED. submitMemoryCorrection takes the principal as `actor` and '
      + 'refuses the board role outright -- board is restricted to '
      + 'organization-level aggregates and has no business in account-level '
      + 'SHADOW memory (shadowConversations.ts). The correction is filed '
      + 'pending_review rather than applied.',
  ],
  [
    'app/api/pilot/shadow/research-bridge/session-export/route.ts#GET',
    'INLINE, with role choosing the scope and a terminal refusal. A principal '
      + 'holding master SHADOW access exports across organizations; an '
      + 'organization admin exports their own; everyone else falls through to a '
      + 'Forbidden. Structured as allow-branches with the refusal last, which '
      + 'is why no single if-statement reads as the gate.',
  ],
  [
    'app/api/pilot/shadow/video-analysis/route.ts#GET',
    'ACTOR-SCOPED. getJobStatusForActor(jobId, principal) scopes the lookup to '
      + 'the caller\'s organization and then runs actorCanAccessJob, returning '
      + 'null when refused (shadowJobQueue.ts); the route renders that as the '
      + 'same 404 an unknown job id gets, so the endpoint is not an enumeration '
      + 'oracle. A non-UUID jobId is refused as hiddenNotFound() before any '
      + 'query runs.',
  ],
  [
    'app/api/pilot/staff-credentials/route.ts#GET',
    'OPEN BY DESIGN, at the product owner\'s explicit request: '
      + '"parents/athletes should be able to see the staff are well-trained and '
      + 'certified." Safe because of what the payload IS rather than who is '
      + 'asking -- a name, a role, and a status band per clearance type. '
      + 'listStaffCredentialStatus does not select document_ref, '
      + 'verified_by_account_id or verification_note at all, so there is no '
      + 'field here to forget to drop. The DOCUMENT itself is a different '
      + 'route, and it is not open.',
  ],
  [
    'app/api/pilot/wall-of-names/route.ts#GET',
    'OPEN BY DESIGN to every role that can sign in, and safe because of the '
      + 'payload rather than the audience: the wallDisplay.ts name gate '
      + 'resolves every athlete to initials unless a guardian has signed a '
      + 'release naming a display surface AND an operator has switched '
      + 'PPBF_WALL_DISPLAY_NAMES to consent (neither exists today), the ids are '
      + 'hashed so it cannot be scraped for a roster, and there is no '
      + 'per-person number on it at all. Organization from the session, never '
      + 'the request.',
  ],
  [
    'app/api/pilot/workout-templates/route.ts#GET',
    'OPEN BY DESIGN to any authenticated role: a workout template carries no '
      + 'athlete data. Organization from the session. Same reasoning as '
      + 'session-scripts above, and the same thing to revisit if the payload '
      + 'ever grows a join to an athlete.',
  ],
]);

// ---------------------------------------------------------------------------
// Walking and parsing
// ---------------------------------------------------------------------------

function collectRouteFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(full));
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * Forward slashes always. path.relative returns backslashes on Windows, so an
 * allowlist keyed on 'app/api/...' would never match there -- green in CI on
 * ubuntu, failing on every Windows run. Same normalisation, for the same
 * reason, as organizationScope.convention.test.ts.
 */
function relative(filePath: string): string {
  return path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
}

/**
 * Blank out comments and the CONTENTS of string, template and regex literals,
 * replacing each removed character with a space so every offset still lines up
 * with the original source.
 *
 * Without this, brace matching walks into a `{` inside a SQL string or a regex
 * and every span after it is wrong; and a gate name mentioned in a comment
 * ("see requireRole") would read as a call. Template interpolations are left
 * intact, since a real call can live inside one.
 */
export function blankLiterals(source: string): string {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  let prevSignificant = '';
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (c === '/' && d === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c || source[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, j);
      i = Math.min(n, j + 1);
      prevSignificant = c;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { out[j] = ' '; out[j + 1] = ' '; j += 2; continue; }
        if (source[j] === '`') break;
        if (source[j] === '$' && source[j + 1] === '{') {
          // Step over the interpolation without blanking it.
          j += 2;
          let braces = 1;
          while (j < n && braces > 0) {
            if (source[j] === '{') braces += 1;
            else if (source[j] === '}') braces -= 1;
            j += 1;
          }
          continue;
        }
        if (out[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      out[i] = ' ';
      if (j < n) out[j] = ' ';
      i = Math.min(n, j + 1);
      prevSignificant = '`';
      continue;
    }

    // A '/' is a regex literal only where a value cannot already have ended;
    // after an identifier or a ')' it is division.
    if (c === '/' && (prevSignificant === '' || /[=(,:;[!&|?{}+\-*%^~<>]/.test(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break;
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        blank(i, j + 1);
        i = j + 1;
        prevSignificant = '/';
        continue;
      }
    }

    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  return out.join('');
}

function matchDelimiter(blanked: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < blanked.length; i += 1) {
    if (blanked[i] === openChar) depth += 1;
    else if (blanked[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type Span = readonly [start: number, end: number];

/**
 * The body span of every named function-ish binding in the file -- `function
 * f() {}`, `const f = () => {}`, `const f = async function () {}` -- exported
 * or not. This is what makes gate resolution delegation-aware.
 */
function collectFunctionBodies(blanked: string): Map<string, Span> {
  const bodies = new Map<string, Span>();

  const declaration = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(blanked)) !== null) {
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1);
    if (span) bodies.set(match[1], span);
  }

  const assignment = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$\w]*\s*)?\(/g;
  while ((match = assignment.exec(blanked)) !== null) {
    if (bodies.has(match[1])) continue;
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1, true);
    if (span) bodies.set(match[1], span);
  }

  return bodies;
}

/**
 * Given the '(' that opens a parameter list, the span of the body that follows
 * it. `allowArrow` also accepts `) => {`, and looks for the arrow BEFORE the
 * first brace so that a return-type annotation containing an object type does
 * not get mistaken for the body.
 */
function bodyAfterParameters(blanked: string, parenOpen: number, allowArrow = false): Span | null {
  const parenClose = matchDelimiter(blanked, parenOpen, '(', ')');
  if (parenClose === -1) return null;

  let braceOpen: number;
  if (allowArrow) {
    const tail = blanked.slice(parenClose + 1, parenClose + 400);
    const arrowAt = tail.indexOf('=>');
    const braceAt = tail.indexOf('{');
    if (arrowAt !== -1 && (braceAt === -1 || braceAt > arrowAt)) {
      braceOpen = blanked.indexOf('{', parenClose + 1 + arrowAt);
    } else if (braceAt !== -1) {
      braceOpen = parenClose + 1 + braceAt;
    } else {
      return null;
    }
  } else {
    braceOpen = blanked.indexOf('{', parenClose);
  }

  if (braceOpen === -1) return null;
  const braceClose = matchDelimiter(blanked, braceOpen, '{', '}');
  if (braceClose === -1) return null;
  return [braceOpen, braceClose + 1] as const;
}

interface Handler {
  method: string;
  span: Span;
}

const HANDLER_SIGNATURE = new RegExp(
  `(?:^|\\n)\\s*export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`,
  'g',
);

function findHandlers(blanked: string): Handler[] {
  const found: Handler[] = [];
  const pattern = new RegExp(HANDLER_SIGNATURE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(blanked)) !== null) {
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1);
    if (span) found.push({ method: match[1], span });
  }
  return found;
}

/** Every identifier called inside a span: `name(` and `obj.name(` alike. */
function calledNames(blanked: string, [start, end]: Span): string[] {
  const names: string[] = [];
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  const slice = blanked.slice(start, end);
  while ((match = pattern.exec(slice)) !== null) names.push(match[1]);
  return names;
}

/**
 * Every name reachable from a handler, following calls through same-file
 * function bodies to any depth. `seen` makes mutual recursion terminate.
 */
function reachableNames(blanked: string, bodies: Map<string, Span>, span: Span): Set<string> {
  const reached = new Set<string>();
  const visited = new Set<string>();
  const walk = (current: Span): void => {
    for (const name of calledNames(blanked, current)) {
      reached.add(name);
      const body = bodies.get(name);
      if (body && !visited.has(name)) {
        visited.add(name);
        walk(body);
      }
    }
  };
  walk(span);
  return reached;
}

interface ClassifiedHandler {
  id: string;
  file: string;
  hasSessionGate: boolean;
  hasAuthorizationGate: boolean;
}

function classifyHandlers(): { handlers: ClassifiedHandler[]; perFile: Map<string, number> } {
  const handlers: ClassifiedHandler[] = [];
  const perFile = new Map<string, number>();

  for (const filePath of collectRouteFiles(API_ROOT)) {
    const rel = relative(filePath);
    const blanked = blankLiterals(fs.readFileSync(filePath, 'utf8'));
    const bodies = collectFunctionBodies(blanked);
    const found = findHandlers(blanked);
    perFile.set(rel, found.length);

    for (const handler of found) {
      const reached = reachableNames(blanked, bodies, handler.span);
      handlers.push({
        id: `${rel}#${handler.method}`,
        file: rel,
        hasSessionGate: [...reached].some((name) => SESSION_GATES.has(name)),
        hasAuthorizationGate: [...reached].some((name) => AUTHORIZATION_GATES.has(name)),
      });
    }
  }

  return { handlers, perFile };
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

describe('every API handler declares how it decides who may reach it', () => {
  const { handlers } = classifyHandlers();

  test('every handler resolves a principal, or records what guards it instead', () => {
    const offenders = handlers
      .filter((handler) => !handler.hasSessionGate)
      .filter((handler) => !NO_SESSION_GATE_ALLOWLIST.has(handler.id))
      .map((handler) => handler.id);

    if (offenders.length > 0) {
      throw new Error(
        'These handlers reach no session gate. A route under app/api is a '
        + 'public HTTP endpoint until something makes it otherwise, and '
        + 'nothing else in this repository would notice. Call requirePrincipal '
        + '(or requireMicrosoftAuthenticatedPrincipal for a privileged '
        + 'operation) -- or, if this route is genuinely gated by something '
        + 'that is not a session, add it to NO_SESSION_GATE_ALLOWLIST with the '
        + 'gate named:\n  '
        + offenders.join('\n  '),
      );
    }
  });

  test('every authenticated handler reaches an authorization gate, or records what it does instead', () => {
    const offenders = handlers
      .filter((handler) => handler.hasSessionGate && !handler.hasAuthorizationGate)
      .filter((handler) => !NO_AUTHORIZATION_GATE_ALLOWLIST.has(handler.id))
      .map((handler) => handler.id);

    if (offenders.length > 0) {
      throw new Error(
        'These handlers resolve a principal and then reach no named '
        + 'authorization gate, so nothing states who they are for. That is '
        + 'sometimes correct -- a self-scoped route has nothing to decide, and '
        + 'a few routes are open to every role on purpose -- but it has to be '
        + 'said out loud rather than inferred from a handler body. Call '
        + 'requireRole, or one of the actor-authorization helpers listed at the '
        + 'top of this file -- or add an entry to '
        + 'NO_AUTHORIZATION_GATE_ALLOWLIST saying what actually protects '
        + 'it:\n  '
        + offenders.join('\n  '),
      );
    }
  });

  // The allowlists are the part that rots. An entry naming a handler that no
  // longer exists is a permission nobody reviewed still sitting open, and it
  // would silently start covering a different handler if that path and method
  // were ever reused.
  test('every allowlisted handler still exists', () => {
    const live = new Set(handlers.map((handler) => handler.id));
    const missing = [
      ...NO_SESSION_GATE_ALLOWLIST.keys(),
      ...NO_AUTHORIZATION_GATE_ALLOWLIST.keys(),
    ].filter((id) => !live.has(id));

    expect(missing).toEqual([]);
  });

  // The other way an allowlist rots: an entry that is no longer needed because
  // the route was since gated properly. Left in place it is a standing
  // exemption for a route that does not need one, and the next person to
  // remove the gate would not fail this suite.
  test('no allowlist entry has outlived the gap it covers', () => {
    const byId = new Map(handlers.map((handler) => [handler.id, handler]));

    const unnecessary = [
      ...[...NO_SESSION_GATE_ALLOWLIST.keys()].filter((id) => byId.get(id)?.hasSessionGate),
      ...[...NO_AUTHORIZATION_GATE_ALLOWLIST.keys()].filter((id) => byId.get(id)?.hasAuthorizationGate),
    ];

    if (unnecessary.length > 0) {
      throw new Error(
        'These handlers now reach a real gate, so their allowlist entries are '
        + 'obsolete and should be deleted -- an exemption nobody needs is an '
        + 'exemption nobody reviews:\n  '
        + unnecessary.join('\n  '),
      );
    }
  });

  // Every allowlist entry is a paragraph somebody has to be able to check. A
  // one-liner reading "existing route" would make the list unmaintainable, and
  // the two lists above only mean anything if the reasons are real.
  test('every allowlist entry carries a substantive reason', () => {
    const thin = [...NO_SESSION_GATE_ALLOWLIST, ...NO_AUTHORIZATION_GATE_ALLOWLIST]
      .filter(([, reason]) => reason.trim().length < 80 || /^(existing|pre-existing|legacy|n\/a|todo)\b/i.test(reason.trim()))
      .map(([id]) => id);

    expect(thin).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity
//
// A convention test whose subject set collapsed to nothing is worse than no
// test, because it is green. schemaVerification.pg.test.ts is the cautionary
// example in this repository: its floors were low enough that truncating the
// input to 37% still passed.
//
// So the pins below are equalities and totals, not floors. Nothing here is a
// hardcoded expected count that a later edit could quietly lower into
// agreement with a shrunken walk -- each expected value is recomputed from
// disk, by a DIFFERENT method than the one under test, every run.
// ---------------------------------------------------------------------------

describe('the sweep actually examined the routes, rather than passing vacuously', () => {
  /** A deliberately naive second walk, sharing no code with collectRouteFiles. */
  function everyFileUnder(root: string): string[] {
    const stack = [root];
    const files: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        if (fs.statSync(full).isDirectory()) stack.push(full);
        else files.push(full);
      }
    }
    return files;
  }

  const independentRouteFiles = everyFileUnder(API_ROOT)
    .filter((filePath) => /(^|[\\/])route\.tsx?$/.test(filePath))
    .map(relative)
    .sort();

  const { handlers, perFile } = classifyHandlers();

  test('the walk finds exactly the route files that are on disk', () => {
    expect([...perFile.keys()].sort()).toEqual(independentRouteFiles);
    expect(independentRouteFiles.length).toBeGreaterThan(200);
  });

  // Fail closed on a parse failure. If blankLiterals or the brace matcher ever
  // loses its place, the symptom is a file that yields zero handlers -- which
  // on its own reads exactly like a clean pass.
  test('every route file yielded at least one handler', () => {
    const empty = [...perFile.entries()].filter(([, count]) => count === 0).map(([file]) => file);

    if (empty.length > 0) {
      throw new Error(
        'These route files parsed to zero handlers. Either they genuinely '
        + 'export none -- in which case they are dead files -- or the parser '
        + 'lost its place, and a parser that silently returns nothing turns '
        + 'this whole suite green:\n  '
        + empty.join('\n  '),
      );
    }
  });

  // Two extractors, independently implemented, must agree on the total. The
  // brace-matching parser above can drop a handler by mis-tracking a span; a
  // flat line scan cannot, and a flat line scan cannot resolve a body, so
  // neither can cover for the other's failure.
  test('the parser and a flat line scan agree on how many handlers exist', () => {
    let byLineScan = 0;
    for (const filePath of collectRouteFiles(API_ROOT)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const line of source.split('\n')) {
        if (new RegExp(`^export\\s+(?:async\\s+)?function\\s+(?:${HTTP_METHODS.join('|')})\\s*\\(`).test(line)) {
          byLineScan += 1;
        }
      }
    }

    expect(handlers.length).toBe(byLineScan);
    expect(byLineScan).toBeGreaterThan(300);
  });

  // The recogniser sets must actually recognise things. If a rename silently
  // emptied them, both gates above would pass every handler through the
  // allowlists and report nothing -- and the allowlists are small enough that
  // the failure would look like a handful of unrelated offenders rather than a
  // broken detector. Pinned as a proportion of the measured total, not a
  // constant, so it moves with the tree.
  test('the recognisers match the overwhelming majority of handlers', () => {
    const gated = handlers.filter((handler) => handler.hasSessionGate).length;
    const authorized = handlers.filter((handler) => handler.hasAuthorizationGate).length;

    expect(gated).toBeGreaterThan(handlers.length * 0.9);
    expect(authorized).toBeGreaterThan(handlers.length * 0.8);
  });

  // Delegation, pinned by name. shadow/research-requirements GET is
  // `return handleList(request)` with both gates inside handleList, and it is
  // the reason this walk follows same-file calls at all. If gate resolution
  // ever regresses to scanning handler bodies, this is the assertion that
  // says so rather than 1 mysterious new offender.
  test('a gate inside a same-file helper still counts as declared', () => {
    const delegating = handlers.find(
      (handler) => handler.id === 'app/api/pilot/shadow/research-requirements/route.ts#GET',
    );

    expect(delegating).toBeDefined();
    expect({
      session: delegating?.hasSessionGate,
      authorization: delegating?.hasAuthorizationGate,
    }).toEqual({ session: true, authorization: true });
  });
});

// ---------------------------------------------------------------------------
// The parser's own behaviour, on inputs chosen because they are the ways it
// could quietly go wrong. Everything above rests on these being true.
// ---------------------------------------------------------------------------

describe('blankLiterals keeps the parser from reading code that is not there', () => {
  test('a gate named in a comment is not a call', () => {
    const source = '// call requireRole here\nexport async function GET() { return 1; }';
    expect(blankLiterals(source)).not.toContain('requireRole');
  });

  test('a brace inside a string does not move the body span', () => {
    const source = 'export async function GET() {\n  const q = "select {";\n  return q;\n}\n';
    const blanked = blankLiterals(source);
    const handlers = findHandlers(blanked);
    expect(handlers).toHaveLength(1);
    expect(blanked.slice(handlers[0].span[0], handlers[0].span[1])).toContain('return q;');
  });

  test('a call inside a template interpolation is still visible', () => {
    const source = 'export async function GET() {\n  return `x${requireRole(p, [])}y`;\n}\n';
    const blanked = blankLiterals(source);
    expect(calledNames(blanked, findHandlers(blanked)[0].span)).toContain('requireRole');
  });

  test('offsets survive blanking, so spans still index the original source', () => {
    const source = 'const s = "abcdef"; /* xy */ const t = `qq`;\n';
    expect(blankLiterals(source)).toHaveLength(source.length);
  });

  test('a brace inside a regex literal does not move the body span', () => {
    const source = 'export async function GET() {\n  const r = /a{2}/;\n  return r;\n}\n';
    const handlers = findHandlers(blankLiterals(source));
    expect(handlers).toHaveLength(1);
  });
});
