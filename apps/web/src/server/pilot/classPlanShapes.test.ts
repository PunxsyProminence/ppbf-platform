import {
  groupClassPlanWeeks,
  readinessLine,
  type ClassPlanDayTemplate,
  type ClassPlanSessionRow,
} from './classPlanShapes';

const READY: ClassPlanDayTemplate = { state: 'ready', template_id: 't', name: 'T', drill_count: 3, drills_to_complete: 0 };

function session(block_order: number, ordinal: number, week: number, day: string): ClassPlanSessionRow {
  return { block_session_id: `tbs_${block_order}_${ordinal}`, block_order, ordinal, week, day, template_lineage_id: `wtp_${ordinal}` };
}

describe('groupClassPlanWeeks', () => {
  const blocks = [
    { block_order: 2, title: 'Week 2: Two' },
    { block_order: 1, title: 'Week 1: One' },
  ];

  it('orders weeks by block and days by ordinal whatever order the rows arrive in', () => {
    const weeks = groupClassPlanWeeks(
      blocks,
      [session(2, 2, 2, 'Tuesday'), session(1, 2, 1, 'Tuesday'), session(2, 1, 2, 'Monday'), session(1, 1, 1, 'Monday')],
      () => READY,
    );
    expect(weeks.map((w) => [w.week, w.title, w.days.map((d) => d.day)])).toEqual([
      [1, 'Week 1: One', ['Monday', 'Tuesday']],
      [2, 'Week 2: Two', ['Monday', 'Tuesday']],
    ]);
  });

  it('keeps a block with no sessions, with no days, rather than dropping it', () => {
    const weeks = groupClassPlanWeeks(blocks, [session(1, 1, 1, 'Monday')], () => READY);
    expect(weeks).toHaveLength(2);
    expect(weeks[1]).toMatchObject({ block_order: 2, title: 'Week 2: Two', days: [] });
  });

  it('resolves each day through its own template lineage, missing and withdrawn included', () => {
    const missing: ClassPlanDayTemplate = { state: 'missing', template_id: null, name: null, drill_count: null, drills_to_complete: null };
    const withdrawn: ClassPlanDayTemplate = { state: 'withdrawn', template_id: 'w', name: 'Old', drill_count: null, drills_to_complete: null };
    const weeks = groupClassPlanWeeks(
      blocks,
      [session(1, 1, 1, 'Monday'), session(1, 2, 1, 'Tuesday'), session(1, 3, 1, 'Wednesday')],
      (lineage) => (lineage === 'wtp_1' ? READY : lineage === 'wtp_2' ? missing : withdrawn),
    );
    expect(weeks[0].days.map((d) => d.template.state)).toEqual(['ready', 'missing', 'withdrawn']);
  });
});

describe('readinessLine', () => {
  it('says ready, not ready with counts, and nothing when readiness was not asked', () => {
    expect(readinessLine(READY)).toBe('Ready to issue');
    expect(readinessLine({ ...READY, state: 'not_ready', drill_count: 4, drills_to_complete: 4 }))
      .toBe('Not ready: 4 of 4 drills need completing');
    expect(readinessLine({ ...READY, state: 'withdrawn', drill_count: null, drills_to_complete: null })).toBeNull();
    expect(readinessLine({ ...READY, state: 'empty', drill_count: 0, drills_to_complete: 0 })).toBe('No steps in this template');
  });
});
