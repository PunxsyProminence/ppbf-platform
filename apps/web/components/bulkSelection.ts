/**
 * BULK SELECTION — the rule, apart from the table that draws it.
 *
 * Nothing in this platform could act on more than one row at a time. An
 * administrator clearing thirty capabilities cleared them one at a time,
 * thirty confirmations deep, and the only way to be sure they had finished was
 * to count. That is the tax this file exists to remove.
 *
 * ---------------------------------------------------------------------------
 * THE FOOTGUN, AND THE DELIBERATE ANSWER
 * ---------------------------------------------------------------------------
 * Every multi-select table has to answer one question, and most of them answer
 * it by accident: what happens to a selection when the FILTER changes?
 *
 *   (a) The selection persists. Tick "select all" over 30 rows, narrow the
 *       filter to 3, press Delete — and 30 rows go, 27 of which you could not
 *       see. The button said "Delete 30" or it said "Delete 3"; either way one
 *       of the two numbers on screen was a lie.
 *
 *   (b) The selection is CLAMPED to what is on screen. Narrowing the filter
 *       drops the rows that left with it. You can lose work — narrow, widen,
 *       and the ticks are gone — but you can never act on a row you cannot
 *       see, and the count beside the button is the count that will change.
 *
 * THIS FILE IMPLEMENTS (b), and does it by PRUNING the stored set rather than
 * by filtering at render time. That distinction is the whole point: a
 * render-time filter shows a truthful count while the filter is narrow and
 * then RESURRECTS the hidden ticks the moment the filter widens again, which
 * is (a) wearing (b)'s clothes and is worse than either. Once a row leaves the
 * view it is out of the selection for good, and coming back does not re-tick
 * it.
 *
 * The cost is real and is the right cost to pay: on this screen the operation
 * is irreversible past the session, the rows are capability records rather
 * than mail, and "I did not know those were still ticked" is not a sentence
 * anybody should be able to say afterwards.
 *
 * Pure and id-typed so the rule can be tested without a DOM, a table, or a
 * render — the behaviour above is the thing worth pinning, not the checkbox.
 */

/** The selection itself. A Set, because every operation here is a membership test. */
export type Selection = ReadonlySet<number>;

export const EMPTY_SELECTION: Selection = new Set<number>();

/** Tick or untick one row. */
export function toggleSelected(selection: Selection, id: number): Selection {
  const next = new Set(selection);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

/**
 * Select-all, scoped to what is on screen RIGHT NOW.
 *
 * It deliberately replaces the selection rather than adding to it. "Select
 * all" that unions with rows scrolled out of the current filter is how (a)
 * gets in through the back door: the box reads "all", and the number beside it
 * counts things the word "all" was never about.
 */
export function selectAllVisible(visibleIds: readonly number[]): Selection {
  return new Set(visibleIds);
}

/**
 * The prune. Call this whenever the visible set changes for any reason — a
 * filter, a search keystroke, a row that was deleted by something else.
 *
 * Returns the SAME Set object when nothing was dropped, so a React state
 * setter can be called unconditionally without cascading a render on every
 * keystroke. That identity guarantee is load-bearing at the call site and is
 * pinned by a test.
 */
export function pruneToVisible(selection: Selection, visibleIds: readonly number[]): Selection {
  if (selection.size === 0) {
    return selection;
  }

  const visible = new Set(visibleIds);
  let dropped = false;
  const next = new Set<number>();
  for (const id of selection) {
    if (visible.has(id)) {
      next.add(id);
    } else {
      dropped = true;
    }
  }

  return dropped ? next : selection;
}

/**
 * Which of three states the header checkbox is in.
 *
 * 'none' and 'all' are obvious; 'some' drives the indeterminate flag, which is
 * the only honest rendering of a partial selection — an unchecked box beside
 * "4 selected" reads as a bug, and a checked one is a lie.
 */
export type SelectAllState = 'none' | 'some' | 'all';

export function selectAllState(selection: Selection, visibleIds: readonly number[]): SelectAllState {
  if (visibleIds.length === 0 || selection.size === 0) {
    return 'none';
  }
  const chosen = visibleIds.filter((id) => selection.has(id)).length;
  if (chosen === 0) return 'none';
  return chosen === visibleIds.length ? 'all' : 'some';
}

/**
 * What the header control does when clicked, given where it is now.
 *
 * Partial goes to ALL rather than to none. Somebody who has ticked four rows
 * and then reaches for the header control is almost always reaching for "and
 * the rest of them"; the ones who want to start again have the explicit clear.
 */
export function nextSelectAll(
  selection: Selection,
  visibleIds: readonly number[],
): Selection {
  return selectAllState(selection, visibleIds) === 'all'
    ? EMPTY_SELECTION
    : selectAllVisible(visibleIds);
}

/**
 * The count, in words, for a button and for a confirmation.
 *
 * Written once here because the number has to be identical in three places —
 * the toolbar, the confirm, and the undo offer — and three template literals
 * drift. A confirmation that says "3" beside a toolbar that says "4" is worse
 * than no confirmation at all.
 */
export function describeCount(count: number, singular = 'capability', plural = 'capabilities'): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
