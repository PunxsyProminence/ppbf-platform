// What RUNTIME_VERIFIED means, per queue item, as something executable.
//
// HOW TO READ THIS FILE
//
// Each entry is one row of `docs/current/WORK_QUEUE.md`. An entry either
// declares probes or declares `noRuntimeProbe` with a reason. There is no third
// option and no silent omission: `pilot-runtime-verify.test.ts` fails if a
// queue row is missing from here entirely, because a manifest that quietly
// covers 12 of 32 items while reporting "all green" is the exact failure this
// repo keeps writing incidents about.
//
// WHAT THESE PROBES DO AND DO NOT ESTABLISH
//
// Be precise about the claim. Most entries below prove three things:
//
//   * the route is deployed and reachable at the path the code says it is;
//   * its unauthenticated boundary holds (401, not 200 and not 500);
//   * where the role gate is readable from a shared predicate, that the gate
//     admits and refuses the roles it claims to.
//
// That is materially more than "the container started", and it is materially
// less than "this feature does what its ticket promised". Several items below
// therefore carry `acceptanceProbeOutstanding` -- their full acceptance
// criteria need a human to author the specific probe, and the ledger says so
// rather than counting the boundary check as the whole job. Marking that
// honestly is the point; a green run here is a floor, not a ceiling.
//
// The role expectations are read from the code, not assumed:
//   * `access.ts#isOrganizationAdminRole` is `organization_admin` or `admin`,
//     so a `platform_owner` session is genuinely refused by every route gated
//     on it -- a real and worth-checking property, since "the platform owner
//     can do anything" is the intuition it contradicts.
//   * `http.test.ts` fixes `Forbidden:` -> 403 and an absent session -> 401.
//   * `videoScanReview.ts` exports VIDEO_REVIEW_DECIDE_ROLES = ['organization_admin'].

/** Applied to every authenticated API route: no cookie, no access. */
function unauthenticated(item, path, { method = 'GET', because } = {}) {
  return {
    item,
    id: `${item}/unauth:${method} ${path}`,
    kind: 'http',
    method,
    path,
    expect: 401,
    because: because
      || 'An authenticated route must refuse an anonymous caller. A 200 here is an exposure; a '
      + '500 means the route is deployed but broken, which "deployed" alone would not reveal.',
  };
}

/** Applied to admin consoles: the page itself must render for a signed-in operator to reach it. */
function pageRenders(item, path) {
  return {
    item,
    id: `${item}/page:${path}`,
    kind: 'page',
    path,
    expect: [200, 401, 307],
    because:
      'The console must be deployed and served. A 404 means the route was never built into the '
      + 'image, which is the failure mode a deploy-succeeded signal cannot distinguish from '
      + 'success. Auth redirects are accepted -- this checks the page exists, not who may see it.',
  };
}

/** A route gated on isOrganizationAdminRole must refuse a role that is not one. */
function refusedForRole(item, path, role, { method = 'GET' } = {}) {
  return {
    item,
    id: `${item}/refuse-${role}:${method} ${path}`,
    kind: 'http',
    method,
    path,
    as: role,
    expect: 403,
    because:
      `access.ts#isOrganizationAdminRole admits only organization_admin and admin, so a `
      + `${role} session must be refused here. This is the check that would catch a gate widened `
      + 'by accident.',
  };
}

/** A route gated on isOrganizationAdminRole must admit an organization admin. */
function admittedForOrgAdmin(item, path) {
  return {
    item,
    id: `${item}/admit-org-admin:GET ${path}`,
    kind: 'http',
    path,
    as: 'organization_admin',
    expect: 200,
    because:
      'The other half of the gate. A console nobody can open is as broken as one anybody can, and '
      + 'only the refusal half gets checked by habit.',
  };
}

export const MANIFEST = [
  {
    item: 'T-001',
    title: 'Admin activation-code console',
    probes: [
      unauthenticated('T-001', '/api/pilot/admin/activation-codes'),
      pageRenders('T-001', '/admin/activation-codes'),
      admittedForOrgAdmin('T-001', '/api/pilot/admin/activation-codes'),
      refusedForRole('T-001', '/api/pilot/admin/activation-codes', 'platform_owner'),
      refusedForRole('T-001', '/api/pilot/admin/activation-codes', 'coach'),
    ],
    acceptanceProbeOutstanding:
      'Issuing a code and redeeming it end to end is the ticket\'s real criterion. It mutates, so '
      + 'it belongs in a pg test or a staging-only gate with a disposable fixture, not here.',
  },
  {
    item: 'T-002',
    title: 'Covering coach cannot access an athlete they do not own',
    probes: [
      unauthenticated('T-002', '/api/pilot/admin/coach-coverage'),
      pageRenders('T-002', '/admin/coach-coverage'),
      admittedForOrgAdmin('T-002', '/api/pilot/admin/coach-coverage'),
      refusedForRole('T-002', '/api/pilot/admin/coach-coverage', 'coach'),
      refusedForRole('T-002', '/api/pilot/admin/coach-coverage', 'coach', { method: 'POST' }),
      refusedForRole('T-002', '/api/pilot/admin/coach-coverage', 'platform_owner'),
    ],
    acceptanceProbeOutstanding:
      'The P1 rule is that a coach cannot read an athlete outside their assignment, and proving it '
      + 'needs a coach fixture with a known unassigned athlete. coachCoverage.pg.test.ts covers the '
      + 'logic; the deployed-environment half needs that fixture pair chosen by a human.',
  },
  {
    item: 'T-003',
    title: 'Quarantined-video scan-review console',
    // Kept even though this row is already PRODUCTION_VERIFIED. It is the only
    // item whose verification this repo fully trusts, so it doubles as the
    // harness's own control: if these fail, doubt the harness before the app.
    probes: [
      unauthenticated('T-003', '/api/pilot/video/list'),
      unauthenticated('T-003', '/api/pilot/video/review-link', { method: 'POST' }),
      unauthenticated('T-003', '/api/pilot/video/scan-review', { method: 'POST' }),
      pageRenders('T-003', '/admin/video-review'),
      {
        item: 'T-003',
        id: 'T-003/refuse-coach-decide',
        kind: 'http',
        method: 'POST',
        path: '/api/pilot/video/scan-review',
        as: 'coach',
        expect: 403,
        because:
          'The ticket\'s P0 rule: the coach who filmed footage of a minor gets no path into the '
          + 'decision. VIDEO_REVIEW_DECIDE_ROLES is organization_admin and nothing else.',
      },
      {
        item: 'T-003',
        id: 'T-003/refuse-platform-owner-decide',
        kind: 'http',
        method: 'POST',
        path: '/api/pilot/video/scan-review',
        as: 'platform_owner',
        expect: 403,
        because:
          'Recorded in PRODUCTION_STATE.json as verified on 2026-08-08: even the platform owner is '
          + 'refused. A regression here would be silent and serious.',
      },
      {
        item: 'T-003',
        id: 'T-003/org-admins-exist',
        kind: 'sql',
        sql: `select count(*)::int as n from pilot.accounts
              where role = 'organization_admin' and active_flag = true`,
        predicate: (rows) => rows[0].n > 0,
        expectation: 'at least one active organization_admin exists',
        because:
          'A console only org admins may use is unusable if the environment has none. The recorded '
          + 'T-003 verification checked exactly this and found 4.',
      },
    ],
  },
  {
    item: 'BACKLOG-dead-schema',
    title: 'pilot.messages / pilot.skills / pilot.staff dropped',
    probes: [
      {
        item: 'BACKLOG-dead-schema',
        id: 'BACKLOG-dead-schema/tables-absent',
        kind: 'sql',
        sql: `select
                to_regclass('pilot.messages') is null as messages_gone,
                to_regclass('pilot.skills')   is null as skills_gone,
                to_regclass('pilot.staff')    is null as staff_gone`,
        predicate: (rows) => rows[0].messages_gone && rows[0].skills_gone && rows[0].staff_gone,
        expectation: 'all three dead tables absent',
        because:
          'The drop is the entire deliverable, and it is the one thing a code read cannot confirm. '
          + 'Both the base schema and the multiorg migration used to declare these independently, '
          + 'so a re-run of either on a partially-provisioned environment could resurrect them.',
      },
    ],
  },
  {
    item: 'PR-238a',
    title: 'Attendance Engine',
    probes: [
      unauthenticated('PR-238a', '/api/pilot/scheduler/attendance-summary'),
      unauthenticated('PR-238a', '/api/pilot/scheduler'),
      pageRenders('PR-238a', '/admin/attendance'),
    ],
    acceptanceProbeOutstanding:
      'Bulk check-in and parent-method attribution both mutate. attendanceReporting.pg.test.ts is '
      + 'the honest home for those; what is checkable live is that the surface exists and is gated.',
  },
  {
    item: 'PR-238b',
    title: 'Safety Gate Matrix',
    probes: [
      {
        item: 'PR-238b',
        id: 'PR-238b/gate-seeded',
        kind: 'sql',
        sql: `select count(*)::int as n from pilot.safety_gates`,
        predicate: (rows) => rows[0].n > 0,
        expectation: 'at least one safety gate row is seeded',
        because:
          'An empty gate matrix does not fail loudly -- it just never blocks anything, which reads '
          + 'as "no safety problems" instead of "safety substrate inert". contactClearanceGate was '
          + 'shipped as the first row precisely so this is non-empty.',
      },
    ],
  },
  {
    item: 'PR-238c',
    title: 'Red Flag Escalation ladder',
    probes: [
      unauthenticated('PR-238c', '/api/pilot/escalations'),
      pageRenders('PR-238c', '/admin/escalations'),
    ],
    acceptanceProbeOutstanding:
      'Auto-escalation from a near miss is the criterion, and triggering one writes a safeguarding '
      + 'row. Staging-only with a disposable fixture, authored by a human.',
  },
  {
    item: 'PR-238d',
    title: 'Athlete Voice',
    probes: [
      unauthenticated('PR-238d', '/api/pilot/feedback/submit', { method: 'POST' }),
      unauthenticated('PR-238d', '/api/pilot/feedback/list', { method: 'POST' }),
    ],
    acceptanceProbeOutstanding:
      'The non-disclosing, oracle-safe property is the whole point of this item and cannot be '
      + 'checked by a status code. It needs a probe that files a voice escalation as an athlete '
      + 'and asserts the coach-facing surfaces reveal nothing -- disposable fixture, staging only.',
  },
  {
    item: 'PR-238e',
    title: 'Privacy-Tier System',
    noRuntimeProbe:
      'A registry and a refactor with no surface of its own. Its guarantee is a drift guard that '
      + 'hard-requires each FIELD_TIERS entry to name a live reader, and that guard runs in `npm '
      + 'test` on every commit -- which is a stronger and earlier check than anything a deployed '
      + 'environment could answer.',
  },
  {
    item: 'PR-238f',
    title: 'Stop/Hold/Regress',
    probes: [
      unauthenticated('PR-238f', '/api/pilot/training-holds'),
    ],
    acceptanceProbeOutstanding:
      'Enforcement at registration is the criterion: an athlete under a STOP hold must be refused. '
      + 'That needs a held fixture athlete; trainingHolds.pg.test.ts covers the logic.',
  },
  {
    item: 'PR-238g',
    title: 'Portrait review exit UI (T-004)',
    probes: [
      unauthenticated('PR-238g', '/api/pilot/admin/portrait-review'),
      pageRenders('PR-238g', '/admin/portrait-review'),
      admittedForOrgAdmin('PR-238g', '/api/pilot/admin/portrait-review'),
    ],
    acceptanceProbeOutstanding:
      'Approve/reject mutate a minor\'s photo state. Never probed live.',
  },
  {
    item: 'PR-238h',
    title: 'Video compliance review console (T-006)',
    probes: [
      unauthenticated('PR-238h', '/api/pilot/admin/video-compliance'),
      pageRenders('PR-238h', '/admin/video-compliance'),
      admittedForOrgAdmin('PR-238h', '/api/pilot/admin/video-compliance'),
    ],
    acceptanceProbeOutstanding:
      'The CAS guard added here is the interesting property and needs two concurrent decisions to '
      + 'exercise. That is a pg test, not a live probe.',
  },
  {
    item: 'PR-238i',
    title: 'Guardian media consent (T-008)',
    probes: [
      unauthenticated('PR-238i', '/api/pilot/parent/consent'),
      unauthenticated('PR-238i', '/api/pilot/admin/athlete-consent'),
      pageRenders('PR-238i', '/parent/consent'),
      pageRenders('PR-238i', '/admin/athlete-consent'),
    ],
    acceptanceProbeOutstanding:
      'Grant then withdraw, and confirm withdrawal actually suppresses publication. Mutating; '
      + 'staging-only with a disposable guardian/athlete pair.',
  },
  {
    item: 'PR-238j',
    title: 'Incident Report Engine',
    probes: [unauthenticated('PR-238j', '/api/pilot/incidents', { method: 'POST' })],
    acceptanceProbeOutstanding: 'Filing an incident writes a safeguarding row. Fixture needed.',
  },
  {
    item: 'PR-238k',
    title: 'Guardian Safety Report',
    probes: [
      unauthenticated('PR-238k', '/api/pilot/parent/safety'),
      pageRenders('PR-238k', '/parent/safety'),
    ],
    acceptanceProbeOutstanding:
      'The criterion is scoping: a guardian sees their own child and no other. Proving the negative '
      + 'needs two guardian fixtures with known children.',
  },
  {
    item: 'PR-238l',
    title: 'Waiver Compliance audit',
    probes: [
      unauthenticated('PR-238l', '/api/pilot/admin/waiver-status'),
      pageRenders('PR-238l', '/admin/waiver-status'),
    ],
  },
  {
    item: 'PR-238m',
    title: 'Roster-attendance connection',
    probes: [unauthenticated('PR-238m', '/api/pilot/athletes/list')],
    acceptanceProbeOutstanding:
      'Note that BACKLOG-coach-roster-scope is an open, undecided question about this exact route '
      + '(any coach sees the full roster). Do not author a probe that freezes the current scope as '
      + 'correct before the owner rules on intent -- a test asserting today\'s behaviour would make '
      + 'the open question look settled.',
  },
  {
    item: 'PR-238n',
    title: 'Attendance weekly trend',
    probes: [unauthenticated('PR-238n', '/api/pilot/scheduler/attendance-summary')],
    acceptanceProbeOutstanding:
      'The week-over-week strip needs real attendance data to be meaningful, and the runbook '
      + 'records that the floor-hours clock deliberately stays at zero with no backfill. So this '
      + 'renders an honest empty state until real history accumulates; there is nothing to probe.',
  },
  {
    item: 'PR-238o',
    title: 'Behavior/habit note capture',
    probes: [unauthenticated('PR-238o', '/api/pilot/coach-reviews/list')],
  },
  {
    item: 'PR-238p',
    title: 'Rolled-up Safety Review',
    probes: [
      unauthenticated('PR-238p', '/api/pilot/admin/safety-review'),
      pageRenders('PR-238p', '/admin/safety-review'),
    ],
  },
  {
    item: 'PR-238q',
    title: 'Progression hold visibility',
    probes: [pageRenders('PR-238q', '/coach/review-queue')],
    acceptanceProbeOutstanding:
      'The banner only appears for an athlete under an active hold, so it needs the same held '
      + 'fixture as PR-238f.',
  },
  {
    item: 'PR-238r',
    title: 'Merge origin/main (T-007 audit-vocabulary + gym-local dates)',
    noRuntimeProbe:
      'A merge commit. It carries no surface of its own; what it brought in is verified under the '
      + 'rows that introduced it.',
  },
  {
    item: 'PR-238s',
    title: 'Round-9 self-review fixes',
    noRuntimeProbe:
      'Client-side decision-loop and sparkline rendering fixes. Covered by the component suites, '
      + 'which is where DOM behaviour is actually checkable -- a status code cannot see a sparkline.',
  },
  {
    item: 'PR-238t',
    title: 'Parent Dashboard aggregation',
    probes: [
      pageRenders('PR-238t', '/parent/dashboard'),
      pageRenders('PR-238t', '/parent/safety'),
    ],
  },
  {
    item: 'PR-238u',
    title: 'Owner-decision follow-through',
    noRuntimeProbe:
      'A documentation and decision-recording change. Its completion rule is "merged to main", '
      + 'which the queue explicitly permits for documentation-only items.',
  },
  {
    item: 'PR-238v',
    title: 'Family Communication Engine',
    probes: [unauthenticated('PR-238v', '/api/pilot/parent/messages')],
    acceptanceProbeOutstanding:
      'One-directional is the safety property: a parent must not be able to reply into the coach '
      + 'channel. Worth a real probe, and it is a refusal expectation, so it can live here once a '
      + 'guardian fixture exists.',
  },
  {
    item: 'PR-238w',
    title: 'Drill versioning + change-proposal review',
    probes: [unauthenticated('PR-238w', '/api/pilot/drills')],
  },
  {
    item: 'PR-238x',
    title: 'Drill library v3 + activity log + assessment protocols + clearance register',
    probes: [
      unauthenticated('PR-238x', '/api/pilot/drill-library'),
      {
        item: 'PR-238x',
        id: 'PR-238x/drill-library-seeded',
        kind: 'sql',
        sql: `select count(*)::int as n from pilot.drill_library`,
        predicate: (rows) => rows[0].n > 0,
        expectation: 'the drill library has rows',
        because:
          'This is the known production gap, made executable. PRODUCTION_STATE.json records that '
          + 'seed-reference-data has never run against production, so /coach/cohorts and '
          + '/coach/disciplines render empty lists. A FAIL here is the blocker, not a surprise -- '
          + 'and it should keep failing loudly until the seed runs.',
      },
    ],
  },
  {
    item: 'PR-238y',
    title: 'Sparring exposure, safety flags, floor hours ledger, local findings, templates v2',
    probes: [
      unauthenticated('PR-238y', '/api/pilot/safety-flags'),
      unauthenticated('PR-238y', '/api/pilot/workout-templates'),
      unauthenticated('PR-238y', '/api/pilot/admin/local-findings'),
      {
        item: 'PR-238y',
        id: 'PR-238y/floor-hours-public-is-anonymous',
        kind: 'http',
        path: '/api/pilot/floor-hours/public',
        expect: 200,
        because:
          'Deliberately unauthenticated -- it is the public ledger. The 200 here is the point, and '
          + 'it is the one route in this manifest where a 401 would be the defect. The view it '
          + 'reads carries no person or athlete identifier column by construction.',
      },
    ],
  },
  {
    item: 'PR-238z',
    title: 'Quality-weighted SHADOW evidence-tier rule',
    probes: [unauthenticated('PR-238z', '/api/pilot/shadow/library/search', { method: 'POST' })],
    acceptanceProbeOutstanding:
      'The tier rule only shows itself in an answer\'s evidence tier, which needs a real SHADOW '
      + 'query against a populated library. The library is empty pending the corpus import, so '
      + 'this cannot be verified anywhere yet.',
  },
  {
    item: 'PR-238aa',
    title: 'Research-intake seed corpus approval_state fix',
    probes: [
      {
        item: 'PR-238aa',
        id: 'PR-238aa/library-sources',
        kind: 'sql',
        sql: `select count(*)::int as n from pilot.shadow_library_sources`,
        predicate: (rows) => rows[0].n >= 0,
        expectation: 'the sources table is queryable (count recorded, not asserted non-zero)',
        because:
          'Deliberately a non-assertion. The corpus import is an open owner blocker, so demanding '
          + 'rows here would encode a failure we already know about and have decided to wait on. '
          + 'The count is recorded so the ledger shows when it changes.',
      },
    ],
  },
  {
    item: 'PR-238ab',
    title: 'Citation verification and retraction surveillance',
    probes: [
      unauthenticated('PR-238ab', '/api/pilot/admin/citation-checks'),
      unauthenticated('PR-238ab', '/api/pilot/admin/retraction-checks'),
      {
        item: 'PR-238ab',
        id: 'PR-238ab/retrieval-suppressed-column',
        kind: 'sql',
        sql: `select count(*)::int as n from information_schema.columns
              where table_schema = 'pilot'
                and table_name = 'shadow_library_sources'
                and column_name = 'retrieval_suppressed'`,
        predicate: (rows) => rows[0].n === 1,
        expectation: 'shadow_library_sources.retrieval_suppressed exists',
        because:
          'The queue flags this as a hard runtime dependency: searchShadowLibrary now filters on '
          + 'this column, so if the retraction-surveillance migration has not run, every SHADOW '
          + 'library search 42703s. That is a live outage reachable by a deploy alone, and this is '
          + 'the cheapest possible check for it.',
      },
    ],
  },
  {
    item: 'PR-238ac',
    title: 'Session scripts, competence cohorts, multidiscipline, transfer claims, method naming',
    probes: [
      unauthenticated('PR-238ac', '/api/pilot/session-scripts'),
      unauthenticated('PR-238ac', '/api/pilot/competence-cohorts'),
      unauthenticated('PR-238ac', '/api/pilot/multidiscipline'),
      pageRenders('PR-238ac', '/coach/session-scripts'),
      pageRenders('PR-238ac', '/coach/cohorts'),
      pageRenders('PR-238ac', '/coach/disciplines'),
      {
        item: 'PR-238ac',
        id: 'PR-238ac/multidiscipline-publishes-no-writes',
        kind: 'http',
        method: 'POST',
        path: '/api/pilot/multidiscipline',
        expect: [401, 405],
        because:
          'The three write paths are deliberately not exposed -- what a coach is prompted to enter '
          + 'when a choke was completed on a child is a safeguarding decision the gym has not made. '
          + 'A unit test asserts the route publishes no POST; this confirms the deployed image '
          + 'agrees.',
      },
      {
        item: 'PR-238ac',
        id: 'PR-238ac/disciplines-seeded',
        kind: 'sql',
        sql: `select count(*)::int as n from pilot.disciplines`,
        predicate: (rows) => rows[0].n > 0,
        expectation: 'disciplines are seeded',
        because:
          'Same known gap as the drill library: /coach/disciplines renders an empty list on '
          + 'production because seed-reference-data has never run there. Failing here is correct.',
      },
    ],
  },
  {
    item: 'BACKLOG-coach-video-scope',
    title: 'video/list coach branch scope (owner-confirmed intended)',
    noRuntimeProbe:
      'Resolved by an owner decision, not a code change -- both halves of the scope are intended. '
      + 'A guard test already fails if anyone narrows the branch to match the other two, which is '
      + 'the durable protection. There is no deployed behaviour change to verify.',
  },
  {
    item: 'BACKLOG-coach-roster-scope',
    title: 'athletes/list hands any coach the full roster',
    noRuntimeProbe:
      'Still BACKLOG and explicitly not builder-decidable: it is either a real over-exposure of '
      + 'minors\' records or intentional org-wide visibility, and the owner has not ruled. Probing '
      + 'it would mean asserting one answer.',
  },
  {
    item: 'BACKLOG-activity-log-backfill',
    title: 'activity_log supersedes attendance tables',
    noRuntimeProbe:
      'The recorded disposition is to write no backfill at all and treat activity_log as '
      + 'go-forward only. There is no artifact to verify -- deliberately.',
  },
  {
    item: 'BACKLOG-triage-keyboard',
    title: 'keyboard triage for the coach review queue',
    noRuntimeProbe:
      'Nothing is deployed to probe, and a probe would be the wrong artifact anyway. The '
      + 'binding is blocked by landmine 5: approval refuses until a human document review '
      + 'leaves an audit row, so the only thing a probe could assert today is that the '
      + 'refusal fires -- which apply-migrations and the deploy gate already assert, before '
      + 'reviewing anything. Author a probe only once the queue carries a review-complete '
      + 'signal, and probe THAT rather than the keystroke.',
  },
  {
    item: 'BACKLOG-offline-write-queue',
    title: 'offline write queue for the floor kiosk',
    noRuntimeProbe:
      'Unbuilt, and it must stay unbuilt until the owner rules on where queued participant '
      + 'data lives and how it is scoped to an identity on a shared tablet. Probing the '
      + 'current behaviour would freeze "a check-in during an outage is lost" as though it '
      + 'were the intended contract.',
  },
  {
    item: 'BACKLOG-grant-packet',
    title: 'grant/board packet export',
    noRuntimeProbe:
      'Unbuilt. The blocker is a disclosure decision -- which aggregates about minors may '
      + 'leave the organisation, and at what k-anonymity floor -- so there is no behaviour '
      + 'to verify and no defensible assertion to write before the owner sets that floor.',
  },
  {
    item: 'BACKLOG-open-route-gates',
    title: '21 buildingMap doors carry no role gate',
    noRuntimeProbe:
      'Explicitly not builder-decidable, the same shape as BACKLOG-coach-roster-scope: each '
      + 'of the 21 is either intentionally open or a real over-exposure, and the owner has '
      + 'not ruled route by route. A probe asserting today\'s reachability would make the '
      + 'open question look settled. Note also that buildingMap is not the enforcement '
      + 'point, so any probe belongs against the page guard, not the map.',
  },
];

export const PROBES = MANIFEST.flatMap((entry) => entry.probes || []);

export function probesForItems(itemIds) {
  const wanted = new Set(itemIds);
  return PROBES.filter((probe) => wanted.has(probe.item));
}
