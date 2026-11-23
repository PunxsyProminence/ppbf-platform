/**
 * The longest note an athlete may add to a pain report, in characters (DR-25; Jason 2026-11-23,
 * DR-25 A). One number for the athlete's box (AthleteWorkspace.tsx), the server's check
 * (painReportNotes.ts normalizePainNote) and the database's
 * (pilot_shadow_near_misses_athlete_note_check), so the three cannot drift apart.
 */
export const PAIN_NOTE_MAX = 500;
