import {
  ADULT_PATHWAY_CAVEAT,
  ADULT_PATHWAY_STAGES,
  ADULT_PATHWAY_STAGE_KEYS,
  adultPathwayStage,
  isAdultPathwayStageKey,
} from './adultPathwayStages';

describe('adult pathway stages', () => {
  it('holds the four owner-approved stages in order', () => {
    expect(ADULT_PATHWAY_STAGES.map((s) => s.name)).toEqual(['Foundation', 'Intermediate', 'Advanced', 'Elite']);
    expect(ADULT_PATHWAY_STAGES.map((s) => s.key)).toEqual([...ADULT_PATHWAY_STAGE_KEYS]);
  });

  it('carries the owner-approved caveat word for word', () => {
    expect(ADULT_PATHWAY_CAVEAT).toBe(
      'These time ranges are rough estimates, not research-backed. Everyone moves at their own pace; '
        + 'a coach decides when a stage is reached.',
    );
  });

  // Pinned as literals: the ranges come from the synthesis ([AI-H]) and the
  // goals are owner-approved wording, so a drift in either is a regression.
  it('gives every stage its range in words, never a single figure', () => {
    expect(ADULT_PATHWAY_STAGES.map((s) => s.typicalRange)).toEqual([
      'About the first 12 to 18 months',
      'About 1.5 to 3 or more years',
      'About 3 to 6 or more years',
      'About 6 to 10 or more years, and not guaranteed',
    ]);
  });

  it('holds the owner-approved goals word for word', () => {
    expect(ADULT_PATHWAY_STAGES.map((s) => s.goals.map((g) => g.text))).toEqual([
      [
        'Stance and guard',
        'Footwork',
        'Straight punches',
        'Basic defence (block, parry, slip, roll)',
        'Aerobic base',
        'Controlled touch sparring after defence is solid',
      ],
      [
        'Hooks, uppercuts, combinations',
        'Distance and timing',
        'Strength then power blocks',
        'Hard sparring kept to about once a week',
      ],
      ['Own style', 'Film study', 'Planned strength and conditioning'],
      ['Competing at elite level — not guaranteed for anyone'],
    ]);
  });

  it('says Elite is not guaranteed, in the range and in its goal', () => {
    const elite = adultPathwayStage('elite');
    expect(elite.typicalRange).toMatch(/not guaranteed/);
    expect(elite.goals.some((g) => /not guaranteed/.test(g.text))).toBe(true);
  });

  // Rule 3 of the header: nothing here can promote anyone. A stage or goal that
  // grows an hours, sessions, level, date or threshold field is the first step
  // towards computing a stage, so the allowed shape is pinned.
  it('holds nothing a stage could be computed from', () => {
    for (const stage of ADULT_PATHWAY_STAGES) {
      expect(Object.keys(stage).sort()).toEqual(['goals', 'key', 'name', 'typicalRange']);
      for (const goal of stage.goals) {
        expect(Object.keys(goal).sort()).toEqual(['key', 'text']);
      }
    }
  });

  it('keeps goal keys unique across the whole pathway', () => {
    const keys = ADULT_PATHWAY_STAGES.flatMap((s) => s.goals.map((g) => g.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('recognises only the four stage keys', () => {
    expect(isAdultPathwayStageKey('foundation')).toBe(true);
    expect(isAdultPathwayStageKey('youth')).toBe(false);
    expect(isAdultPathwayStageKey(undefined)).toBe(false);
  });
});
