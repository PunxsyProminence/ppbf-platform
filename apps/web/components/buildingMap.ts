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
 */

export type Room = 'office' | 'floor' | 'board' | 'file' | 'clinic' | 'night';

/** Every role, for surfaces that carry no gate. */
export const OPEN = 'open' as const;

export interface Door {
  href: string;
  label: string;
  /** Which room the surface stands in — matches the .room--* ground it renders on. */
  room: Room;
  /** Advisory visibility only. See the header note. */
  roles: readonly ClubRole[] | typeof OPEN;
  /** Extra search terms for the catalog: synonyms, layer numbers, jargon. */
  keywords?: string;
  /** One line shown under the label in the catalog. */
  hint?: string;
}

const BOARD_GATE: readonly ClubRole[] = ['board', 'platform_owner'];
const ADMIN_GATE: readonly ClubRole[] = ['admin', 'platform_owner'];

export const BUILDING: readonly Door[] = [
  // ---------------------------------------------------------------- office --
  { href: '/dashboard', label: 'Bell', room: 'office', roles: OPEN,
    keywords: 'home start landing bell', hint: 'The front desk — where a session starts.' },
  { href: '/admin', label: 'Capability Console', room: 'office', roles: ADMIN_GATE,
    keywords: 'capabilities registry matrix builder admin authority',
    hint: 'Capability definitions, assignments, status and role exposure.' },
  { href: '/admin/people', label: 'People', room: 'office', roles: ADMIN_GATE,
    keywords: 'roster members directory participants' },
  { href: '/admin/pin', label: 'PIN Management', room: 'office', roles: ADMIN_GATE,
    keywords: 'pin codes credentials reset kiosk access' },
  { href: '/admin/activation-codes', label: 'Activation Codes', room: 'office', roles: ADMIN_GATE,
    keywords: 'activation codes onboarding invite new athlete' },
  { href: '/admin/feedback', label: 'Feedback Triage', room: 'office', roles: ADMIN_GATE,
    keywords: 'tell us box submissions triage inbox' },
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
  { href: '/admin/board-seats', label: 'Board Seats', room: 'office', roles: ['admin', 'board'],
    keywords: 'seats appointments governance officers' },
  { href: '/admin/grants', label: 'Grant Obligations', room: 'office', roles: ['admin'],
    keywords: 'grants funder deadlines reports deliverables renewals filings compliance obligations',
    hint: 'What the gym owes its funders, soonest due first. Internal records only.' },
  { href: '/admin/payments', label: 'Payment Accounts', room: 'office', roles: ['admin'],
    keywords: 'payments stripe connect giving program donations fees accounts',
    hint: 'Connect the Giving and Program Stripe accounts. Setup only — nothing charges.' },
  { href: '/admin/memberships', label: 'Program Memberships', room: 'office', roles: ['admin'],
    keywords: 'memberships enrollment programs scholarships discounts',
    hint: 'Who is enrolled in what, scholarships recorded as discounts. No billing.' },
  { href: '/admin/data-quality', label: 'Data Quality', room: 'office', roles: ['admin'],
    keywords: 'data quality duplicates guardians split records',
    hint: 'Split guardian records and who they hide. Reports only — merging is a human call.' },
  { href: '/admin/safety-flags', label: 'Safety Flags', room: 'clinic', roles: ['coach', 'admin'],
    keywords: 'safety flags open queue severity resolve blocking advisory',
    hint: 'Every open safety flag, worst first. Resolving requires a note.' },
  { href: '/admin/public-interest', label: 'Public Interest', room: 'office', roles: ADMIN_GATE,
    keywords: 'disclosure transparency public record' },
  { href: '/admin/escalations', label: 'Escalations', room: 'office', roles: ['admin', 'coach'],
    keywords: 'safety red flag near miss pain report escalation queue safeguarding',
    hint: 'Safety, near-miss, and pain-report escalations — the only place they surface.' },
  { href: '/admin/safety-escalations', label: 'Safety Escalations', room: 'office', roles: ['admin', 'coach'],
    keywords: 'safety escalations admin queue legacy alias safeguarding',
    hint: 'Alias for the escalations queue that preserves the safety-escalations route.' },
  { href: '/admin/consent', label: 'Waivers & Consent', room: 'office', roles: ['admin', 'coach'],
    keywords: 'waiver consent signature record general medical travel',
    hint: 'Record that a guardian signed — general, medical, travel, or media.' },
  { href: '/admin/athlete-consent', label: 'Media Consent Audit', room: 'office', roles: ['admin'],
    keywords: 'guardian photo video consent audit safeguarding',
    hint: 'Which athletes have full guardian consent for photo/video use.' },
  { href: '/admin/waiver-status', label: 'Waiver Compliance', room: 'office', roles: ['admin'],
    keywords: 'waiver consent audit compliance general medical travel missing',
    hint: 'Which athletes are missing a signed general/medical/travel/media waiver.' },
  { href: '/admin/safety-review', label: 'Safety Review', room: 'office', roles: ['admin'],
    keywords: 'safety rollup holds gates escalations compliance violations review',
    hint: 'Everything open right now across holds, gates, escalations, and compliance.' },
  { href: '/admin/coach-coverage', label: 'Coach Coverage', room: 'office', roles: ['admin'],
    keywords: 'coach coverage grant revoke sub substitute temporary access athlete',
    hint: 'Grant or revoke temporary access when a coach is covering another coach’s athlete.' },
  { href: '/admin/portrait-review', label: 'Portrait Review', room: 'office', roles: ['admin'],
    keywords: 'photo portrait review pending release block safeguarding' },
  { href: '/admin/video-review', label: 'Video Scan Review', room: 'office', roles: ADMIN_GATE,
    keywords: 'quarantine scan escalation approve block video safeguarding',
    hint: 'Quarantined footage the automated scanner deferred to a human.' },
  { href: '/admin/video-compliance', label: 'Video Compliance Review', room: 'office', roles: ['admin'],
    keywords: 'publication compliance approve reject request changes video safeguarding' },
  { href: '/admin/platform', label: 'Platform', room: 'office', roles: OPEN,
    keywords: 'system settings internals' },
  { href: '/print', label: 'Print', room: 'office', roles: ['athlete', 'parent', 'coach', 'admin', 'platform_owner', 'staff'],
    keywords: 'print roster cards sheets document', hint: 'Print rosters and session cards.' },
  /* "Wall of Names", not "Name Sync": the page's own header calls it the Wall
     of Names and serves initials and years to every signed-in role. There is
     no synchronizing anything here, and a catalog entry that describes a
     directory tool sends a coach looking for admin settings. */
  { href: '/names', label: 'Wall of Names', room: 'office', roles: ['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer', 'board'],
    keywords: 'names roll honour honor alumni initials years wall directory',
    hint: 'Everyone who has trained here — initials and years.' },
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
  /* The office, not the board room: the board room's doors are a board-only
     set (cardCatalog.test.tsx asserts a coach never sees it), and this door is
     open to everybody. A member's own record is an office record. */
  { href: '/profile', label: 'Your Corner', room: 'office',
    roles: ['athlete', 'coach', 'parent', 'admin', 'staff', 'volunteer'],
    keywords: 'profile identity portrait photo ring name nickname corner fight card programme',
    hint: 'Your portrait, ring name, corner and programme.' },
  { href: '/source-control', label: 'Source Control', room: 'office', roles: OPEN,
    keywords: 'versions publication workflow provenance' },
  { href: '/source-control/publication-workflow', label: 'Publication Workflow', room: 'office',
    roles: OPEN, keywords: 'publish review release' },

  // ----------------------------------------------------------------- floor --
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
  { href: '/coach/performance-analytics', label: 'Performance Analytics', room: 'floor',
    roles: ['coach', 'admin'], keywords: 'analytics rollup readiness trend rpe training days sessions roster report',
    hint: 'Roster rollup: sessions, RPE, readiness trend, training days, drill completion. Read-only.' },
  { href: '/coach/video-analysis', label: 'Video Analysis', room: 'floor',
    roles: ['coach', 'admin'], keywords: 'film breakdown footage' },
  { href: '/coach/video-publications', label: 'Video Publications', room: 'floor',
    roles: ['coach'], keywords: 'publish film share video' },
  { href: '/coach/environment/intake-router', label: 'Intake Router', room: 'floor',
    roles: ['coach'], keywords: 'intake routing new athlete triage' },
  { href: '/coach/environment/passbook-check', label: 'Passbook Check', room: 'floor',
    roles: ['coach'], keywords: 'usa boxing passbook insurance eligibility verification' },
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
  { href: '/coach/cohorts', label: 'Cohorts', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'cohort group room competence level tenure ladder who fits where grouping',
    hint: 'Which room an athlete stands in, by what they can do and how long they have trained.' },
  { href: '/coach/disciplines', label: 'Disciplines', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'discipline boxing grappling exposure neck joint choke participation multidiscipline',
    hint: 'What the gym runs, and one athlete’s grappling exposure history.' },
  { href: '/rabbit-holes', label: 'Rabbit Holes', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'lessons tangents deep dives notes anchors',
    hint: 'The tangents worth following, anchored to where they came up.' },
  { href: '/simulator', label: 'Simulator', room: 'floor', roles: OPEN,
    keywords: 'scenario model what-if simulate' },
  { href: '/retro-lab', label: 'Retro Lab', room: 'floor', roles: OPEN,
    keywords: 'retrospective experiment lab' },

  // ----------------------------------------------------------------- board --
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

  // ------------------------------------------------------------------ file --
  { href: '/research', label: 'Research Inbox', room: 'file', roles: OPEN,
    keywords: 'research intake requirements gaps evidence labels' },
  { href: '/research/chat', label: 'Research Chat', room: 'file', roles: OPEN,
    keywords: 'ask research question chat' },
  { href: '/evidence', label: 'Evidence Review', room: 'file', roles: ADMIN_GATE,
    keywords: 'shadow evidence sources citations provenance' },
  { href: '/knowledge-graph', label: 'Knowledge Graph', room: 'file', roles: OPEN,
    keywords: 'concepts relationships map observations findings lessons' },
  { href: '/audit', label: 'Audit Trace', room: 'file', roles: ['admin', 'coach'],
    keywords: 'audit log ledger trace continuity history immutable',
    hint: 'The continuity ledger — what happened and who did it.' },

  // ---------------------------------------------------------------- clinic --
  { href: '/coach/sports-medicine', label: 'Sports Medicine', room: 'clinic', roles: ['coach', 'admin'],
    keywords: 'medical injury concussion clearance return-to-training physio holds cleared restricted board clinic',
    hint: 'Clearance status and active holds for your roster — what the athlete reads, nothing more.' },
  { href: '/admin/compliance-center', label: 'Compliance Center', room: 'clinic', roles: ['admin'],
    keywords: 'compliance safeguarding policy certification safety' },
  { href: '/board/compliance-monitoring', label: 'Compliance Register', room: 'clinic',
    roles: ['board'], keywords: 'compliance register hand-filed monitoring governance' },
  { href: '/board/escalation-monitoring', label: 'Escalation Ladder', room: 'clinic',
    roles: ['board'], keywords: 'escalation ladder safety open severity counts' },

  // ----------------------------------------------------------------- night --
  { href: '/shadow', label: 'Shadow', room: 'night', roles: OPEN,
    keywords: 'layer 20 shadow refusal ai assistant research needed',
    hint: 'Layer 20 — asks, and refuses when it should.' },
  { href: '/shadow/scout', label: 'Shadow Scout', room: 'night', roles: OPEN,
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
