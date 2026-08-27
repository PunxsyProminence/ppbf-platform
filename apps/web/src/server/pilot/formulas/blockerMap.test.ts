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
  'BF-13': ['DATA_GAP'],
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
    // BF-13 moved from two categories to one when its 'must remain'
    // clause stopped licensing POLICY_DECISION, so single went 5 -> 6 and
    // multi went 10 -> 9. The classified total is unchanged.
    expect(classified.filter((entry) => entry.categories.length === 1)).toHaveLength(6);
    expect(classified.filter((entry) => entry.categories.length > 1)).toHaveLength(9);
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
      POLICY_DECISION: 7,
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
    createdByRole: 'organization_admin',
  };

  test('produces the agreed source triple so the existing unique index dedupes it', () => {
    const built = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-10'), ...actor });

    expect(built.sourceEventName).toBe('SHADOW_FORMULA_BLOCKER_CLASSIFIED');
    expect(built.sourceEntityType).toBe('formula_id');
    // The formula id plus the classification fingerprint -- see the note on
    // sourceEntityId in blockerMap.ts for why the key is versioned.
    expect(built.sourceEntityId).toBe('BF-10#unsupported:CALIBRATION_GAP,POLICY_DECISION');
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

    // Idempotency for an UNCHANGED classification is the property this test
    // guards, and it still holds. The key now carries a classification
    // fingerprint so a CHANGED one keys differently -- a resolved
    // requirement must not silently cover a question that moved. See the
    // 'a changed classification does not hide behind a stale requirement'
    // block below.
    expect(key(first)).toBe(key(second));
    expect(key(first))
      .toBe('org-1|SHADOW_FORMULA_BLOCKER_CLASSIFIED|formula_id|BF-09#unsupported:DATA_GAP,POLICY_DECISION,TAXONOMY_GAP');
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

describe('POLICY_DECISION means a decision is owed, not a rule already in force', () => {
  // Codex P2 on this PR. BF-13's reason ends "coach ordinal ratings must
  // remain separately labeled observations" -- a constraint ALREADY IN FORCE,
  // not an approval anyone is waiting on. Classifying it POLICY_DECISION
  // reported a blocker that does not exist and inflated policy-gap coverage.
  //
  // The map is otherwise consistent on this: every other POLICY_DECISION
  // phrase names something ABSENT ("not approved", "an approved X",
  // "a pairing policy"). BF-13's named something present.
  it('BF-13 is a data gap, with the labeling constraint recorded as a note', () => {
    const blocker = getFormulaBlocker('BF-13');
    expect(blocker.categories).toEqual(['DATA_GAP']);
    expect(blocker.ownerNote).toContain('separately labeled');
  });

  it('every POLICY_DECISION phrase names something absent', () => {
    // The guard that stops the next one slipping in. A phrase licensing
    // POLICY_DECISION has to read as a thing not yet done.
    const ABSENCE_WORDS = /\bnot approved\b|\bapproved\b|\bpolicy\b|\btaxonomy\b/i;
    for (const formulaId of FORMULA_IDS) {
      for (const evidence of FORMULA_BLOCKER_CATEGORY_EVIDENCE[formulaId]) {
        if (evidence.category !== 'POLICY_DECISION') continue;
        expect(evidence.phrase).toMatch(ABSENCE_WORDS);
        // "must remain" is the specific shape that failed: a rule in force.
        expect(evidence.phrase).not.toMatch(/must remain/i);
      }
    }
  });
});

describe('a changed classification does not hide behind a stale requirement', () => {
  // organization_admin, not 'org_admin': the canonical role vocabulary is
  // platform_owner, organization_admin, admin, coach, athlete, parent, board,
  // staff, volunteer. A fixture using a role that does not exist teaches the
  // next reader a role that does not exist.
  const actor = {
    organizationId: 'org-1',
    createdByAccountId: 'account-1',
    createdByRole: 'organization_admin',
  };

  // Codex P2 on this PR. createShadowResearchRequirement's conflict handler is
  // a deliberate no-op (shadowResearch.ts:58-60), so with a fixed uniqueness
  // tuple the FIRST write wins forever: a later reason or category change
  // leaves knowledge_gap, research_requirement and metadata stale, and a row
  // somebody already RESOLVED stays resolved even though the blocker moved.
  //
  // The key therefore carries the classification. Prose changes deliberately
  // do NOT version it -- a wording tweak should not reopen a closed question --
  // but a support or category change does, because that is a different
  // question being asked of the owner.
  it('the same classification produces the same key, so re-running is still idempotent', () => {
    const first = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-09'), ...actor });
    const second = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-09'), ...actor });
    expect(second.sourceEntityId).toBe(first.sourceEntityId);
  });

  it('a different classification produces a different key', () => {
    const dataGap = buildFormulaBlockerResearchRequirement({
      blocker: { ...getFormulaBlocker('BF-09'), categories: ['DATA_GAP'] },
      ...actor,
    });
    const policy = buildFormulaBlockerResearchRequirement({
      blocker: { ...getFormulaBlocker('BF-09'), categories: ['POLICY_DECISION'] },
      ...actor,
    });
    expect(policy.sourceEntityId).not.toBe(dataGap.sourceEntityId);
  });

  it('an unclassified blocker becoming classified produces a different key', () => {
    // The case that matters most: "classify this" is answered, so the
    // requirement asking for it must not stay resolved over the new question.
    const unclassified = buildFormulaBlockerResearchRequirement({
      blocker: { ...getFormulaBlocker('BF-02'), categories: [] },
      ...actor,
    });
    const classified = buildFormulaBlockerResearchRequirement({
      blocker: { ...getFormulaBlocker('BF-02'), categories: ['INTEGRATION_GAP'] },
      ...actor,
    });
    expect(classified.sourceEntityId).not.toBe(unclassified.sourceEntityId);
  });

  it('the formula id is still recoverable from the key and the metadata', () => {
    const built = buildFormulaBlockerResearchRequirement({ blocker: getFormulaBlocker('BF-09'), ...actor });
    expect(built.sourceEntityId).toContain('BF-09');
    expect(built.metadata?.formula_id).toBe('BF-09');
  });

  it('a prose-only change does NOT version the key', () => {
    const original = getFormulaBlocker('BF-09');
    const reworded = buildFormulaBlockerResearchRequirement({
      blocker: { ...original, reasonVerbatim: `${original.reasonVerbatim ?? ''} (reworded)` },
      ...actor,
    });
    const built = buildFormulaBlockerResearchRequirement({ blocker: original, ...actor });
    expect(reworded.sourceEntityId).toBe(built.sourceEntityId);
  });
});
