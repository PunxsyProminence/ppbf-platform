/**
 * @jest-environment jsdom
 */

/**
 * THE CLOCK IS FENCED, AND THIS IS THE FENCE.
 *
 * milestoneCeremony.ts cannot read a date, on purpose: a file that can read a
 * clock can subtract two of them, and a file that can subtract two clocks can
 * notice that a child has not been in for three weeks. This platform runs a
 * safety gate that locks athletes out for medical reasons, so "you have not
 * been in" is a sentence that must be unwritable rather than merely unwritten.
 *
 * gymNotices.ts is the one file allowed a clock, which makes it the file that
 * has to prove it never grew the ability. Every test below is an attempt to
 * get an absence, a gap, a cadence or an expiry out of it.
 */

import {
  CATALOG_NOD_AT,
  CATALOG_OPENS_KEY,
  anniversaryMark,
  beforeDawnNote,
  catalogNod,
  recordCatalogOpen,
} from './gymNotices';

/** A local Date, so the tests read the same clock the code does. */
function at(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m - 1, d, h);
}

describe('before dawn', () => {
  it('says one dry line to somebody here before six', () => {
    expect(beforeDawnNote(at(2026, 3, 4, 4))).toBe('Before six. Somebody always is.');
    expect(beforeDawnNote(at(2026, 3, 4, 5))).toBeTruthy();
  });

  it('says nothing at any ordinary hour', () => {
    for (const hour of [0, 1, 2, 3, 6, 7, 9, 12, 17, 21, 23]) {
      expect(beforeDawnNote(at(2026, 3, 4, hour))).toBeNull();
    }
  });

  it('is not a night message, so the 11pm shift worker is not addressed', () => {
    expect(beforeDawnNote(at(2026, 3, 4, 23))).toBeNull();
  });

  it('says nothing about how often it has been true', () => {
    // It takes one Date and nothing else. There is no second call it can
    // compare itself to, and no history it could be handed.
    expect(beforeDawnNote.length).toBe(1);
    const line = beforeDawnNote(at(2026, 3, 4, 5));
    expect(line).toBe(beforeDawnNote(at(2030, 12, 25, 5)));
  });
});

describe('a year at the gym', () => {
  it('marks the first anniversary', () => {
    const mark = anniversaryMark('2025-03-04', at(2026, 3, 4));
    expect(mark).not.toBeNull();
    expect(mark?.years).toBe(1);
    expect(mark?.line).toBe('A year, this week. Same gym, same door.');
  });

  it('counts later years', () => {
    expect(anniversaryMark('2020-06-01', at(2026, 6, 1))?.years).toBe(6);
    expect(anniversaryMark('2020-06-01', at(2026, 6, 1))?.line).toContain('6 years');
  });

  it('stays up for the week, so a twice-a-week athlete does not miss their own', () => {
    for (const day of [4, 5, 6, 7, 8, 9, 10]) {
      expect(anniversaryMark('2025-03-04', at(2026, 3, day))).not.toBeNull();
    }
  });

  it('is gone a week later, and is not there the day before', () => {
    expect(anniversaryMark('2025-03-04', at(2026, 3, 11))).toBeNull();
    expect(anniversaryMark('2025-03-04', at(2026, 3, 3))).toBeNull();
  });

  it('says nothing during somebody first year', () => {
    expect(anniversaryMark('2025-03-04', at(2025, 9, 4))).toBeNull();
    expect(anniversaryMark('2025-03-04', at(2026, 3, 3))).toBeNull();
  });

  it('reads a written-down calendar day as that day, not as UTC midnight', () => {
    // `new Date('2025-03-04')` is UTC by specification, which west of
    // Greenwich -- this gym included -- is the 3rd. A naive parse moves every
    // athlete's anniversary a day earlier for most of the United States.
    expect(anniversaryMark('2025-03-04', at(2026, 3, 4))).not.toBeNull();
    // And it accepts the front of a full ISO timestamp, which is what the API
    // hands back for a `date` column.
    expect(anniversaryMark('2025-03-04T00:00:00.000Z', at(2026, 3, 4))?.years).toBe(1);
  });

  it('handles the leap-day case by calendar rather than by dividing days', () => {
    // 365 is the wrong constant one year in four, and an anniversary that
    // lands a day late every fourth year is the kind of thing nobody reports.
    expect(anniversaryMark('2024-02-29', at(2025, 3, 1))?.years).toBe(1);
    expect(anniversaryMark('2023-05-10', at(2024, 5, 10))?.years).toBe(1);
  });

  it('refuses a bad row rather than inventing a mark', () => {
    expect(anniversaryMark('', at(2026, 3, 4))).toBeNull();
    expect(anniversaryMark('not a date', at(2026, 3, 4))).toBeNull();
    expect(anniversaryMark('2030-01-01', at(2026, 3, 4))).toBeNull(); // start in the future
  });

  /* ------------------------------------------------------------------------
     THE FENCE ITSELF
  ------------------------------------------------------------------------ */

  it('cannot tell a regular from somebody who came twice, and says the same to both', () => {
    // It is handed the START of a record and today. It never sees what
    // happened in between, so there is no arrangement of its arguments that
    // reconstructs attendance. The mark is for STAYING, not for attending --
    // which is the point, and is the thing a gym should notice about a child
    // who had a hard year.
    const regular = anniversaryMark('2025-03-04', at(2026, 3, 4));
    const twice = anniversaryMark('2025-03-04', at(2026, 3, 4));
    expect(regular).toEqual(twice);
    expect(anniversaryMark.length).toBe(2);
  });

  it('never produces a worse answer for a longer gap, because it cannot see one', () => {
    // Every output is additive: a mark or null. There is no branch anywhere
    // that punishes, expires, or takes something back.
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const mark = anniversaryMark('2025-03-04', at(year, 3, 4));
      expect(mark === null || mark.years > 0).toBe(true);
    }
  });

  it('says nothing about anybody else — it is theirs, not a leaderboard', () => {
    const mark = anniversaryMark('2025-03-04', at(2026, 3, 4));
    expect(mark?.line.toLowerCase()).not.toMatch(/rank|top|than|most|leader|percent|%|others|compared/);
  });
});

describe('every line stays dry', () => {
  it('has no exclamation mark and no confetti anywhere', () => {
    const lines = [
      beforeDawnNote(at(2026, 3, 4, 5)),
      anniversaryMark('2025-03-04', at(2026, 3, 4))?.line ?? '',
      catalogNod(CATALOG_NOD_AT) ?? '',
    ];
    for (const line of lines) {
      expect(line).toBeTruthy();
      expect(line).not.toContain('!');
      expect((line ?? '').toLowerCase()).not.toMatch(/congratulat|amazing|awesome|well done|keep it up|streak/);
    }
  });
});

describe('the nod for somebody who found the drawer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('lands once, on the fifth open, and never again', () => {
    expect(catalogNod(1)).toBeNull();
    expect(catalogNod(4)).toBeNull();
    expect(catalogNod(CATALOG_NOD_AT)).toBe('Fifth time. You know where the drawer is now.');
    expect(catalogNod(6)).toBeNull();
    expect(catalogNod(500)).toBeNull();
  });

  it('counts opens and only ever goes up', () => {
    expect(recordCatalogOpen()).toBe(1);
    expect(recordCatalogOpen()).toBe(2);
    expect(recordCatalogOpen()).toBe(3);
    expect(window.localStorage.getItem(CATALOG_OPENS_KEY)).toBe('3');
  });

  it('is a count, not a cadence — five in a minute and five in a year are identical', () => {
    // Same property the training card's count has, for the same reason.
    expect(catalogNod(5)).toBe(catalogNod(5));
  });

  it('treats a corrupt or missing counter as the first time rather than throwing', () => {
    window.localStorage.setItem(CATALOG_OPENS_KEY, 'not a number');
    expect(recordCatalogOpen()).toBe(1);
    window.localStorage.setItem(CATALOG_OPENS_KEY, '-4');
    expect(recordCatalogOpen()).toBe(1);
  });

  it('degrades to silence when storage throws, rather than taking the palette down', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(() => recordCatalogOpen()).not.toThrow();
    expect(recordCatalogOpen()).toBe(1);
    getItem.mockRestore();
  });
});
