import { AUDIT_ATHLETE_OWNED_ENTITY_TYPES } from './auditEntityOwners';

// Who may read which audit rows. Two readers serve them: audit/get, which
// reads pilot.audit_events, and the SHADOW event feed (listShadowEvents),
// which reads the copy writePilotAuditEvent mirrors into pilot.shadow_events.
// Both apply the lists below, so neither can become the way around the other.
//
// A coach's view of the org-wide audit trace is an ALLOW-list, not a
// deny-list. audit/get shipped excluding exactly one type (training_hold),
// and the 2026-08-25 audit found the rot that shape guarantees: by then
// parent_barrier_report, guardian_media_consent, guardian_link,
// athlete_check_in, intake_case and intake_document had all joined the
// vocabulary, and any coach could enumerate them org-wide for children they
// never coach. A deny-list must be re-curated every time a writer adds a
// type; this list fails CLOSED instead -- a new entity type is invisible to
// coaches until someone deliberately adds it here, under review.
//
// What belongs here: training-floor operational records. What never does:
// guardian/consent, intake, medical, account/credential, payment, platform,
// board, or safety-scoped types -- each of those has a dedicated route whose
// own gate decides what a coach may see of it (training-holds/route.ts is
// the model), and no general-purpose reader may become the back door around
// any of them.
export const COACH_ALLOWED_AUDIT_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'announcement',
  'athlete_milestone',
  'athlete_program',
  'behavior_standard',
  'coach_coverage',
  'coach_note',
  'coach_review',
  'drill',
  'external_competition_entry',
  'floor_plan',
  'goal',
  'intervention_evidence_link',
  'intervention_execution',
  'intervention_outcome_review',
  'intervention_protocol',
  'mentorship',
  'one_percent_nomination',
  'program_phase',
  'rabbit_hole',
  'recognition',
  'scheduler_coaching_request',
  'session',
  'video_session',
  'wrestling_league_roster_entry',
]);

// WHICH MIRRORED AUDIT ROWS AN ATHLETE OR A PARENT MAY READ IN THE SHADOW FEED
// (#1558 item two). Until this list existed they read every mirror tied to
// their athlete, whatever its type, and audit/get itself refuses both roles.
// That is how a parent's barrier report and a parent's observation reached the
// child's feed and the other guardian's as SHADOW_AUDIT_CREATE_PARENT_BARRIER_REPORT,
// and the rows for a guardian's login and links reached the other household.
//
// An ALLOW-list for the reason the coach's is one: a new entity type is
// invisible to families until someone adds it here, under review. Whatever it
// holds, it never holds a type authored by or about a guardian, an account or
// staff conduct (shadowReadModels.test.ts pins that).
//
// THE VALUE IS AN OWNER DECISION (Q-1 on #1558). Empty means an athlete or a
// parent reads no SHADOW_AUDIT_* row at all, the answer every other non-staff
// role already gets. The one alternative put to the owner is the child's own
// training records: 'goal', 'session', 'athlete_milestone', 'recognition'.
export const FAMILY_ALLOWED_AUDIT_ENTITY_TYPES: ReadonlySet<string> = new Set<string>([]);

// Allow-listed types whose every record is ABOUT an athlete, even when an
// audit row for it names none; the key set of auditEntityOwners.ts's
// resolver table. A coach's row of one of these types that cannot be tied to
// an athlete is hidden from coaches: it fails CLOSED.
export const ATHLETE_OWNED_AUDIT_ENTITY_TYPES: ReadonlySet<string> = AUDIT_ATHLETE_OWNED_ENTITY_TYPES;

// Calibration audit rows are served to NOBODY by a general reader,
// organization admins included. Calibration labelling is blinded -- two
// annotators, or one annotator's two passes, must not see each other's work
// -- and its audit rows say what was marked and when: an event's class and
// time span, which moment of it holds body marks, how many events a set was
// submitted with. An organization admin
// may also be an annotator, so "admins see everything" made the general
// readers a way around the blinding. The calibration routes are the only
// surfaces that decide who may read that work.
export const WITHHELD_AUDIT_ENTITY_TYPE_PREFIX = 'calibration_';
