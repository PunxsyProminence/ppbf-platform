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
  { href: '/admin/volunteer-management', label: 'Volunteers', room: 'office', roles: ADMIN_GATE,
    keywords: 'volunteer hours coverage signup' },
  { href: '/admin/organizations', label: 'Organizations', room: 'office', roles: ADMIN_GATE,
    keywords: 'orgs tenants gyms affiliates' },
  { href: '/admin/board-seats', label: 'Board Seats', room: 'office', roles: ['admin', 'board'],
    keywords: 'seats appointments governance officers' },
  { href: '/admin/public-interest', label: 'Public Interest', room: 'office', roles: ADMIN_GATE,
    keywords: 'disclosure transparency public record' },
  { href: '/admin/platform', label: 'Platform', room: 'office', roles: OPEN,
    keywords: 'system settings internals' },
  { href: '/print', label: 'Print', room: 'office', roles: ['athlete', 'parent', 'coach', 'admin', 'platform_owner', 'staff'],
    keywords: 'print roster cards sheets document', hint: 'Print rosters and session cards.' },
  { href: '/names', label: 'Name Sync', room: 'office', roles: ['athlete', 'coach', 'parent', 'admin', 'platform_owner', 'staff', 'volunteer', 'board'],
    keywords: 'names sync directory roster', hint: 'Directory name synchronization.' },
  { href: '/operations', label: 'Operations Hub', room: 'office', roles: OPEN,
    keywords: 'mission control operations hub', hint: 'Cross-role operational launcher.' },
  { href: '/operations/external-competition', label: 'External Competition', room: 'office', roles: OPEN,
    keywords: 'meets tournaments away events' },
  { href: '/operations/wrestling-league', label: 'Wrestling League', room: 'office', roles: OPEN,
    keywords: 'wrestling league season' },
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
  { href: '/parent/progression-visibility', label: 'Progress Visibility', room: 'office',
    roles: ['parent'], keywords: 'child progress attendance visibility' },
  { href: '/public', label: 'Public Page', room: 'office', roles: OPEN,
    keywords: 'enrollment join intake public onboarding' },
  { href: '/help', label: 'Help', room: 'office', roles: OPEN, keywords: 'support docs how-to faq' },
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
  { href: '/coach/video-analysis', label: 'Video Analysis', room: 'floor',
    roles: ['coach', 'admin'], keywords: 'film breakdown footage' },
  { href: '/coach/video-publications', label: 'Video Publications', room: 'floor',
    roles: ['coach'], keywords: 'publish film share video' },
  { href: '/coach/environment/intake-router', label: 'Intake Router', room: 'floor',
    roles: ['coach'], keywords: 'intake routing new athlete triage' },
  { href: '/coach/environment/passbook-check', label: 'Passbook Check', room: 'floor',
    roles: ['coach'], keywords: 'usa boxing passbook insurance eligibility verification' },
  { href: '/coach/drills', label: 'Drills', room: 'floor', roles: ['coach', 'admin'],
    keywords: 'drills exercises techniques practice', hint: 'Drill library and programming.' },
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
  { href: '/coach/sports-medicine', label: 'Sports Medicine', room: 'clinic', roles: OPEN,
    keywords: 'medical injury concussion clearance return-to-training physio',
    hint: 'Medical clearance and return-to-training.' },
  { href: '/admin/compliance-center', label: 'Compliance Center', room: 'clinic', roles: ['admin'],
    keywords: 'compliance safeguarding policy certification safety' },
  { href: '/board/compliance-monitoring', label: 'Compliance Register', room: 'clinic',
    roles: ['board'], keywords: 'compliance register hand-filed monitoring governance' },

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
