import type { ImportPlan } from './plan';
import { planView } from './upload';

// The admin screen is sent a retirement as one (UnitPlan.retires, PR #1894), the
// same truth cli.ts formatPlan prints; the totals stay as the plan gives them.
function planWith(units: ImportPlan['units']): ImportPlan {
  return {
    organizationId: 'org-1',
    actor: { accountId: 'admin-1', role: 'organization_admin' },
    datasets: ['pathway-catalog'],
    units,
    counts: {},
    totals: { new: 0, new_version: units.length, unchanged: 0, absent: 0, reject: 0 },
    blocking: [],
    warnings: [],
    changes: units.length,
    planHash: 'h'.repeat(64),
  } as unknown as ImportPlan;
}

describe('planView carries retires', () => {
  const units = [
    { dataset: 'pathway-catalog', key: 'Y2', outcome: 'new_version', fromVersion: 1, toVersion: 2, retires: true },
    { dataset: 'pathway-catalog', key: 'Y1', outcome: 'new_version', fromVersion: 1, toVersion: 2 },
  ] as unknown as ImportPlan['units'];

  test('a retiring unit is flagged, an ordinary revision is not, and counts are untouched', () => {
    const view = planView(planWith(units), {});
    expect(view.units.find((unit) => unit.key === 'Y2')).toMatchObject({ outcome: 'new_version', from_version: 1, to_version: 2, retires: true });
    expect(view.units.find((unit) => unit.key === 'Y1')).not.toHaveProperty('retires');
    expect(view.totals.new_version).toBe(2);
  });
});
