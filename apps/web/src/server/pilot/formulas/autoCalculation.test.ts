jest.mock('../db', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { query, withTransaction } from '../db';
import {
  autoCalculateForObservationContext,
  canTriggerStoredCalculation,
  detectSatisfiedFormulaInputs,
  STORED_CALCULATION_TRIGGER_ROLES,
} from './autoCalculation';
import { FORMULA_INPUT_REQUIREMENTS } from './runner';
import type {
  FormulaUnit,
  MvpFormulaId,
  NumericObservation,
  ObservationKind,
} from './types';

const mockQuery = jest.mocked(query);
const mockWithTransaction = jest.mocked(withTransaction);

function observation(input: {
  id: string;
  kind: ObservationKind;
  unit: FormulaUnit;
  value: number | null;
  contextId?: string;
  dimensions?: Readonly<Record<string, string | number | boolean | null>>;
  observedAt?: string;
}): NumericObservation {
  return {
    observationId: input.id,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: input.contextId ?? 'sparring_1',
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    dimensions: input.dimensions ?? {},
    observedAt: input.observedAt ?? '2026-08-26T18:00:00.000Z',
    source: {
      type: 'manual',
      quality: 'moderate',
      referenceId: `${input.id}-source`,
    },
  };
}

/**
 * Exactly what app/athlete/dashboard/sparring/page.tsx:71-88 posts for one
 * submission: one of each kind, one contextId, punchType only on the
 * attempted/landed pair.
 */
function sparringContext(contextId = 'sparring_1'): NumericObservation[] {
  return [
    observation({
      id: `${contextId}-attempted`,
      kind: 'punch_attempted',
      unit: 'count',
      value: 40,
      contextId,
      dimensions: { punchType: 'Jab' },
    }),
    observation({
      id: `${contextId}-landed`,
      kind: 'punch_landed',
      unit: 'count',
      value: 18,
      contextId,
      dimensions: { punchType: 'Jab' },
    }),
    observation({
      id: `${contextId}-absorbed`,
      kind: 'punch_absorbed',
      unit: 'count',
      value: 11,
      contextId,
      dimensions: { opponentStance: 'Orthodox' },
    }),
    observation({
      id: `${contextId}-focus`,
      kind: 'focus_achieved',
      unit: 'boolean_0_1',
      value: 1,
      contextId,
    }),
    observation({
      id: `${contextId}-contact-level`,
      kind: 'contact_level',
      unit: 'level_0_3',
      value: 2,
      contextId,
      dimensions: { opponentStance: 'Orthodox' },
    }),
    observation({
      id: `${contextId}-contact-rounds`,
      kind: 'contact_rounds',
      unit: 'count',
      value: 6,
      contextId,
      dimensions: { opponentStance: 'Orthodox' },
    }),
    observation({
      id: `${contextId}-weight`,
      kind: 'body_weight',
      unit: 'kilograms',
      value: 63.5,
      contextId,
    }),
    observation({
      id: `${contextId}-notes`,
      kind: 'recovery_notes',
      unit: 'text_present_0_1',
      value: 1,
      contextId,
      dimensions: { notes: 'Left shoulder tight' },
    }),
  ];
}

describe('satisfied formula input detection', () => {
  test('a complete sparring context yields exactly MVP-03 and MVP-04', () => {
    expect(detectSatisfiedFormulaInputs(sparringContext())).toEqual([
      {
        formulaId: 'MVP-03',
        observationIds: ['sparring_1-attempted', 'sparring_1-landed'],
      },
      {
        formulaId: 'MVP-04',
        observationIds: ['sparring_1-absorbed', 'sparring_1-landed'],
      },
    ]);
  });

  test('returns nothing until the last observation of the set has landed', () => {
    // The sparring page posts every observation concurrently through
    // Promise.allSettled, so this runs once per POST against whatever has
    // committed so far. No debounce and no settling timer: an exact-match
    // detector produces nothing from a partial set by construction, and the
    // repeat run that the last POST triggers is a no-op because
    // calculationKey excludes computedAt.
    const full = sparringContext();
    for (let size = 0; size < full.length; size += 1) {
      const partial = full.slice(0, size).filter((item) => (
        item.kind !== 'punch_landed'
      ));
      expect(detectSatisfiedFormulaInputs(partial)).toEqual([]);
    }
    expect(detectSatisfiedFormulaInputs(full)).toHaveLength(2);
  });

  test('an extra observation of a required kind means NOT satisfied, never "pick one"', () => {
    // Two punch types logged against one contextId. MVP-03 groups by
    // (contextId, punchType) so it fires twice; MVP-04 does not group by
    // punch type, sees two punch_landed in the context, and must refuse
    // rather than choose one of them.
    const twoPunchTypes = [
      ...sparringContext(),
      observation({
        id: 'sparring_1-attempted-cross',
        kind: 'punch_attempted',
        unit: 'count',
        value: 20,
        dimensions: { punchType: 'Cross' },
      }),
      observation({
        id: 'sparring_1-landed-cross',
        kind: 'punch_landed',
        unit: 'count',
        value: 7,
        dimensions: { punchType: 'Cross' },
      }),
    ];

    expect(detectSatisfiedFormulaInputs(twoPunchTypes)).toEqual([
      {
        formulaId: 'MVP-03',
        observationIds: ['sparring_1-attempted-cross', 'sparring_1-landed-cross'],
      },
      {
        formulaId: 'MVP-03',
        observationIds: ['sparring_1-attempted', 'sparring_1-landed'],
      },
    ]);
  });

  test('separates contexts and never pairs across them', () => {
    const detected = detectSatisfiedFormulaInputs([
      ...sparringContext('sparring_1'),
      ...sparringContext('sparring_2'),
    ]);

    expect(detected).toEqual([
      { formulaId: 'MVP-03', observationIds: ['sparring_1-attempted', 'sparring_1-landed'] },
      { formulaId: 'MVP-03', observationIds: ['sparring_2-attempted', 'sparring_2-landed'] },
      { formulaId: 'MVP-04', observationIds: ['sparring_1-absorbed', 'sparring_1-landed'] },
      { formulaId: 'MVP-04', observationIds: ['sparring_2-absorbed', 'sparring_2-landed'] },
    ]);
  });

  test('a punch type on one half of the MVP-03 pair and not the other is not a pair', () => {
    const detected = detectSatisfiedFormulaInputs(sparringContext().map((item) => (
      item.kind === 'punch_landed' ? { ...item, dimensions: {} } : item
    )));

    // MVP-03 requires punchType on both halves -- it is the grouping key, and
    // without it calculateAccuracyByPunchType cannot even name its output
    // (`accuracy_unknown`). MVP-04 has no punch-type requirement at all, so it
    // is unaffected: the pair it needs is still exactly one landed and one
    // absorbed in this context.
    expect(detected).toEqual([
      { formulaId: 'MVP-04', observationIds: ['sparring_1-absorbed', 'sparring_1-landed'] },
    ]);
  });

  test('a pair carrying no punch type at all is not an MVP-03 input set', () => {
    // Both halves unlabelled is the case the group key alone cannot catch:
    // they land in the same group and the counts are right. The requirement is
    // what refuses it. calculateAccuracyByPunchType would hard-block
    // INVALID_DIMENSION and file the result under `accuracy_unknown` -- an
    // accuracy "by punch type" with no punch type, published automatically,
    // for a set nobody asked to compute. A coach who wants it anyway still has
    // the manual /results path; auto-orchestration does not volunteer it.
    const detected = detectSatisfiedFormulaInputs(sparringContext().map((item) => (
      item.kind === 'punch_landed' || item.kind === 'punch_attempted'
        ? { ...item, dimensions: {} }
        : item
    )));

    expect(detected.map((item) => item.formulaId)).toEqual(['MVP-04']);
  });

  test('a mismatched punch type across the pair is not a pair', () => {
    const detected = detectSatisfiedFormulaInputs(sparringContext().map((item) => (
      item.kind === 'punch_attempted'
        ? { ...item, dimensions: { punchType: 'Cross' } }
        : item
    )));

    expect(detected.filter((item) => item.formulaId === 'MVP-03')).toEqual([]);
  });

  test('an observation carrying the wrong unit for its kind is not detected', () => {
    const detected = detectSatisfiedFormulaInputs(sparringContext().map((item) => (
      item.kind === 'punch_absorbed' ? { ...item, unit: 'minutes' as FormulaUnit } : item
    )));

    expect(detected.map((item) => item.formulaId)).toEqual(['MVP-03']);
  });

  test('a missing value still fires -- an unavailable result must be persisted, not suppressed', () => {
    // calculateConnectDifferential hard-blocks MISSING_ABSORBED and returns an
    // `insufficient` result. The manual /results path persists that result, so
    // this path must produce it too. Filtering null values here would make the
    // two paths disagree about the same observations.
    const detected = detectSatisfiedFormulaInputs(sparringContext().map((item) => (
      item.kind === 'punch_absorbed' ? { ...item, value: null } : item
    )));

    expect(detected).toContainEqual({
      formulaId: 'MVP-04',
      observationIds: ['sparring_1-absorbed', 'sparring_1-landed'],
    });
  });

  test('is deterministic regardless of the order observations arrive in', () => {
    const forwards = detectSatisfiedFormulaInputs([
      ...sparringContext('sparring_2'),
      ...sparringContext('sparring_1'),
    ]);
    const backwards = detectSatisfiedFormulaInputs([
      ...sparringContext('sparring_1'),
      ...sparringContext('sparring_2'),
    ].reverse());

    expect(forwards).toEqual(backwards);
  });

  test('produces nothing from an empty set', () => {
    expect(detectSatisfiedFormulaInputs([])).toEqual([]);
  });

  test('performs no I/O', () => {
    detectSatisfiedFormulaInputs(sparringContext());
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });
});

describe('declared input requirements match the executable contract', () => {
  test('covers MVP-03 and MVP-04 and nothing else', () => {
    expect(FORMULA_INPUT_REQUIREMENTS.map((item) => item.formulaId)).toEqual([
      'MVP-03',
      'MVP-04',
    ]);
  });

  test.each(FORMULA_INPUT_REQUIREMENTS.map((requirement) => [
    requirement.formulaId,
    requirement,
  ] as const))(
    '%s: an input set built from the declared requirement runs without INVALID_INPUT_SET',
    async (formulaId, requirement) => {
      // The const and the calculateStoredFormula switch are two statements of
      // the same contract. This is the test that goes red if they drift: it
      // builds a set from the const ALONE and hands it to the runner.
      const built: NumericObservation[] = [];
      for (const [kind, count] of Object.entries(requirement.kinds)) {
        for (let index = 0; index < (count as number); index += 1) {
          built.push(observation({
            id: `${formulaId}-${kind}-${index}`,
            kind: kind as ObservationKind,
            unit: requirement.units[kind as ObservationKind] as FormulaUnit,
            value: 1,
            dimensions: Object.fromEntries(
              requirement.requiredDimensionKeys.map((key) => [key, 'Jab']),
            ),
          }));
        }
      }

      mockQuery.mockResolvedValue([] as never);
      mockWithTransaction.mockImplementation(async (callback) => callback({
        query: jest.fn().mockResolvedValue({ rows: [] }),
      } as never));

      const { runStoredMvpFormula } = await import('./runner');
      const repository = await import('./repository');
      jest
        .spyOn(repository, 'getActiveFormulaObservationsByIds')
        .mockResolvedValue(built);
      jest
        .spyOn(repository, 'saveFormulaResultsWithClient')
        .mockImplementation(async (_client, results) => [...results]);

      const output = await runStoredMvpFormula({
        organizationId: 'org-1',
        athleteId: 'athlete-1',
        formulaId: formulaId as MvpFormulaId,
        observationIds: built.map((item) => item.observationId),
      });

      // Not throwing is only half of it. A wrong unit or a dropped dimension
      // key in the const does not raise INVALID_INPUT_SET -- the switch waves
      // it through and the ENGINE hard-blocks it, producing a permanently
      // invalid result instead of a calculation. These four reason codes are
      // exactly "the input did not match the contract", so a set built from
      // the const must produce none of them.
      expect(output.results.length).toBeGreaterThan(0);
      for (const result of output.results) {
        // Asserted one code at a time on purpose: `not.arrayContaining` is an
        // ALL-of matcher, so a single list of four would only fail when all
        // four were present at once and would wave through the realistic case
        // of exactly one being wrong.
        for (const code of [
          'OBSERVATION_KIND_MISMATCH',
          'UNIT_MISMATCH',
          'INVALID_DIMENSION',
          'DIMENSION_MISMATCH',
        ]) {
          expect(result.validation.hardBlocks).not.toContain(code);
        }
      }

      jest.restoreAllMocks();
    },
  );
});

describe('roles permitted to trigger a stored calculation', () => {
  test('mirrors the manual calculation route and does not widen it', () => {
    // app/api/pilot/shadow/formulas/results/route.ts:99 gates POST /results --
    // the manual "run this formula" path -- to exactly these three. Athletes
    // may POST observations and may READ results; they may not cause a
    // calculation. Auto-orchestration must not become the way around that.
    expect([...STORED_CALCULATION_TRIGGER_ROLES]).toEqual([
      'coach',
      'organization_admin',
      'admin',
    ]);
    expect(canTriggerStoredCalculation('athlete')).toBe(false);
    expect(canTriggerStoredCalculation('parent')).toBe(false);
    expect(canTriggerStoredCalculation('platform_owner')).toBe(false);
    expect(canTriggerStoredCalculation('coach')).toBe(true);
    expect(canTriggerStoredCalculation('organization_admin')).toBe(true);
    expect(canTriggerStoredCalculation('admin')).toBe(true);
  });
});

describe('the executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('reads the context, runs every detected calculation, and persists nothing itself', async () => {
    const repository = await import('./repository');
    const runner = await import('./runner');
    const contextRead = jest
      .spyOn(repository, 'getActiveObservationsForContext')
      .mockResolvedValue(sparringContext());
    const run = jest
      .spyOn(runner, 'runStoredMvpFormula')
      .mockResolvedValue({ results: [] });

    await autoCalculateForObservationContext({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      contextId: 'sparring_1',
    });

    expect(contextRead).toHaveBeenCalledWith({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      contextId: 'sparring_1',
    });
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      {
        organizationId: 'org-1',
        athleteId: 'athlete-1',
        formulaId: 'MVP-03',
        observationIds: ['sparring_1-attempted', 'sparring_1-landed'],
      },
      {
        organizationId: 'org-1',
        athleteId: 'athlete-1',
        formulaId: 'MVP-04',
        observationIds: ['sparring_1-absorbed', 'sparring_1-landed'],
      },
    ]);
    // No parameters and no policyVersion: neither MVP-03 nor MVP-04 is a
    // policy formula, and runStoredMvpFormula rejects the pair outright for
    // formulas that are not.
    expect(run.mock.calls.every(([input]) => (
      !('parameters' in input) && !('policyVersion' in input)
    ))).toBe(true);
  });

  test('runs nothing when the context holds no satisfied set', async () => {
    const repository = await import('./repository');
    const runner = await import('./runner');
    jest
      .spyOn(repository, 'getActiveObservationsForContext')
      .mockResolvedValue([observation({
        id: 'only-focus',
        kind: 'focus_achieved',
        unit: 'boolean_0_1',
        value: 1,
      })]);
    const run = jest.spyOn(runner, 'runStoredMvpFormula');

    await expect(autoCalculateForObservationContext({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      contextId: 'sparring_1',
    })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * WHY THE SCOPE IS MVP-03 AND MVP-04 ONLY.
 *
 * Not a judgement about which formulas matter. Six of the twelve MVP formulas
 * cannot fire because nothing in this application produces the observation
 * kinds they consume, and orchestrating them would be orchestrating nothing.
 * That is a claim about the current source tree, so it is measured here rather
 * than asserted in a comment: this suite finds every file that posts to the
 * observations endpoint and reads back the kinds it sends.
 *
 * If a producer for one of those kinds is ever added, this suite goes red and
 * names the kind -- which is the point. The gap stops being silent.
 */
describe('observation kinds this application actually produces', () => {
  const WEB_ROOT = resolve(__dirname, '../../../..');
  const OBSERVATION_ENDPOINT = 'api/pilot/shadow/formulas/observations';

  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        found.push(...sourceFiles(path));
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      found.push(path);
    }
    return found;
  }

  const producerFiles = ['app', 'components', 'src', 'lib']
    .map((directory) => join(WEB_ROOT, directory))
    .flatMap((directory) => sourceFiles(directory))
    .filter((path) => (
      readFileSync(path, 'utf8').includes(OBSERVATION_ENDPOINT)
      && !path.includes(join('app', 'api', 'pilot', 'shadow', 'formulas', 'observations'))
    ))
    .map((path) => relative(WEB_ROOT, path))
    .sort();

  test('every producer of formula observations is one of the two known ones', () => {
    expect(producerFiles).toEqual([
      join('app', 'athlete', 'dashboard', 'sparring', 'page.tsx'),
      join('components', 'AthleteWorkspace.tsx'),
    ]);
  });

  test('six MVP formulas have no producer for their inputs at all', () => {
    const produced = new Set<string>();
    for (const file of producerFiles) {
      const source = readFileSync(join(WEB_ROOT, file), 'utf8');
      for (const match of source.matchAll(/\bkind:\s*'([a-z_]+)'/g)) {
        produced.add(match[1]);
      }
    }

    // MVP-01 and MVP-05 need session_rpe/duration/active_time; MVP-02 needs
    // punch_count/round_count/active_time; MVP-07 and MVP-08 need
    // round_output. The session_rpe and duration producers were removed on
    // purpose -- AthleteWorkspace.tsx:1500 and :1581 record that check-in was
    // posting a pre-session readiness slider as session RPE and a PLANNED
    // duration as an observed one, and that both feeds were deleted rather
    // than corrected. Nothing replaced them.
    expect([...produced].sort()).toEqual([
      'body_weight',
      'contact_level',
      'contact_rounds',
      'focus_achieved',
      'pain_report',
      'punch_absorbed',
      'punch_attempted',
      'punch_landed',
      'recovery_notes',
    ]);

    for (const kind of [
      'session_rpe',
      'duration',
      'punch_count',
      'round_count',
      'active_time',
      'round_output',
    ]) {
      expect(produced.has(kind)).toBe(false);
    }
  });
});
