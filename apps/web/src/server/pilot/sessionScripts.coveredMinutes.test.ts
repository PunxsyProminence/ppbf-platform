import { coveredMinutes } from './sessionScripts';

// coveredMinutes is the only derived figure in sessionScripts.ts; everything
// else is a straight read. It exists so a coach can see the gap between what a
// script CLAIMS to last (total_minutes, authored) and what its blocks actually
// account for.

function block(start: number, end: number) {
  return { start_offset_min: start, end_offset_min: end };
}

describe('coveredMinutes', () => {
  it('is zero for a script with no blocks', () => {
    expect(coveredMinutes([])).toBe(0);
  });

  it('measures a single block as its own span', () => {
    expect(coveredMinutes([block(0, 15)])).toBe(15);
  });

  it('sums blocks that run back to back', () => {
    expect(coveredMinutes([block(0, 10), block(10, 25), block(25, 30)])).toBe(30);
  });

  it('does not invent minutes for a gap between blocks', () => {
    // 0-10 and 20-30 cover 20 minutes; the 10-minute gap is unplanned time and
    // must NOT be counted, because the gap is the signal worth seeing.
    expect(coveredMinutes([block(0, 10), block(20, 30)])).toBe(20);
  });

  it('counts overlapping blocks once', () => {
    // A conditioning block running underneath a teaching minute is one clock,
    // not two. Summing durations would report 25 minutes for a 15-minute span.
    expect(coveredMinutes([block(0, 15), block(5, 15)])).toBe(15);
  });

  it('counts a block fully contained in another only once', () => {
    expect(coveredMinutes([block(0, 40), block(10, 20)])).toBe(40);
  });

  it('merges a chain of partial overlaps into one span', () => {
    expect(coveredMinutes([block(0, 10), block(5, 20), block(15, 30)])).toBe(30);
  });

  it('does not depend on the order blocks are passed in', () => {
    const ordered = [block(0, 10), block(20, 30), block(40, 55)];
    const shuffled = [block(40, 55), block(0, 10), block(20, 30)];
    expect(coveredMinutes(shuffled)).toBe(coveredMinutes(ordered));
  });

  it('does not mutate the caller array while sorting', () => {
    const blocks = [block(40, 55), block(0, 10)];
    coveredMinutes(blocks);
    expect(blocks[0]).toEqual(block(40, 55));
  });

  it('treats blocks that merely touch as continuous, not overlapping', () => {
    // end 10 and start 10 is a handover at the same minute, not a double count.
    expect(coveredMinutes([block(0, 10), block(10, 20)])).toBe(20);
  });

  it('handles a script that does not start at offset zero', () => {
    // A script whose first block starts at minute 5 covers 25 minutes, not 30 --
    // the arrival gap before it is not planned time.
    expect(coveredMinutes([block(5, 30)])).toBe(25);
  });
});
