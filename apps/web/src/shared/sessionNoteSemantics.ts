// Which stored session notes are the athlete's words, and which are the
// system's.
//
// pilot.sessions.notes requires a non-empty string, so check-in has always
// written SOMETHING even when the athlete typed nothing -- two different
// somethings, across two eras. Neither is a sentence a child wrote, and every
// surface that shows session-note text has to be able to tell the difference
// before it puts the text in front of someone as though they had.
//
// SHARED, NOT COPIED. These three lived inside AthleteWorkspace.tsx and were
// never exported, which was sufficient while the athlete's own screen was the
// only reader. A-FIN-08 adds two more -- a coach-facing read
// (src/server/pilot/sessionNotes.ts) and the passbook projection
// (src/server/pilot/passbook.ts) -- and a recognizer re-implemented per
// surface is one that drifts: the day a fourth system note is written, the
// screens that know about it and the screens that do not begin disagreeing
// about whether a child said anything. One definition, three readers.
//
// STORED ROWS ARE NOT TOUCHED. No migration, no historical rewrite, no
// cleanup. These strings stay in the database exactly as they were written.
// This module governs only how they are READ.

/**
 * The note stored when the athlete wrote nothing before checking in (A-FIN-01).
 *
 * pilot.sessions requires a non-empty note, so something has to be written --
 * and this is that something, solely to satisfy the contract. It is ONE fixed
 * sentence on purpose: it says nothing about the athlete, is built from no
 * input (no wellness answer, no effort, no inferred feeling, no coach text),
 * and is recognised on the way back so it never lands in the athlete's own
 * notes box or reads in their history as a sentence they wrote.
 */
export const NO_ATHLETE_NOTE_PLACEHOLDER = 'No athlete note provided at check-in.';

/**
 * The note check-in stored in the same situation BEFORE A-FIN-01: "Auto
 * check-in readiness GREEN", the band of a 1-10 slider that started at 8 -- so
 * an athlete who touched nothing had "GREEN" written on their session as if
 * they had said it. Nothing writes this form any more. Rows that already carry
 * it are deliberately not rewritten (no migration, no cleanup), so it is still
 * recognised here: read, never written.
 */
export const AUTO_CHECK_IN_NOTE_PATTERN = /^Auto check-in readiness (GREEN|YELLOW|RED)$/;

/**
 * Whether a stored session note is the system's, not the athlete's: today's
 * placeholder or the historical readiness marker. Either one is "no note" to
 * every surface that shows a human being somebody's words -- the athlete their
 * own, or a coach an athlete's.
 *
 * Takes a plain string rather than `string | null`: a null note is already
 * "no note" at every call site, and keeping the null check visible there
 * stops this function from quietly absorbing two different questions.
 */
export function isSystemCheckInNote(notes: string): boolean {
  return notes === NO_ATHLETE_NOTE_PLACEHOLDER || AUTO_CHECK_IN_NOTE_PATTERN.test(notes);
}
