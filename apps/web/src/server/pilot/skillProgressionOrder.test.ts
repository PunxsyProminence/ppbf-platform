import { SKILL_FAMILY_IDS, SKILL_FAMILY_PREREQUISITES, type SkillFamilyId, type SkillFamilyPrerequisites } from './skillFamilies';
import { deriveSkillProgressionOrder } from './skillProgressionOrder';

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

/*
  The order is derived, so these tests pin the DERIVATION against the registry
  table -- the exact steps an athlete sees, and the invariant that matters more
  than any one ordering: nothing is ever shown ahead of what it needs.
*/

const ids = (order: ReturnType<typeof deriveSkillProgressionOrder>) =>
  order.steps.map((s) => s.families.map((f) => f.familyId));

describe('deriveSkillProgressionOrder', () => {
  test('the registry gives these steps, with [CC] breaking ties inside a step', () => {
    expect(ids(deriveSkillProgressionOrder())).toEqual([
      ['SKILL-01'],
      ['SKILL-02', 'SKILL-06', 'SKILL-04'],
      ['SKILL-07', 'SKILL-03', 'SKILL-08'],
      ['SKILL-05', 'SKILL-09'],
      ['SKILL-10'],
    ]);
  });

  test('no family appears at or before a step holding one of its prerequisites', () => {
    const order = deriveSkillProgressionOrder();
    const stepOf = new Map<string, number>();
    for (const s of order.steps) for (const f of s.families) stepOf.set(f.familyId, s.step);
    for (const s of order.steps) {
      for (const f of s.families) {
        for (const p of f.prerequisites) {
          expect(stepOf.get(p.familyId)!).toBeLessThan(s.step);
        }
      }
    }
  });

  test('registry wins over [CC]: footwork comes after the jab it needs (Jason 2026-10-03)', () => {
    const order = deriveSkillProgressionOrder();
    const stepOf = (id: string) => order.steps.find((s) => s.families.some((f) => f.familyId === id))!.step;
    expect(stepOf('SKILL-07')).toBeGreaterThan(stepOf('SKILL-02'));
  });

  test('every family is shown exactly once, SKILL-11 and SKILL-12 alongside every step with the registry text', () => {
    const order = deriveSkillProgressionOrder();
    const shown = [...ids(order).flat(), ...order.acrossAll.map((f) => f.familyId)];
    expect([...shown].sort()).toEqual([...SKILL_FAMILY_IDS].sort());
    expect(order.acrossAll).toEqual([
      { familyId: 'SKILL-11', name: 'Skill Under Fatigue', registryText: 'core skills seeded' },
      { familyId: 'SKILL-12', name: 'Film-to-Drill Transfer', registryText: 'registry + film inputs' },
    ]);
  });

  test('a family carries its prerequisites by name', () => {
    const order = deriveSkillProgressionOrder();
    const hook = order.steps.flatMap((s) => s.families).find((f) => f.familyId === 'SKILL-05')!;
    expect(hook.prerequisites.map((p) => p.name)).toEqual([
      'Stance / Guard / Reset',
      'Rear-Hand System',
      'Hook System',
    ]);
  });

  test('a prerequisite cycle is refused, not dropped', () => {
    const table: Record<SkillFamilyId, SkillFamilyPrerequisites> = {
      ...SKILL_FAMILY_PREREQUISITES,
      'SKILL-01': { kind: 'families', families: ['SKILL-02'] },
    };
    expect(() => deriveSkillProgressionOrder(table)).toThrow(/cycle/);
  });

  test('a prerequisite with no place in the sequence is refused', () => {
    const table: Record<SkillFamilyId, SkillFamilyPrerequisites> = {
      ...SKILL_FAMILY_PREREQUISITES,
      'SKILL-02': { kind: 'families', families: ['SKILL-11'] },
    };
    expect(() => deriveSkillProgressionOrder(table)).toThrow(/no place in the sequence/);
  });
});
