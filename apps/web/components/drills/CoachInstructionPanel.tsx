'use client';

import DrillDetail from './DrillDetail';
import type { OpenedInstruction } from './drillInstructionRead';

/*
 * A drill's instruction, opened from where a coach issues or reviews work
 * (W-D4B): the Coach Cards form and list, and the progression assign form and
 * list. The same DrillDetail /coach/drills renders, so a coach reads one drill
 * structure wherever they meet it.
 *
 * It says why when there is nothing to show, because "no instructions" and
 * "the instructions did not load" call for different actions. Plain text, not
 * an alert: none of these is a failed write, and the pages' red channels are
 * reserved for those (safeguardingRedReservation.test.ts). The outcome sits in
 * one polite live region, so a screen-reader user hears what the toggle
 * produced as well as seeing it.
 *
 * No control of its own: the opener on the page is also the closer.
 */
export default function CoachInstructionPanel({
  loading,
  failed,
  opened,
}: {
  loading: boolean;
  failed: boolean;
  opened: OpenedInstruction | null;
}) {
  return (
    <div className="mt-[var(--s3)] space-y-[var(--s3)]">
      <div role="status" aria-live="polite" className="space-y-[var(--s2)]">
        {loading && <p className="t-body text-[color:var(--bone-300)]">Loading the drill…</p>}
        {failed && (
          <p className="t-body text-[color:var(--restricted-ink)]">
            The drill&apos;s instructions did not load. This is a failure to load, not a missing drill; try again in a
            minute.
          </p>
        )}
        {opened?.state === 'gym_written' && (
          <p className="t-body text-[color:var(--bone-300)]">
            This drill was written by this gym, so there are no reference instructions to open. The athlete reads the
            gym&apos;s own wording.
          </p>
        )}
        {opened?.state === 'no_drill' && (
          <p className="t-body text-[color:var(--bone-300)]">
            This work was issued before drills were linked to assignments, so no drill is linked to it.
          </p>
        )}
        {opened?.state === 'unavailable' && (
          <p className="t-body text-[color:var(--bone-300)]">
            This drill&apos;s reference instructions are not in this gym&apos;s library.
          </p>
        )}
        {opened?.view && <span className="sr-only">{`${opened.view.name}: instructions open below.`}</span>}
      </div>
      {opened?.view && (
        <DrillDetail view={opened.view} audience="coach" focusOnMount actions={lifecycleNotes(opened)} />
      )}
    </div>
  );
}

/*
 * Where the work's drill stands now, in the drill's own header -- straight
 * after the heading focus lands on, beside the content status it qualifies, so
 * reading forward from the heading reaches it before the instruction.
 *
 * "Changed" and "retired" are different facts: adopting a refinement
 * deactivates the version it replaces, so an inactive version alone does not
 * mean the gym stopped running the drill. Nothing is said while it is current.
 */
function lifecycleNotes(opened: OpenedInstruction) {
  const notes: { key: string; text: string; tone: 'plain' | 'restricted' }[] = [];
  if (opened.operationalLifecycle === 'changed') {
    notes.push({
      key: 'changed',
      text: 'This gym has changed this drill since the work was issued, and another version of it is in use now. These are the reference instructions this work was issued against.',
      tone: 'plain',
    });
  }
  if (opened.operationalLifecycle === 'retired') {
    notes.push({
      key: 'retired',
      text: 'This gym has retired this drill since the work was issued. These are the reference instructions it was issued against.',
      tone: 'restricted',
    });
  }
  if (opened.athleteCanOpen === false) {
    notes.push({
      key: 'athlete',
      text: "Athletes cannot open these instructions from this work, because this gym no longer offers them to athletes.",
      tone: 'restricted',
    });
  }
  if (notes.length === 0) return undefined;
  return (
    <div className="basis-full space-y-[var(--s2)]">
      {notes.map((note) => (
        <p
          key={note.key}
          className={`t-body ${note.tone === 'restricted' ? 'text-[color:var(--restricted-ink)]' : 'text-[color:var(--bone-300)]'}`}
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}
