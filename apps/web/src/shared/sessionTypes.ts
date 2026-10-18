// What kind of session an athlete says it was, tagged at check-out beside the
// effort answer (Jason 2026-10-18, "Session effort (Rec.)" with a session-type
// tag). Effort x minutes means different things on a sparring night and a
// technique night, so a personal baseline of session load is read per tag
// (research draft BASELINE-METRICS-2026-10-18, section 3.1).
//
// SHARED so the server validates against the same list the athlete picks from,
// and matched to pilot_sessions_session_type_check in
// pilot_slice_postgres_athlete_self_report_measures_migration.sql. Optional:
// null is "not said", and nothing infers a tag for a session that has none.
// Labels are PROPOSED copy.

export const SESSION_TYPES = [
  { key: 'technique', label: 'Technique' },
  { key: 'bag_pads', label: 'Bag or pads' },
  { key: 'conditioning', label: 'Conditioning' },
  { key: 'sparring', label: 'Sparring' },
  { key: 'mixed', label: 'Mixed' },
  { key: 'other', label: 'Other' },
] as const;

export type SessionType = (typeof SESSION_TYPES)[number]['key'];

export const SESSION_TYPE_KEYS: readonly SessionType[] = SESSION_TYPES.map((type) => type.key);

export const SESSION_TYPE_QUESTION = 'What kind of session was it?';

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === 'string' && (SESSION_TYPE_KEYS as readonly string[]).includes(value);
}
