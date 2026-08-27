import {
  BLOCKER_CATEGORIES,
  FORMULA_BLOCKER_CATEGORY_EVIDENCE,
  SHADOW_FORMULA_BLOCKERS,
  buildFormulaBlockerResearchRequirement,
  getFormulaBlocker,
  isBlockedSupport,
  needsOwnerClassification,
  type BlockerCategory,
} from './blockerMap';
import { getFormulaDefinition } from './registry';
import { FORMULA_IDS, type FormulaId } from './types';

/**
 * The whole expected classification, written out rather than computed, so a
 * change to any single formula's categories has to be made twice -- once in
 * the map and once here -- and shows up as a two-line diff a reviewer can
 * read. `[]` is the NEEDS_OWNER_CLASSIFICATION marker; there is no sentinel
 * string and no default.
 */
const EXPECTED: Record<FormulaId, readonly BlockerCategory[]> = {
  'CORE-01': [],
  'CORE-02': [],
  'CORE-03': [],
  'CORE-04': [],
  'CORE-05': ['TAXONOMY_GAP', 'POLICY_DECISION'],
  'CORE-06': ['DATA_GAP', 'POLICY_DECISION'],
  'CORE-07': ['DATA_GAP', 'POLICY_DECISION'],
  'CORE-08': [],
  'CORE-09': ['DATA_GAP', 'POLICY_DECISION'],
  'CORE-10': [],
  'CORE-11': [],
  'CORE-12': [],
  'CORE-13': [],
  'MVP-01': [],
  'MVP-02': [],
  'MVP-03': [],
  'MVP-04': [],
  'MVP-05': [],
  'MVP-06': [],
  'MVP-07': [],
  'MVP-08': [],
  'MVP-09': [],
  'MVP-10': [],
  'MVP-11': [],
  'MVP-12': [],
  'BF-01': ['DATA_GAP'],
  // Contradicted stated ground -- see the contradiction test below.
  'BF-02': [],
  'BF-03': [],
  'BF-04': ['DATA_GAP', 'TAXONOMY_GAP'],
  'BF-05': ['DATA_GAP'],
  'BF-06': ['DATA_GAP'],
  'BF-07': ['DATA_GAP', 'POLICY_DECISION'],
  'BF-08': ['DATA_GAP'],
  'BF-09': ['DATA_GAP', 'TAXONOMY_GAP', 'POLICY_DECISION'],
  'BF-10': ['CALIBRATION_GAP', 'POLICY_DECISION'],
  'BF-11': [],
  'BF-12': ['DATA_GAP'],
  'BF-13': ['DATA_GAP', 'POLICY_DECISION'],
  'LEGACY-READINESS': ['RESEARCH_GAP', 'CALIBRATION_GAP', 'SAFETY_REVIEW_REQUIRED'],
};

describe('SHADOW formula blocker map: completeness', () => {
  test('accounts for every registered formula exactly once, in registry order', () => {
    expect(SHADOW_FORMULA_BLOCKERS).toHaveLength(FORMULA_IDS.length);
    expect(SHADOW_FORMULA_BLOCKERS.map((entry) => entry.formulaId)).toEqual([...FORMULA_IDS]);
    expect(new Set(SHADOW_FORMULA_BLOCKERS.map((entry) => entry.formulaId)).size).toBe(FORMULA_IDS.length);
  });

  test('leaves no blocked formula unaccounted for', () => {
    const blockedIds = FORMULA_IDS.filter((id) => isBlockedSupport(getFormulaDefinition(id).support));
    expect(blockedIds).toHaveLength(18);
    for (const id of blockedIds) {
      const blocker = getFormulaBlocker(id);
      expect(blocker).toBeDefined();
      // Every blocked formula carries a category set OR an explicit empty
      // array. There is no third state and no "unset".
      expect(Array.isArray(blocker.categories)).toBe(true);
      expect(typeof blocker.reasonVerbatim).toBe('string');
    }
  });

  test('never leaves an empty category set without an owner note', () => {
    for (const blocker of SHADOW_FORMULA_BLOCKERS) {
      if (blocker.categories.length === 0) {
        // `[]` is the NEEDS_OWNER_CLASSIFICATION marker, so it must always
        // arrive with the question the owner is being asked. A silent `[]`
        // is indistinguishable from an omission.
        expect(typeof blocker.ownerNote).toBe('string');
        expect(blocker.ownerNote!.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('SHADOW formula blocker map: reads the registry, never restates it', () => {
  test('mirrors support and unsupportedReason from the registry for all 39', () => {
    for (const id of FORMULA_IDS) {
      const definition = getFormulaDefinition(id);
      const blocker = getFormulaBlocker(id);
      expect(blocker.support).toBe(definition.support);
      expect(blocker.reasonVerbatim).toBe(definition.unsupportedReason ?? null);
    }
  });

  test('every category is licensed by a phrase that is literally present in the reason', () => {
    for (const id of FORMULA_IDS) {
      const blocker = getFormulaBlocker(id);
      const evidence = FORMULA_BLOCKER_CATEGORY_EVIDENCE[id];
      for (const item of evidence) {
        expect(blocker.reasonVerbatim).not.toBeNull();
        expect(blocker.reasonVerbatim).toContain(item.phrase);
      }
      // The category set is exactly the set the evidence licenses -- nothing
      // is asserted that no phrase supports, and no supported category is
      // dropped.
      expect(new Set(blocker.categories)).toEqual(new Set(evidence.map((item) => item.category)));
    }
  });

  test('every entry with no evidence has an empty category set', () => {
    for (const id of FORMULA_IDS) {
      if (FORMULA_BLOCKER_CATEGORY_EVIDENCE[id].length === 0) {
        expect(getFormulaBlocker(id).categories).toEqual([]);
        expect(needsOwnerClassification(getFormulaBlocker(id))).toBe(true);
      }
    }
  });
});

describe('SHADOW formula blocker map: the classification itself', () => {
  test('matches the written-out expectation for every formula', () => {
    for (const id of FORMULA_IDS) {
      expect(new Set(getFormulaBlocker(id).categories)).toEqual(new Set(EXPECTED[id]));
    }
  });

  test('orders categories canonically so a consumer can compare sets by value', () => {
    for (const blocker of SHADOW_FORMULA_BLOCKERS) {
      const positions = blocker.categories.map((category) => BLOCKER_CATEGORIES.indexOf(category));
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      expect(new Set(blocker.categories).size).toBe(blocker.categories.length);
    }
  });

  test('reports the measured counts of this registry text', () => {
    const blocked = SHADOW_FORMULA_BLOCKERS.filter((entry) => isBlockedSupport(entry.support));
    const classified = blocked.filter((entry) => entry.categories.length > 0);

    expect(blocked).toHaveLength(18);
    expect(classified).toHaveLength(15);
    expect(classified.filter((entry) => entry.categories.length === 1)).toHaveLength(5);
    expect(classified.filter((entry) => entry.categories.length > 1)).toHaveLength(10);
    expect(SHADOW_FORMULA_BLOCKERS.filter(needsOwnerClassification)).toHaveLength(24);
    expect(blocked.filter(needsOwnerClassification)).toHaveLength(3);
  });

  test('reports the measured category coverage of this registry text', () => {
    const coverage = Object.fromEntries(
      BLOCKER_CATEGORIES.map((category) => [
        category,
        SHADOW_FORMULA_BLOCKERS.filter((entry) => entry.categories.includes(category)).length,
      ]),
    );

    // A measurement of the current registry prose, not a rule about what the
    // registry may say. It goes red when the prose changes, which is the
    // point: the counts in the PR that introduced this map would otherwise
    // silently stop being true.
    expect(coverage).toEqual({
      DATA_GAP: 12,
      INTEGRATION_GAP: 0,
      TAXONOMY_GAP: 3,
      RESEARCH_GAP: 1,
      CALIBRATION_GAP: 2,
      POLICY_DECISION: 8,
      SAFETY_REVIEW_REQUIRED: 1,
    });
  });
});

describe('SHADOW formula blocker map: the three contradictions', () => {
  test('surfaces the absorbed-punch contradiction on BF-02 and BF-03 without reclassifying', () => {
    for (const id of ['BF-02', 'BF-03'] as const) {
      const blocker = getFormulaBlocker(id);
      expect(blocker.reasonVerbatim).toContain('absorbed');
      expect(blocker.categories).toEqual([]);
      expect(blocker.ownerNote).toContain('punch_absorbed');
      expect(blocker.ownerNote).toContain('MVP-04');
    }
  });

  test('surfaces the personal-baseline contradiction on BF-11 without reclassifying', () => {
    const blocker = getFormulaBlocker('BF-11');
    expect(blocker.reasonVerbatim).toContain('Immutable personal baselines');
    expect(blocker.categories).toEqual([]);
    expect(blocker.ownerNote).toContain('buildPersonalBaselineSnapshot');
    expect(blocker.ownerNote).toContain('MVP-09');
    // The uncontradicted second clause is RECORDED, not assigned.
    expect(blocker.ownerNote).toContain('CALIBRATION_GAP');
  });

  test('assigns INTEGRATION_GAP to nothing, because no reason states one', () => {
    // The contradictions above are the closest thing in the registry to an
    // integration gap, and reclassifying them here is exactly what was
    // forbidden. This asserts the restraint held.
    expect(SHADOW_FORMULA_BLOCKERS.filter((entry) => entry.categories.includes('INTEGRATION_GAP'))).toEqual([]);
  });
});

describe('SHADOW formula blocker map: research-requirement bridge', () => {
  const actor = {
    organizationId: 'org-1',
    createdByAccountId: 'account-1',
    createdByRole: 'org_admin',
  };

  test('produces the agreed source triple so the existing unique index dedupes it', () => {
    const built = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-10'), ...actor });

    expect(built.sourceEventName).toBe('SHADOW_FORMULA_BLOCKER_CLASSIFIED');
    expect(built.sourceEntityType).toBe('formula_id');
    expect(built.sourceEntityId).toBe('BF-10');
    expect(built.subjectId).toBeNull();
    expect(built.organizationId).toBe('org-1');
  });

  test('carries the registry reason verbatim as the knowledge gap', () => {
    const blocker = getFormulaBlocker('BF-10');
    const built = buildFormulaBlockerResearchRequirement({ blocker, ...actor });

    expect(built.knowledgeGap).toBe(getFormulaDefinition('BF-10').unsupportedReason);
    expect(built.knowledgeGap).toBe(blocker.reasonVerbatim);
  });

  test('is stable per formula per organization, which is what makes it idempotent', () => {
    const first = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-09'), ...actor });
    const second = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-09'), ...actor });

    // pilot.shadow_research_requirements is unique on
    // (organization_id, source_event_name, source_entity_type, source_entity_id).
    const key = (input: typeof first) => [
      input.organizationId,
      input.sourceEventName,
      input.sourceEntityType,
      input.sourceEntityId,
    ].join('|');

    expect(key(first)).toBe(key(second));
    expect(key(first)).toBe('org-1|SHADOW_FORMULA_BLOCKER_CLASSIFIED|formula_id|BF-09');
  });

  test('reports an absent reason as an absent reason rather than inventing one', () => {
    const built = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('CORE-03'), ...actor });

    expect(getFormulaDefinition('CORE-03').unsupportedReason).toBeUndefined();
    expect(built.knowledgeGap).toContain('records no unsupportedReason');
    expect(built.metadata?.needs_owner_classification).toBe(true);
  });

  test('puts the derived classification in metadata, never in the reason', () => {
    const built = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('LEGACY-READINESS'), ...actor });

    expect(built.metadata?.categories).toEqual(['RESEARCH_GAP', 'CALIBRATION_GAP', 'SAFETY_REVIEW_REQUIRED']);
    expect(built.metadata?.support).toBe('experimental_unsupported');
    expect(built.metadata?.needs_owner_classification).toBe(false);
    expect(built.knowledgeGap).toBe(getFormulaDefinition('LEGACY-READINESS').unsupportedReason);
  });
});
