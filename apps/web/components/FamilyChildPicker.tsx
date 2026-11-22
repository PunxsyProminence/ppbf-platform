'use client';

import { useId, type ReactNode } from 'react';
import { readChosenChild, rememberChosenChild } from '@/src/lib/chosenChild';

/*
 * ONE CHILD PICKER FOR THE FAMILY PAGES (app scrub FAM-11; lane AS-9, AS9-2).
 *
 * The film, progress, plan and mental skills pages each had their own picker:
 * buttons on two, a select on two, and the plan and mental skills pages made a
 * one-child family pick their only child before anything showed. This is the
 * one picker they share.
 *
 * - It opens on the child chosen last (src/lib/chosenChild.ts) when that child
 *   is one of this guardian's, else on the only child. With two or more and
 *   none remembered, nothing is chosen and it asks "Choose a child": picking
 *   one for the family would be inventing an answer.
 * - With one child there is nothing to choose, so it shows nothing.
 * - A pick is remembered, so the next family page opens on the same child.
 *   Tapping the child already chosen does nothing: no second read.
 *
 * It only says which of the guardian's own children they meant. The list comes
 * from /api/pilot/athletes/list, which returns only linked children, and every
 * read the page then makes names the child and is checked again on the server.
 */

export interface FamilyChild {
  readonly athlete_id: string;
  readonly full_name?: string | null;
}

/** The child a family page opens on: the remembered one when it is in this
 *  list, else the only child, else none. */
export function openingChild(linked: ReadonlyArray<FamilyChild>): string | null {
  const chosen = readChosenChild();
  if (chosen && linked.some((child) => child.athlete_id === chosen)) return chosen;
  return linked.length === 1 ? linked[0].athlete_id : null;
}

/** Whether a name is on file for this child ("Unknown" is the hub's word for
 *  none). */
export function familyChildHasName(child: FamilyChild): boolean {
  const name = (child.full_name ?? '').trim();
  return name !== '' && name !== 'Unknown';
}

function baseName(child: FamilyChild): string {
  return familyChildHasName(child) ? (child.full_name ?? '').trim() : 'Your child';
}

/** The name a family page shows for a child: the name on file, or "Your
 *  child" when there is none. Two of a family's children who would read the
 *  same are told apart by the end of their id, as the mental skills picker
 *  already did. */
export function familyChildLabel(child: FamilyChild, linked: ReadonlyArray<FamilyChild>): string {
  const base = baseName(child);
  const same = linked.filter((other) => baseName(other) === base).length;
  return same > 1 ? `${base} (${child.athlete_id.slice(-4)})` : base;
}

export default function FamilyChildPicker({
  linked,
  activeId,
  onChoose,
  label = 'Which child',
  className,
  lead,
}: {
  readonly linked: ReadonlyArray<FamilyChild>;
  readonly activeId: string | null;
  readonly onChoose: (athleteId: string) => void;
  readonly label?: string;
  readonly className?: string;
  /** Drawn before each child's name inside its button (the Parent Hub's
   *  small portrait, AS9-3). It must be decorative: the button's name is the
   *  child's label and nothing else. */
  readonly lead?: (child: FamilyChild) => ReactNode;
}) {
  const labelId = useId();
  const askId = useId();
  if (linked.length < 2) return null;
  const chosen = linked.some((child) => child.athlete_id === activeId);
  return (
    <div role="group" aria-labelledby={labelId} aria-describedby={chosen ? undefined : askId} className={className}>
      <p id={labelId} className="t-label">{label}</p>
      {chosen ? null : <p id={askId} className="t-body mt-[var(--s2)]">Choose a child</p>}
      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
        {linked.map((child) => (
          <button
            key={child.athlete_id}
            type="button"
            className={`${child.athlete_id === activeId ? 'btn' : 'btn btn--ghost'}${lead ? ' gap-[var(--s3)]' : ''}`}
            aria-pressed={child.athlete_id === activeId}
            onClick={() => {
              if (child.athlete_id === activeId) return;
              rememberChosenChild(child.athlete_id);
              onChoose(child.athlete_id);
            }}
          >
            {lead ? lead(child) : null}
            {familyChildLabel(child, linked)}
          </button>
        ))}
      </div>
    </div>
  );
}
