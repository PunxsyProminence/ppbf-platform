/**
 * THE SELECT-ALL-THEN-FILTER FOOTGUN, PINNED.
 *
 * This is the failure this whole module exists to prevent, and it is worth
 * stating as a scenario rather than as a property: an administrator ticks
 * "select all" over thirty capabilities, then narrows the filter to three to
 * check something, then presses Delete. In the naive implementation thirty
 * records go while three are on screen — and whichever number the button was
 * showing, one of the two numbers the administrator could see was a lie.
 *
 * The rule is: a row that leaves the view leaves the selection, permanently.
 * Every test below is a different way of trying to get a hidden row back into
 * a bulk action, and every one of them must fail to.
 */

import {
  EMPTY_SELECTION,
  describeCount,
  nextSelectAll,
  pruneToVisible,
  selectAllState,
  selectAllVisible,
  toggleSelected,
} from './bulkSelection';

describe('the footgun: select all, then change the filter', () => {
  it('drops rows that leave the view, so a bulk action can never reach one', () => {
    const everything = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const selected = selectAllVisible(everything);
    expect(selected.size).toBe(10);

    // The filter narrows to three rows.
    const narrowed = pruneToVisible(selected, [2, 4, 6]);

    // The count beside the button is now three, and three is what would change.
    expect([...narrowed].sort((a, b) => a - b)).toEqual([2, 4, 6]);
    expect(narrowed.size).toBe(3);
  });

  it('does NOT resurrect the hidden ticks when the filter widens again', () => {
    // This is the case that separates a real prune from a render-time filter.
    // A render-time filter shows a truthful count while narrowed and then hands
    // the original thirty back the moment the filter widens -- the same footgun
    // wearing the fix's clothes.
    const selected = selectAllVisible([1, 2, 3, 4, 5]);
    const narrowed = pruneToVisible(selected, [3]);
    const widenedAgain = pruneToVisible(narrowed, [1, 2, 3, 4, 5]);

    expect([...widenedAgain]).toEqual([3]);
  });

  it('survives being pruned repeatedly without ever growing', () => {
    let selection = selectAllVisible([1, 2, 3, 4]);
    for (const visible of [[1, 2, 3], [1, 2], [1], [1, 2, 3, 4]]) {
      const before = selection.size;
      selection = pruneToVisible(selection, visible);
      expect(selection.size).toBeLessThanOrEqual(before);
    }
    expect([...selection]).toEqual([1]);
  });

  it('empties completely when the filter matches nothing', () => {
    const selected = selectAllVisible([7, 8, 9]);
    expect(pruneToVisible(selected, []).size).toBe(0);
  });

  it('keeps a row selected when it is still on screen after a filter change', () => {
    // The prune must not be so eager that it clears a selection every time a
    // search box is typed in -- that would make selecting anything impossible.
    const selection = toggleSelected(EMPTY_SELECTION, 42);
    expect(pruneToVisible(selection, [40, 41, 42, 43]).has(42)).toBe(true);
  });
});

describe('the identity guarantee that lets the prune run unconditionally', () => {
  it('returns the SAME set when nothing was dropped', () => {
    // The call site prunes inside an effect on every filter or keystroke
    // change. Returning a fresh Set every time would store a new value into
    // React state on every keystroke and re-render the whole table for nothing.
    const selection = selectAllVisible([1, 2, 3]);
    expect(pruneToVisible(selection, [1, 2, 3])).toBe(selection);
    expect(pruneToVisible(selection, [1, 2, 3, 4, 5])).toBe(selection);
  });

  it('returns the same empty set rather than allocating one', () => {
    expect(pruneToVisible(EMPTY_SELECTION, [1, 2])).toBe(EMPTY_SELECTION);
  });

  it('returns a NEW set when something was dropped', () => {
    const selection = selectAllVisible([1, 2, 3]);
    expect(pruneToVisible(selection, [1, 2])).not.toBe(selection);
  });
});

describe('select all is scoped to what is on screen', () => {
  it('replaces the selection rather than adding to it', () => {
    // Union with off-screen rows is how the footgun gets in through the back
    // door: the box says "all" and the count includes things "all" was never
    // about.
    const stale = selectAllVisible([90, 91, 92]);
    expect([...selectAllVisible([1, 2])]).toEqual([1, 2]);
    expect(selectAllVisible([1, 2]).has(90)).toBe(false);
    expect(stale.has(90)).toBe(true); // the input is not mutated
  });
});

describe('the three states of the header control', () => {
  it('reports none, some and all', () => {
    const visible = [1, 2, 3];
    expect(selectAllState(EMPTY_SELECTION, visible)).toBe('none');
    expect(selectAllState(new Set([2]), visible)).toBe('some');
    expect(selectAllState(new Set([1, 2, 3]), visible)).toBe('all');
  });

  it('reports none for an empty list, so the box is never ticked over nothing', () => {
    expect(selectAllState(new Set([1, 2]), [])).toBe('none');
  });

  it('counts only visible rows, so an off-screen tick cannot report "all"', () => {
    // Belt and braces: even if a stale id survived somehow, it must not make
    // the header claim everything is selected.
    expect(selectAllState(new Set([1, 2, 99]), [1, 2])).toBe('all');
    expect(selectAllState(new Set([99]), [1, 2])).toBe('none');
  });
});

describe('what the header control does when clicked', () => {
  it('goes from none to all', () => {
    expect([...nextSelectAll(EMPTY_SELECTION, [1, 2, 3])]).toEqual([1, 2, 3]);
  });

  it('goes from partial to all, not to none', () => {
    // Somebody who has ticked two rows and then reaches for the header control
    // is reaching for "and the rest"; there is an explicit clear for the other
    // intent.
    expect([...nextSelectAll(new Set([2]), [1, 2, 3])]).toEqual([1, 2, 3]);
  });

  it('goes from all to none', () => {
    expect(nextSelectAll(new Set([1, 2, 3]), [1, 2, 3]).size).toBe(0);
  });
});

describe('toggling one row', () => {
  it('adds then removes', () => {
    const once = toggleSelected(EMPTY_SELECTION, 5);
    expect(once.has(5)).toBe(true);
    expect(toggleSelected(once, 5).has(5)).toBe(false);
  });

  it('never mutates what it was given', () => {
    const original = new Set([1]);
    toggleSelected(original, 2);
    expect([...original]).toEqual([1]);
  });
});

describe('the count, said the same way everywhere', () => {
  it('agrees with itself, because three places print it', () => {
    // A confirmation that says "3" beside a toolbar that says "4" is worse
    // than no confirmation at all.
    expect(describeCount(1)).toBe('1 capability');
    expect(describeCount(2)).toBe('2 capabilities');
    expect(describeCount(0)).toBe('0 capabilities');
  });
});
