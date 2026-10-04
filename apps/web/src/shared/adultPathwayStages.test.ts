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

  it('gives every stage a range, never a single figure', () => {
    for (const stage of ADULT_PATHWAY_STAGES) {
      expect(stage.typicalRange).toMatch(/^About /);
      expect(stage.typicalRange).toMatch(/\d+ to \d+/);
    }
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
