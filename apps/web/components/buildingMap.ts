import type { ClubRole } from './roleRoutes';

/**
 * THE BUILDING MAP — every door in the platform, and which room it opens onto.
 *
 * Law 6 says every screen is a room. Until now nothing said so out loud: there
 * are 63 routes and the global header linked to two of them, so the other 61
 * were reachable only by typing a URL. This map is what the corridor and the
 * card catalog read from.
 *
 * ---------------------------------------------------------------------------
 * `roles` IS A VISIBILITY HINT, NEVER AN AUTHORIZATION DECISION.
 *
 * It exists so the corridor does not advertise a door that will bounce you,
 * and so the catalog does not leak the shape of surfaces you cannot open. The
 * authority is still the page's own guard (RoleSessionGate, BoardRoleGate) and
 * behind that the API's own access checks. If this list and a page guard ever
 * disagree, the guard wins and the fix belongs here, not there.
 *
 * Concretely: hiding a row here does not protect anything. Do not move a
 * permission decision into this file.
 * ---------------------------------------------------------------------------
 *
 * `roles: OPEN` marks a surface with no role gate at all today — sign-in,
 * help, the public pages, and a handful of internal surfaces that are still
 * ungated. They are listed as open because that is what the code does; several
 * of them arguably should be gated, which is a separate piece of work.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE, so it is not re-added by the next person who
 * runs `npm run shots` and reads the UNLISTED count as a to-do list:
 *
 *   - The way in: `/`, `/login`, `/athlete/sign-in`, `/activate`, `/change-pin`.
 *     You do not navigate to a sign-in from inside the building; you arrive
 *     through it. Listing them would put a door to the front step in every
 *     corridor.
 *   - `/launch`: a one-line re-export of `/operations`, not a second surface.
 *     Two doors onto one room is how a catalog starts lying about the size of
 *     the building.
 *
 * Everything else that exists should have a row. Eight surfaces did not, and
 * `/coach/drills` -- the library a coach assigns drills from -- was one of
 * them: reachable only by typing the URL, from a page whose whole job is
 * assigning drills.
 * ---------------------------------------------------------------------------
 *
 * `room` IS NOT AN OPINION HELD HERE. It is a copy of what the page paints --
 * its own `.room--*` class, or the `room=` it hands RoleStandaloneView -- and
 * the two are compared route by route in buildingMapRooms.test.ts. Fourteen
 * doors had drifted from their page before that test existed, and every one of
 * them was invisible: the catalog said Front Office, the wall came up clinic
 * green, and the suite was green too.
 *
 * So a room is not changed here alone. Decide what the SURFACE is for
 * (docs/shadow-ui/ROOM-PURPOSE-DNA.md), then move whichever of the two is
 * wrong about it. The section banners below are the rooms, and every entry
 * sits under its own.
 * ---------------------------------------------------------------------------
 */

export type Room = 'office' | 'floor' | 'board' | 'file' | 'clinic' | 'night';

/** Every role, for surfaces that carry no gate. */
export const OPEN = 'open' as const;

export interface Door {
  href: string;
  label: string;
  /** Which room the surface stands in — matches the .room--* ground it renders
      on, and buildingMapRooms.test.ts fails if it stops matching. */
  room: Room;
  /** Advisory visibility only. See the header note. */
  roles: readonly ClubRole[] | typeof OPEN;
  /** Extra search terms for the catalog: synonyms, layer numbers, jargon. */
  keywords?: string;
  /** One line shown under the label in the catalog. */
  hint?: string;
  /**
   * The page REFUSES A ROLE ON THIS SAME URL instead of redirecting it away.
   *
   * Almost every guarded surface here sends a role it does not want somewhere
   * else, so nobody ever reads a refusal standing on the door. A handful
   * deliberately do not: they render a title, a reason, and the two ways out.
   * P0.2 in docs/shadow-ui/PRODUCTION-FAST-TRACK.md says that screen is
   * "Title + body + Dashboard + Logout only", which is a statement about the
   * WHOLE screen — and the global session bar is part of the screen.
   *
   * Marking the door lets the one component mounted on every route
   * (GlobalRoleHeader) recognise a refusal without knowing anything about the
   * page. Still advisory: it decides chrome, never access.
   */
  refusesInPlace?: true;
}

const BOARD_GATE: readonly ClubRole[] = ['board', 'platform_owner'];
const ADMIN_GATE: readonly ClubRole[] = ['admin', 'platform_owner'];
/* The client-side spelling of SHADOW_PROJECTION_READ_ROLES: every seat inside
   an organization, plus Omega for the read. 'admin' covers organization_admin
   (mapPilotRoleToClubRole collapses the pair); 'board' is absent because
   ORGANIZATION_MEMBER_ROLES does not carry it.

   It is also, member for member, the client spelling of SHADOW_CHAT_ROLES in
   app/shadow/page.tsx and of the requireRole list on the chat and sessions
   routes -- not by coincidence: all three are ORGANIZATION_MEMBER_ROLES plus
   platform_owner written out. The SHADOW door below uses it rather than
   standing up a second copy of the same seven roles. */
const MEMBER_GATE: readonly ClubRole[] = [
  'athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer',
];

/* /shadow/scout's own guard, which that page calls `canAccessAdmin`: everybody
   else is sent back to /shadow. organization_admin collapses into 'admin'. */
const SCOUT_GATE: readonly ClubRole[] = ['admin', 'coach', 'platform_owner'];

export const BUILDING: readonly Door[] = [
  // ---------------------------------------------------------------- office --
  { href: '/dashboard', label: 'Bell', room: 'office', roles: OPEN,
    keywords: 'home start landing bell', hint: 'The front desk — where a session starts.' },
  { href: '/admin', label: 'Capability Console', room: 'office', roles: ADMIN_GATE,
    keywords: 'capabilities registry matrix builder admin authority',
    hint: 'Capability definitions, assignments, status and role exposure.' },
  { href: '/admin/people', label: 'People', room: 'office', roles: ADMIN_GATE,
    keywords: 'roster members directory participants' },
  /* This file, read from the front desk. The register prints the doors below
     grouped by role and by room -- label, path, room -- and nothing else: it
     performs no fetch, and it previews a role's NAVIGATION, never a role's
     records or a role's session. 'view as' is in the keywords because that is
     the phrase somebody will search for, and the label deliberately is not,
     since 'View As' is the industry's word for impersonation and this is the
     opposite of one (see the header of the page). */
  { href: '/admin/door-register', label: 'Door Register', room: 'office', roles: ADMIN_GATE,
    keywords: 'view as preview role structure navigation tabs doors rooms register map building sitemap routes',
    hint: 'Every door each role holds, by room. Route structure only — never another person’s records.' },
  { href: '/admin/pin', label: 'PIN Management', room: 'office', roles: ADMIN_GATE,
    keywords: 'pin codes credentials reset kiosk access' },
  { href: '/admin/activation-codes', label: 'Activation Codes', room: 'office', roles: ADMIN_GATE,
    keywords: 'activation codes onboarding invite new athlete' },
  { href: '/admin/attendance', label: 'Attendance', room: 'office', roles: ['admin', 'coach'],
    keywords: 'attendance rollup check-in reporting summary class' },
  { href: '/admin/volunteer-management', label: 'Volunteers', room: 'office', roles: ADMIN_GATE,
    keywords: 'volunteer hours coverage signup' },
  { href: '/admin/community-service', label: 'Community Service', room: 'office', roles: ['coach', 'admin'],
    keywords: 'community service hours verified volunteer school court scholarship',
    hint: 'Service hours per person \u2014 verified and unverified kept apart, never summed.' },
  { href: '/admin/customize', label: 'Customize the Gym', room: 'office', roles: ADMIN_GATE,
    keywords: 'photos photographs wall pictures upload building frames banners boards chalk customization appearance',
    hint: 'Photographs, boards, and notices — the gym’s look and voice, one desk.' },
  { href: '/admin/organizations', label: 'Organizations', room: 'office', roles: ADMIN_GATE,
    keywords: 'orgs tenants gyms affiliates' },
  { href: '/admin/grants', label: 'Grant Obligations', room: 'office', roles: ['admin'],
    keywords: 'grants funder deadlines reports deliverables renewals filings compliance obligations',
    hint: 'What the gym owes its funders, soonest due first. Internal records only.' },
  { href: '/admin/payments', label: 'Payment Accounts', room: 'office', roles: ['admin'],
    keywords: 'payments stripe connect giving program donations fees accounts',
    hint: 'Connect the Giving and Program Stripe accounts. Setup only — nothing charges.' },
  { href: '/admin/memberships', label: 'Program Memberships', room: 'office', roles: ['admin'],
    keywords: 'memberships enrollment programs scholarships discounts',
    hint: 'Who is enrolled in what, scholarships recorded as discounts. No billing.' },
  { href: '/admin/program-phases', label: 'Program Phases', room: 'office', roles: ['coach', 'admin'],
    keywords: 'phase block periodization foundation competition prep off season program cycle',
    hint: 'Which block each program is in, declared by a person. History kept.' },
  { href: '/admin/data-quality', label: 'Data Quality', room: 'office', roles: ['admin'],
    keywords: 'data quality duplicates guardians split records',
    hint: 'Split guardian records and who they hide. Reports only — merging is a human call.' },
  { href: '/admin/public-interest', label: 'Public Interest', room: 'office', roles: ADMIN_GATE,
    keywords: 'disclosure transparency public record' },
  { href: '/admin/consent', label: 'Waivers & Consent', room: 'office', roles: ['admin', 'coach'],
    keywords: 'waiver consent signature record general medical travel',
    hint: 'Record that a guardian signed — general, medical, travel, or media.' },
  { href: '/admin/coach-coverage', label: 'Coach Coverage', room: 'office', roles: ['admin'],
    keywords: 'coach coverage grant revoke sub substitute temporary access athlete',
    hint: 'Grant or revoke temporary access when a coach is covering another coach’s athlete.' },
  { href: '/admin/portrait-review', label: 'Portrait Review', room: 'office', roles: ['admin'],
    keywords: 'photo portrait review pending release block safeguarding' },
  { href: '/admin/credentials', label: 'Staff Credentials', room: 'office', roles: ['admin'],
    keywords: 'safesport certification background check cpr first aid credential verify queue expired expiring',
    hint: 'Verify submitted certification documents and confirm issue/expiry dates.' },
  { href: '/admin/video-review', label: 'Video Scan Review', room: 'office', roles: ADMIN_GATE,
    keywords: 'quarantine scan escalation approve block video safeguarding',
    hint: 'Quarantined footage the automated scanner deferred to a human.' },
  { href: '/admin/platform', label: 'Platform', room: 'office', roles: OPEN,
    keywords: 'system settings internals' },
  { href: '/print', label: 'Print', room: 'office', roles: ['athlete', 'parent', 'coach', 'admin', 'platform_owner', 'staff'],
    keywords: 'print roster cards sheets document', hint: 'Print rosters and session cards.' },
  { href: '/staff-credentials', label: 'Certified & Cleared', room: 'office', roles: ['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer', 'board'],
    keywords: 'safesport certification background check cpr first aid credential status staff trained certified',
    hint: 'The training and clearance status this gym’s coaches and staff hold — status only, never the documents.' },
  { href: '/operations', label: 'Operations Hub', room: 'office', roles: OPEN,
    keywords: 'mission control operations hub', hint: 'Cross-role operational launcher.' },
  { href: '/operations/external-competition', label: 'External Competition', room: 'office', roles: ['coach', 'admin'],
    keywords: 'meets tournaments away events entries',
    hint: 'Outside meets and tournaments with athlete entries — skeleton records.' },
  { href: '/operations/wrestling-league', label: 'Wrestling League', room: 'office', roles: ['coach', 'admin'],
    keywords: 'wrestling league season roster',
    hint: 'League seasons, events, and rosters — skeleton records.' },
  { href: '/workspace', label: 'Staff & Volunteer Workspace', room: 'office',
    roles: ['staff', 'volunteer'], keywords: 'staff volunteer shifts tasks' },
  { href: '/notices', label: 'Notices', room: 'office',
    roles: ['admin', 'coach', 'platform_owner', 'board'],
    keywords: 'announcements bulletins posts alerts' },
  { href: '/chalkboard', label: 'Chalkboard', room: 'office', roles: ['coach', 'admin', 'platform_owner', 'board'],
    keywords: 'announcements boards notices chalk', hint: 'Live board editing — from behind the desk.' },
  { href: '/guardian', label: 'Guardian Portal', room: 'office', roles: ['parent'],
    keywords: 'waiver consent minor family guardian renewal',
    hint: 'Minor records and consent, for the person responsible.' },
  { href: '/parent/dashboard', label: 'Parent Hub', room: 'office', roles: ['parent'],
    keywords: 'family child progress parent' },
  { href: '/parent/consent', label: 'Photo & Video Consent', room: 'office', roles: ['parent'],
    keywords: 'guardian media photo video consent grant withdraw',
    hint: 'Grant or withdraw consent for your child’s photos and videos.' },
  { href: '/parent/safety', label: 'Safety Status', room: 'office', roles: ['parent'],
    keywords: 'guardian hold pause gate clearance safety status',
    hint: 'See whether your child’s training is paused and their safety-check status.' },
  { href: '/parent/progression-visibility', label: 'Progress Visibility', room: 'office',
    roles: ['parent'], keywords: 'child progress attendance visibility' },
  { href: '/public', label: 'Public Page', room: 'office', roles: OPEN,
    keywords: 'enrollment join intake public onboarding' },
  { href: '/help', label: 'Help', room: 'office', roles: OPEN, keywords: 'support docs how-to faq' },
  { href: '/store', label: 'Equipment Store', room: 'office', roles: OPEN,
    keywords: 'shop store gear equipment gloves wraps buy price',
    hint: 'Gyms with a store, and what they sell.' },
  /* The office, not the board room: no door in the board room is visible below
     admin (cardCatalog.test.tsx asserts a coach never sees that room at all),
     and this one is open to everybody. A member's own record is an office
     record. */
  { href: '/profile', label: 'Your Corner', room: 'office',
    roles: ['athlete', 'coach', 'parent', 'admin', 'staff', 'volunteer'],
    keywords: 'profile identity portrait photo ring name nickname corner fight card programme',
    hint: 'Your portrait, ring name, corner and programme.' },
  { href: '/source-control', label: 'Source Control', room: 'office', roles: OPEN,
    keywords: 'versions publication workflow provenance' },
  { href: '/source-control/publication-workflow', label: 'Publication Workflow', room: 'office',
    roles: OPEN, keywords: 'publish review release' },
  /* Two coach routes that are desk work rather than floor work, and both
     already paint .room--office. A cohort is a RULE and a discipline record is
     READ ONLY: neither runs a session, neither is touched with gloves on, and
     both are tables you read at a desk to answer "who fits where" and "what
     was this athlete exposed to". /coach is not a synonym for the gym floor --
     /coach/sports-medicine has stood in the clinic all along. The floor is
     where /coach/floor-groups splits the room that actually showed up. */
  { href: '/coach/cohorts', label: 'Cohorts', room: 'office', roles: ['coach', 'admin'],
    keywords: 'cohort group room competence level tenure ladder who fits where grouping',
    hint: 'Which room an athlete stands in, by what they can do and how long they have trained.' },
  { href: '/coach/disciplines', label: 'Disciplines', room: 'office', roles: ['coach', 'admin'],
    keywords: 'discipline boxing grappling exposure neck joint choke participation multidiscipline',
    hint: 'What the gym runs, and one athlete’s grappling exposure history.' },

  // ----------------------------------------------------------------- floor --
  /* "Wall of Names", not "Name Sync": the page's own header calls it the Wall
     of Names and serves initials and years to every signed-in role. There is
     no synchronizing anything here, and a catalog entry that describes a
     directory tool sends a coach looking for admin settings. */
  { href: '/names', label: 'Wall of Names', room: 'floor', roles: ['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer', 'board'],
    keywords: 'names roll honour honor alumni initials years wall directory',
    hint: 'Everyone who has trained here — initials and years.' },
  { href: '/schedule', label: 'Schedule', room: 'floor',
    roles: ['athlete', 'coach', 'parent', 'admin'],
    keywords: 'classes sessions registration attendance calendar today',
    hint: "The day's sessions — registration and attendance." },
  { href: '/wall', label: 'The Wall', room: 'floor', roles: OPEN,
    keywords: 'display floor screen tv broadcast', hint: 'Gym floor display — TV at the front desk.' },
  { href: '/athlete/dashboard', label: 'Athlete Workspace', room: 'floor', roles: ['athlete'],
    keywords: 'my training check-in rpe session athlete' },
  { href: '/athlete/dashboard/sparring', label: 'Sparring', room: 'floor', roles: OPEN,
    keywords: 'sparring contact rounds partner' },
  { href: '/athlete/progression-intelligence', label: 'My Progression', room: 'floor',
    roles: ['athlete'], keywords: 'progress load profile improvement' },
  { href: '/athlete/video-analysis', label: 'My Video', room: 'floor', roles: ['athlete'],
    keywords: 'film footage review video' },
  { href: '/coach/review-queue', label: 'Review Queue', room: 'floor', roles: ['coach'],
    keywords: 'layer 10 queue approve deny triage decisions pending',
    hint: 'Layer 10 — the decision queue.' },
  { href: '/coach/decision-loop', label: 'Decision Loop', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'decisions loop feedback' },
  { href: '/coach/recognition', label: 'Recognition', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'praise credit caught being good character mentorship pairing well done',
    hint: 'Tell an athlete they did well — two taps. And pair mentors with newer athletes.' },
  { href: '/coach/progression-intelligence', label: 'Progression Intelligence', room: 'floor',
    roles: ['coach'], keywords: 'athlete progress load profiles cohort' },
  { href: '/coach/cards', label: 'Coach Cards', room: 'floor', roles: ['coach'],
    keywords: 'card issue assign work homework drill program group athlete verify dispute',
    hint: 'Issue work to one athlete or a whole program, then verify what comes back.' },
  { href: '/coach/performance-analytics', label: 'Performance Analytics', room: 'floor',
    roles: ['coach', 'admin'], keywords: 'analytics rollup readiness trend rpe training days sessions roster report',
    hint: 'Roster rollup: sessions, RPE, readiness trend, training days, drill completion. Read-only.' },
  { href: '/coach/video-analysis', label: 'Video Analysis', room: 'floor',
    roles: ['coach', 'admin'], keywords: 'film breakdown footage' },
  { href: '/coach/video-publications', label: 'Video Publications', room: 'floor',
    roles: ['coach'], keywords: 'publish film share video' },
  { href: '/coach/environment/intake-router', label: 'Intake Router', room: 'floor',
    roles: ['coach'], keywords: 'intake routing new athlete triage' },
  /* "Passbook Check" until 2026-08-19, and the word was doing two jobs. USA
     Boxing's passbook is the external competitor book this scaffold is a
     placeholder for; the athlete's passbook is this platform's own record
     book -- `/coach/passbook-gaps` below, over `src/server/pilot/passbook.ts`.
     One label for both taught every reader the wrong thing, so this door now
     names the external check it is actually about. The route, the page and
     its "Planned -- Not Yet Implemented" disclosure are untouched: nothing
     behind this door is built yet, and it must keep saying so. */
  { href: '/coach/environment/passbook-check', label: 'USA Boxing Eligibility Check', room: 'floor',
    roles: ['coach'],
    keywords: 'usa boxing passbook competitor book insurance eligibility verification sanction',
    hint: 'Planned \u2014 the external USA Boxing check. Nothing is wired to a real source yet.' },
  { href: '/coach/passbook-gaps', label: 'Passbook Gaps', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'passbook gap retention stopped coming absent last seen queue triage book athlete record',
    hint: 'Open gaps in your athletes\u2019 books, worst attendance first \u2014 last seen, and absent days since.' },
  { href: '/coach/drills', label: 'Drills', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'drills exercises techniques practice assign library catalogue',
    hint: 'Drill library and programming.' },
  { href: '/coach/cue-library', label: 'Cue Library', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'cues coaching cues external focus analogy constraint families',
    hint: 'Every cue written into the drill library, searchable in one place. Read-only.' },
  { href: '/coach/intelligence', label: 'The Morning Read', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'intelligence digest morning read stalled gaps readiness attendance unreviewed holds',
    hint: 'Five deterministic reads of your athletes\u2019 records, by urgency. No scores, no predictions.' },
  { href: '/coach/attempt-log', label: 'Attempt Log', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'attempts reps time distance load failures misses edge',
    hint: 'Every attempt, made or missed \u2014 the misses are the point. No comparisons.' },
  { href: '/coach/transfer-check', label: 'Transfer Check', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'transfer false progress practice live sparring holds breaks honesty',
    hint: 'Does what holds in practice hold live? Flags with raw counts, never a verdict.' },
  { href: '/coach/intervention-protocols', label: 'Intervention Protocols', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'intervention protocol hypothesis intent exposure supersede retire',
    hint: 'What we intend to do about a problem, written down before we do it.' },
  { href: '/coach/intervention-executions', label: 'The Work', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'intervention execution delivered adherence deviation planned actual stop the work',
    hint: 'What actually got delivered against each protocol — plan frozen, gap visible.' },
  { href: '/coach/intervention-review', label: 'What We Learned', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'intervention review evidence outcome hypothesis learning loop decision counterevidence',
    hint: 'Decision, plan, delivery, evidence, verdict — the whole loop, three honest answers.' },
  { href: '/coach/session-scripts', label: 'Session Scripts', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'session script lesson plan block minute run sheet class plan cheat sheet reset protocol',
    hint: 'The plan for a session, block by block. Minutes from the start, not clock times.' },
  { href: '/coach/behavior-standards', label: 'Standards', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'behavior standards conduct recognition expectations concern safeguarding discipline',
    hint: 'What the gym expects \u2014 recognition when met, safeguarding when not.' },
  { href: '/coach/floor-groups', label: "Today's Floor", room: 'floor', roles: ['coach', 'admin'],
    keywords: 'floor groups stations circuit rotation small groups who showed up split room',
    hint: 'The room split for whoever showed up \u2014 circuits or small groups, today only.' },
  { href: '/coach/one-percent-club', label: '1% Club', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'one percent club leadership pathway nomination vote milestone recognition',
    hint: 'Nominate, vote, and see who has been confirmed \u2014 majority vote, always.' },
  { href: '/coach/credentials', label: 'My Credentials', room: 'floor', roles: ['coach', 'admin', 'staff', 'volunteer'],
    keywords: 'safesport certification background check cpr first aid credential upload document',
    hint: 'Upload your own certification documents \u2014 an admin verifies before status shows current.' },
  { href: '/rabbit-holes', label: 'Rabbit Holes', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'lessons tangents deep dives notes anchors',
    hint: 'The tangents worth following, anchored to where they came up.' },
  { href: '/retro-lab', label: 'Retro Lab', room: 'floor', roles: OPEN,
    keywords: 'retrospective experiment lab' },

  // ----------------------------------------------------------------- board --
  /* The board room, though an admin does the appointing: the DNA sheet gives
     the board room "seat workspaces", the page's own eyebrow reads GOVERNANCE,
     and it holds no athlete detail at all. Unlike /profile -- open to
     everybody, and therefore an office record -- this door is admin/board
     only, so it does not put the board room in a coach's corridor. */
  { href: '/admin/board-seats', label: 'Board Seats', room: 'board', roles: ['admin', 'board'],
    keywords: 'seats appointments governance officers' },
  { href: '/board', label: 'Board Hub', room: 'board', roles: BOARD_GATE,
    keywords: 'governance seats directory board hub',
    hint: 'Seat directory and governance control surface.' },
  { href: '/board/president', label: 'President', room: 'board', roles: BOARD_GATE, keywords: 'seat officer' },
  { href: '/board/chair', label: 'Chair', room: 'board', roles: BOARD_GATE, keywords: 'seat officer' },
  { href: '/board/vice-chair', label: 'Vice Chair', room: 'board', roles: BOARD_GATE, keywords: 'seat officer' },
  { href: '/board/treasurer', label: 'Treasurer', room: 'board', roles: BOARD_GATE,
    keywords: 'seat officer finance budget funds' },
  { href: '/board/secretary', label: 'Secretary', room: 'board', roles: BOARD_GATE,
    keywords: 'seat officer minutes records' },
  { href: '/board/safety-director', label: 'Safety Director', room: 'board', roles: BOARD_GATE,
    keywords: 'seat officer safety welfare' },
  { href: '/board/community-director', label: 'Community Director', room: 'board', roles: BOARD_GATE,
    keywords: 'seat officer outreach community' },
  { href: '/board/at-large', label: 'At Large', room: 'board', roles: BOARD_GATE, keywords: 'seat officer' },
  /* Board, not clinic. Both pages are BoardRoleGate-only, both are headed
     "Board Workspace", and both are counts with a minimum cohort size and no
     name, case or detail -- "aggregate only", which is the board room's whole
     definition. Working the ladder is the admin's job and lives in the clinic;
     watching the totals is governance. (compliance-monitoring still carries a
     stale comment calling itself the clinic room while painting .room--board:
     a page edit, for whoever owns that file.) */
  { href: '/board/compliance-monitoring', label: 'Compliance Register', room: 'board',
    roles: ['board'], keywords: 'compliance register hand-filed monitoring governance' },
  { href: '/board/escalation-monitoring', label: 'Escalation Ladder', room: 'board',
    roles: ['board'], keywords: 'escalation ladder safety open severity counts' },

  // ------------------------------------------------------------------ file --
  /* Stage 4 of the knowledge pipeline, so it stands where the other stages
     do. DevelopmentPipelineBanner runs research -> evidence -> knowledge-graph
     -> simulator -> audit, and every one of those is the file room. The page
     reads no gym record and touches no athlete: it is a front-end sandbox for
     what-ifs, which is archive work, not floor work. The page still paints
     .room--office and needs the matching edit -- see buildingMapRooms.test.ts,
     PAGE_IS_WRONG. */
  { href: '/simulator', label: 'Simulator', room: 'file', roles: OPEN,
    keywords: 'scenario model what-if simulate' },
  { href: '/research', label: 'Research Inbox', room: 'file', roles: MEMBER_GATE,
    keywords: 'research intake requirements gaps evidence labels' },
  { href: '/research/chat', label: 'Research Chat', room: 'file', roles: MEMBER_GATE,
    keywords: 'ask research question chat' },
  { href: '/research/review', label: 'Submission Review', room: 'file', roles: ADMIN_GATE,
    keywords: 'submission review responsive partially responsive not responsive duplicate applicability curator' },
  { href: '/evidence', label: 'Evidence Review', room: 'file', roles: ADMIN_GATE,
    keywords: 'shadow evidence sources citations provenance' },
  { href: '/knowledge-graph', label: 'Knowledge Graph', room: 'file', roles: OPEN,
    keywords: 'concepts relationships map observations findings lessons' },
  { href: '/audit', label: 'Audit Trace', room: 'file', roles: ['admin', 'coach'],
    keywords: 'audit log ledger trace continuity history immutable',
    hint: 'The continuity ledger — what happened and who did it.' },

  // ---------------------------------------------------------------- clinic --
  /* The admin safeguarding cluster stands in the clinic, not at the front
     desk. Every one of these pages already paints .room--clinic; the map said
     office, so the catalog filed the safety queues under records while the
     wall came up green. The DNA sheet gives the clinic "medical clearance,
     holds, compliance, safeguarding", which is what these queues are --
     consent audits and waiver compliance included, because what they audit is
     whether a child may train, not whether a form is tidy.

     Feedback Triage is here for the same reason and is the closest call in the
     cluster: most of what arrives is an opinion about the gym. But the page
     opens with the submissions where "an athlete wrote about being hurt,
     frightened, or not wanting to be here", and a surface whose first screen
     is a disclosure is not front-desk work. */
  { href: '/admin/feedback', label: 'Feedback Triage', room: 'clinic', roles: ADMIN_GATE,
    keywords: 'tell us box submissions triage inbox' },
  { href: '/admin/safety-flags', label: 'Safety Flags', room: 'clinic', roles: ['coach', 'admin'],
    keywords: 'safety flags open queue severity resolve blocking advisory',
    hint: 'Every open safety flag, worst first. Resolving requires a note.' },
  { href: '/admin/escalations', label: 'Escalations', room: 'clinic', roles: ['admin', 'coach'],
    keywords: 'safety red flag near miss pain report escalation queue safeguarding',
    hint: 'Safety, near-miss, and pain-report escalations — the only place they surface.' },
  /* Same surface as the door above -- the page is a redirect() to it -- so it
     stands in the same room. Two doors onto one queue, filed under two rooms,
     is the catalog describing a building that does not exist. */
  { href: '/admin/safety-escalations', label: 'Safety Escalations', room: 'clinic', roles: ['admin', 'coach'],
    keywords: 'safety escalations admin queue legacy alias safeguarding',
    hint: 'Alias for the escalations queue that preserves the safety-escalations route.' },
  { href: '/admin/athlete-consent', label: 'Media Consent Audit', room: 'clinic', roles: ['admin'],
    keywords: 'guardian photo video consent audit safeguarding',
    hint: 'Which athletes have full guardian consent for photo/video use.' },
  { href: '/admin/waiver-status', label: 'Waiver Compliance', room: 'clinic', roles: ['admin'],
    keywords: 'waiver consent audit compliance general medical travel missing',
    hint: 'Which athletes are missing a signed general/medical/travel/media waiver.' },
  { href: '/admin/safety-review', label: 'Safety Review', room: 'clinic', roles: ['admin'],
    keywords: 'safety rollup holds gates escalations compliance violations review',
    hint: 'Everything open right now across holds, gates, escalations, and compliance.' },
  { href: '/admin/video-compliance', label: 'Video Compliance Review', room: 'clinic', roles: ['admin'],
    keywords: 'publication compliance approve reject request changes video safeguarding' },
  { href: '/coach/sports-medicine', label: 'Sports Medicine', room: 'clinic', roles: ['coach', 'admin'],
    keywords: 'medical injury concussion clearance return-to-training physio holds cleared restricted board clinic',
    hint: 'Clearance status and active holds for your roster — what the athlete reads, nothing more.' },
  { href: '/admin/compliance-center', label: 'Compliance Center', room: 'clinic', roles: ['admin'],
    keywords: 'compliance safeguarding policy certification safety' },

  // ----------------------------------------------------------------- night --
  /* Both of these were `roles: OPEN`, which is the one thing the header of this
     file says a row must never be: a door the corridor advertises and the page
     then bounces you off. Neither is ungated. /shadow refuses any role outside
     SHADOW_CHAT_ROLES in place, and /shadow/scout redirects anyone outside its
     own admin check -- so a board member was shown an After Hours room holding
     two doors, and both of them bounce that role.

     That is not only a courtesy bug. ROOM-PURPOSE-DNA.md lists "Ask SHADOW
     chat" first under the board room's FORBIDDEN, and its own checklist asks
     "Does board show chat? YES -> delete". The audiences below are read off
     the two guards; hiding the rows does not gate anything, and the guards
     remain the authority. */
  { href: '/shadow', label: 'Shadow', room: 'night', roles: MEMBER_GATE,
    refusesInPlace: true,
    keywords: 'layer 20 shadow refusal ai assistant research needed',
    hint: 'Layer 20 — asks, and refuses when it should.' },
  { href: '/shadow/scout', label: 'Shadow Scout', room: 'night', roles: SCOUT_GATE,
    keywords: 'scout discover shadow' },
  { href: '/admin/shadow', label: 'Shadow Console', room: 'night', roles: ADMIN_GATE,
    keywords: 'shadow admin intake metrics feedback moderation' },
];

/** The rooms, in the order a corridor should present them. */
export const ROOM_ORDER: readonly Room[] = ['office', 'floor', 'board', 'file', 'clinic', 'night'];

export const ROOM_LABEL: Record<Room, string> = {
  office: 'Front Office',
  floor: 'Gym Floor',
  board: 'Board Room',
  file: 'File Room',
  clinic: 'Clinic',
  night: 'After Hours',
};

/** One line describing what each room is for, shown in the corridor. */
export const ROOM_BLURB: Record<Room, string> = {
  office: 'Admin, records, families, operations.',
  floor: 'Training, schedule, queues, film.',
  board: 'Governance and the eight seats.',
  file: 'Research, evidence, the ledger.',
  clinic: 'Medical clearance and compliance.',
  night: 'Shadow, and anything after hours.',
};

/**
 * Doors a session may see. Advisory only — see the note at the top of the file.
 * A null session sees only OPEN surfaces.
 */
export function visibleDoors(role: ClubRole | null): Door[] {
  return BUILDING.filter((d) => {
    if (d.roles === OPEN) return true;
    if (!role) return false;
    // platform_owner is broader in breadth but NARROWER in depth (see
    // roleRoutes.ts) — so it is not a wildcard here either. It sees a door only
    // when that door names it.
    return d.roles.includes(role);
  });
}

/** Doors grouped by room, preserving ROOM_ORDER and dropping empty rooms. */
export function doorsByRoom(role: ClubRole | null): Array<{ room: Room; doors: Door[] }> {
  const visible = visibleDoors(role);
  return ROOM_ORDER
    .map((room) => ({ room, doors: visible.filter((d) => d.room === room) }))
    .filter((g) => g.doors.length > 0);
}

/**
 * Rank doors against a query. Subsequence match on label first (so "revq"
 * finds "Review Queue"), then keywords, then href. Exact prefix wins.
 * Returns every door when the query is empty, so the catalog opens as a browse.
 */
export function searchDoors(role: ClubRole | null, query: string): Door[] {
  const visible = visibleDoors(role);
  const q = query.trim().toLowerCase();
  if (!q) return visible;

  const scored: Array<{ door: Door; score: number }> = [];
  for (const door of visible) {
    const label = door.label.toLowerCase();
    const hay = `${label} ${door.keywords ?? ''} ${door.href}`.toLowerCase();

    let score = -1;
    if (label.startsWith(q)) score = 100;
    else if (label.includes(q)) score = 80;
    else if (hay.includes(q)) score = 60;
    else if (isSubsequence(q, label)) score = 40;
    else if (isSubsequence(q, hay)) score = 20;

    if (score >= 0) {
      // Shorter labels win ties: "Shadow" should outrank "Shadow Console".
      scored.push({ door, score: score - label.length * 0.01 });
    }
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.door);
}

/** Does every character of `needle` appear in `hay`, in order? */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** The door matching a pathname exactly, else the longest matching prefix. */
export function doorForPath(pathname: string): Door | null {
  let best: Door | null = null;
  for (const d of BUILDING) {
    if (d.href === pathname) return d;
    if (pathname.startsWith(d.href + '/') && (!best || d.href.length > best.href.length)) {
      best = d;
    }
  }
  return best;
}

/* ==========================================================================
   WHERE AN EASTER EGG MAY STAND

   docs/shadow-ui/ROOM-PURPOSE-DNA.md answers "Easter eggs?" for all six rooms
   and the answer is only twice yes: the gym floor is their PRIMARY HOME, and
   the front office takes them as chalk, notices and photographs. The other
   four say NEVER in capitals -- board, file, clinic, and after hours on a
   deny. docs/shadow-ui/EGGS-LOAD-FIRST-12.md says the same thing from the
   other end: "Never load onto: board, file, clinic, shadow deny."

   This matters here rather than only in the pages because the two components
   that carry eggs -- the card catalog's bell and the gym's noticing lines --
   are mounted by the global header on EVERY route, with no idea which room
   they are standing in. One predicate, read from the room, is what keeps a
   flourish out of a governance screen and a clinic.
   ========================================================================== */

/** The two rooms whose DNA permits an easter egg. */
export const EGG_ROOMS: readonly Room[] = ['office', 'floor'];

export function roomAllowsEggs(room: Room | null | undefined): boolean {
  return room !== null && room !== undefined && EGG_ROOMS.includes(room);
}

/**
 * May the surface at this path carry an egg?
 *
 * A path with no door answers NO, deliberately. Four of the six rooms forbid
 * eggs outright, so "somewhere the map has never heard of" is much more likely
 * to be one of those than one of the two that allow them; and the cost of the
 * two answers is not symmetric — a missing flourish is nothing, a joke in a
 * clinic is the thing the DNA is written to prevent.
 */
export function pathAllowsEggs(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return roomAllowsEggs(doorForPath(pathname)?.room);
}

/**
 * Is this session standing on a door that refuses it WHERE IT STANDS?
 *
 * True only for a door marked `refusesInPlace` whose audience excludes the
 * session's role — i.e. the session is reading a refusal, not a surface. The
 * global session bar goes minimal on that answer so the refusal screen is the
 * title, the body, and the two ways out, and nothing else (P0.2).
 *
 * Advisory, like every other use of `roles` in this file: a wrong answer here
 * costs a header, never a permission. A signed-out visitor is false — the bar
 * is already minimal for them by its own pre-auth branch.
 */
export function isRefusalSurface(
  role: ClubRole | null,
  pathname: string | null | undefined,
): boolean {
  if (!role || !pathname) return false;
  const door = doorForPath(pathname);
  if (!door?.refusesInPlace || door.roles === OPEN) return false;
  return !door.roles.includes(role);
}
