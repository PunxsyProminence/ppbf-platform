// The strong_personalization gate, and the vocabulary that replaced a fake
// probability.
//
// The defect these pin: `strong_personalization` was a real flag with a real
// threshold, checked in the chat route around ONE prompt fragment. The request
// context -- carrying the same user's inferred communication style and their
// remembered facts -- was spliced into the same prompt with no check at all.
// The feature read as gated and was not.
//
// So the three cases the repair is judged on are behavioural, not structural:
// locked means absent, enabled means present, and re-locking an account that
// already has facts on disk means absent again. The third is the one that
// matters most -- it is the only one that fails if the gate is implemented as
// "stop writing facts" rather than "stop reading them".

import { buildShadowContext } from './shadowContextBuilder';
import type { ShadowContextBuilderInput } from './shadowContextBuilder';
import type { ShadowUserProfileRow } from './shadowUserProfile';
import {
  describeFactSupport,
  personalizationAllowed,
  REPEATED_OBSERVATION_MINIMUM,
  CONSISTENT_OBSERVATION_MINIMUM,
} from './shadowPersonalizationGate';
import type { ShadowUnlockState, ActivationMode } from './shadowUnlocks';

/** A profile carrying both things the gate governs. */
const PROFILE: ShadowUserProfileRow = {
  profile_id: 1,
  account_id: 'acct-gate',
  organization_id: 'org-gate',
  role: 'coach',
  interaction_count: 84,
  last_interaction_at: new Date().toISOString(),
  recent_topics: ['footwork', 'recovery'],
  athlete_ids_discussed: [],
  open_questions: [],
  remembered_facts: [
    {
      key: 'prefers_deep_analysis',
      value: 'true',
      confidence: 0.75,
      observationCount: 3,
      updatedAt: new Date().toISOString(),
    },
    {
      key: 'engaged_topic_footwork',
      value: 'true',
      confidence: 0.8,
      observationCount: 1,
      updatedAt: new Date().toISOString(),
    },
  ],
  communication_style: 'example-heavy',
  shadow_notes: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function contextFor(
  personalizationEnabled: boolean,
  overrides: Partial<ShadowContextBuilderInput> = {},
): string {
  return buildShadowContext({
    tier: 'heavy_bag',
    userProfile: PROFILE,
    userMessage: 'How should I structure tomorrow?',
    userRole: 'coach',
    organizationId: 'org-gate',
    personalizationEnabled,
    ...overrides,
  }).context;
}

/** An unlock state with `strong_personalization` in the given mode. */
function unlockState(mode: ActivationMode, satisfied: boolean): ShadowUnlockState {
  const status = {
    featureKey: 'strong_personalization' as const,
    unlocked: mode === 'enabled' && satisfied,
    activationMode: mode,
    satisfied,
    currentValue: satisfied ? 40 : 2,
    thresholdValue: 20,
    metricKey: 'user_high_quality_interactions' as const,
  };
  return {
    organizationId: 'org-gate',
    accountId: 'acct-gate',
    evaluatedAt: new Date().toISOString(),
    features: { strong_personalization: status } as ShadowUnlockState['features'],
  };
}

describe('the strong_personalization gate decides what reaches a prompt', () => {
  describe.each(['quick_round', 'heavy_bag'] as const)('%s tier', (tier) => {
    test('LOCKED: no inferred communication style and no remembered facts', () => {
      const context = contextFor(false, { tier });

      expect(context).not.toMatch(/communication preference/i);
      expect(context).not.toMatch(/answer format preference/i);
      expect(context).not.toMatch(/observed preferences/i);
      expect(context).not.toContain('prefers_deep_analysis');
      expect(context).not.toContain('engaged_topic_footwork');
      expect(context).not.toMatch(/example/i);
    });

    test('LOCKED: the authorization facts are still present', () => {
      // The gate withholds what was INFERRED about a person, not what the
      // request cannot be served without. A gate that also dropped the
      // authenticated role would make SHADOW less safe, not more private.
      const context = contextFor(false, { tier });

      expect(context).toContain('coach');
    });
  });

  test('ENABLED: both are present', () => {
    const context = contextFor(true);

    expect(context).toMatch(/answer format preference/i);
    expect(context).toMatch(/observed preferences/i);
    expect(context).toContain('prefers_deep_analysis');
  });

  test('RELOCKED with facts already on disk: absent again', () => {
    // The account earned personalization, facts were written, and the feature
    // was then put back into observation mode -- or the org lowered a
    // threshold, or an admin disabled it. The rows are still in the database
    // and must stay there; what changes is that nothing reads them into a
    // prompt.
    //
    // A gate implemented at the WRITE side (stop extracting facts) passes the
    // locked and enabled cases above and fails this one, which is why it is
    // here. Same profile, same stored facts, personalization off.
    const enabled = contextFor(true);
    expect(enabled).toContain('prefers_deep_analysis');

    const relocked = contextFor(false);

    expect(relocked).not.toContain('prefers_deep_analysis');
    expect(relocked).not.toContain('engaged_topic_footwork');
    expect(relocked).not.toMatch(/observed preferences/i);
    // And the profile object itself is untouched -- the facts were not deleted
    // to achieve the absence.
    expect(PROFILE.remembered_facts).toHaveLength(2);
  });
});

describe('personalizationAllowed resolves every activation mode', () => {
  test.each([
    ['disabled' as const, true],
    ['observation' as const, true],
    ['disabled' as const, false],
    ['observation' as const, false],
    ['enabled' as const, false],
  ])('%s mode, threshold satisfied=%s -> not allowed', (mode, satisfied) => {
    expect(personalizationAllowed(unlockState(mode, satisfied))).toBe(false);
  });

  test('enabled and satisfied -> allowed', () => {
    expect(personalizationAllowed(unlockState('enabled', true))).toBe(true);
  });

  test('a null unlock state is not allowed', () => {
    // The chat route evaluates unlock state with `.catch(() => null)`. A
    // database failure must not read as consent.
    expect(personalizationAllowed(null)).toBe(false);
  });
});

describe('fact support is ordinal, never a probability', () => {
  test('a single observation says so', () => {
    expect(describeFactSupport(1)).toBe('single observation');
  });

  test('repetition is what moves it', () => {
    expect(describeFactSupport(REPEATED_OBSERVATION_MINIMUM)).toBe('repeated');
    expect(describeFactSupport(CONSISTENT_OBSERVATION_MINIMUM)).toBe('consistent');
  });

  test('a fact written before counting existed reads as a single observation', () => {
    // The weakest reading, because one signal is all such a row evidences.
    expect(describeFactSupport(undefined)).toBe('single observation');
  });

  /* Impossible counts. These pin the OUTCOME -- an unreal number never
     describes itself as more support than it has -- and they are honest about
     what they do not prove: removing the Math.floor/Math.max clamp from
     describeFactSupport fails none of them, because `floor(x) >= n` equals
     `x >= n` for integer n and both minimums are integers. The clamp is
     documented defence against a future non-integer minimum; these cases are
     the behaviour, which holds either way. */
  test.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    'an impossible count (%p) reads as the weakest support, never more',
    (impossible) => {
      expect(describeFactSupport(impossible)).toBe('single observation');
    },
  );

  test('a fractional count never lands in a stronger band than its floor', () => {
    expect(describeFactSupport(CONSISTENT_OBSERVATION_MINIMUM - 0.1)).toBe('repeated');
    expect(describeFactSupport(REPEATED_OBSERVATION_MINIMUM - 0.1)).toBe('single observation');
  });

  test('no rendered fact carries a percentage or the word confidence', () => {
    // The specific regression: `- prefers_deep_analysis: true (confidence:
    // 75%)`. 0.75 was a literal in a switch statement, and rendering it this
    // way stated a calibrated probability that has never been computed --
    // there is no held-out set and no event whose frequency it estimates.
    const context = contextFor(true);

    expect(context).not.toMatch(/confidence/i);
    expect(context).not.toMatch(/\d+\s*%/);
    expect(context).toContain('support: repeated');
    expect(context).toContain('support: single observation');
  });
});

describe('interaction history is not expertise', () => {
  test('no novice/intermediate/expert grade is stated', () => {
    // 84 interactions used to make this coach an "expert" in the prompt. How
    // often someone opens a chat window evidences nothing about what they know
    // about a child in front of them.
    const context = contextFor(true, { tier: 'quick_round' });

    expect(context).not.toMatch(/\bexpertise\b/i);
    expect(context).not.toMatch(/\bnovice\b/i);
    expect(context).not.toMatch(/\bintermediate\b/i);
    expect(context).not.toMatch(/\bexpert\b/i);
  });

  test('the raw count survives, because it is true and unremarkable', () => {
    const context = contextFor(true, { tier: 'quick_round' });

    expect(context).toContain('84');
  });

  test.each([0, 5, 21, 51, 500])('%i interactions produces no grade', (count) => {
    const context = contextFor(true, {
      tier: 'quick_round',
      userProfile: { ...PROFILE, interaction_count: count },
    });

    expect(context).not.toMatch(/novice|intermediate|expert/i);
  });
});

describe('preference language, not learning-style claims', () => {
  test('example-heavy is stated as a preference about answers', () => {
    const context = contextFor(true, {
      tier: 'quick_round',
      userProfile: { ...PROFILE, communication_style: 'example-heavy' },
    });

    // What was observed: someone rated replies that opened with an example.
    expect(context).toMatch(/preferred answers that open with a concrete example/i);
  });

  test.each(['concise', 'detailed', 'example-heavy'] as const)(
    '%s makes no claim about how the person learns',
    (style) => {
      const context = contextFor(true, {
        tier: 'quick_round',
        userProfile: { ...PROFILE, communication_style: style },
      });

      // "Learns best through examples" is a learning-style claim: a contested
      // construct, no instrument behind it, and said about a child it
      // describes their mind rather than their last few clicks.
      expect(context).not.toMatch(/learns\b/i);
      expect(context).not.toMatch(/learning style/i);
    },
  );
});
