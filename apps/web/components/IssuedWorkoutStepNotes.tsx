import { humanizeContactLevel, scaleLevelName } from '@/src/lib/drillPresentation';

/** The three things a template says beside one step of an issued workout. */
export interface IssuedWorkoutStepLines {
  // Null when the coach left the level to be picked on the day.
  scale_level: string | null;
  // The coach's entry.
  contact_level: string;
  coach_note: string | null;
}

/**
 * What the template says beside one step of a workout, as written, each line
 * labelled so it is not taken for the drill's own level in the instruction
 * near it. One component for the athlete's screen and the coach's, so both
 * read the same lines.
 *
 * A scale level the coach left open is not shown; nothing is filled in, and
 * nothing is said about the contact level beyond the level itself. The note is
 * labelled "Note", not "Coach note": a template's note is whatever its author
 * wrote, and on a seeded template that is not this gym's coach.
 *
 * The body voice (.t-body) sets the size: the gym-floor size on a kiosk
 * surface such as the athlete's screens, the desk size on the coach's list.
 */
export default function IssuedWorkoutStepNotes({ step }: { readonly step: IssuedWorkoutStepLines }) {
  return (
    <div
      data-testid="step-notes"
      className="t-body mt-[var(--s3)] space-y-[var(--s2)] break-words"
    >
      {step.scale_level && <p>Scale: {scaleLevelName(step.scale_level)}</p>}
      <p>Contact: {humanizeContactLevel(step.contact_level)}</p>
      {(step.coach_note ?? '').trim() !== '' && (
        <p className="whitespace-pre-line">
          <span className="font-semibold">Note:</span> {step.coach_note}
        </p>
      )}
    </div>
  );
}
