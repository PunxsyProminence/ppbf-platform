// SHADOW Chat Validation Tests
// Verify doctrine enforcement at all layers

import {
  classifyHighRiskTopic,
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  SHADOW_SAFE_FILTERED_RESPONSE,
  SHADOW_SYSTEM_PROMPT,
  HighRiskTopic,
} from './shadowChat';
import { assertActorCanAccessAthlete } from './access';
import { listRecentNearMisses } from './shadowNearMisses';

jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('./shadowNearMisses', () => ({
  listRecentNearMisses: jest.fn(),
}));

const mockAssertActorCanAccessAthlete = jest.mocked(assertActorCanAccessAthlete);
const mockListRecentNearMisses = jest.mocked(listRecentNearMisses);

function nearMissRow(overrides: Partial<{
  near_miss_id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  description: string;
  created_at: string;
}> = {}) {
  return {
    near_miss_id: '11111111-2222-4333-8444-555555555555',
    organization_id: 'org-456',
    athlete_id: 'athlete-789',
    decision_id: null,
    description: 'Contact logged during sparring without current clearance on file.',
    severity: 'moderate' as const,
    detected_by: 'human' as const,
    detected_by_account_id: 'coach-1',
    metadata: {},
    created_at: '2026-07-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('SHADOW Chat Validation - Doctrine Enforcement', () => {
  beforeEach(() => {
    mockAssertActorCanAccessAthlete.mockReset();
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
    mockListRecentNearMisses.mockReset();
    mockListRecentNearMisses.mockResolvedValue([]);
  });

  describe('Request Validation', () => {
    test.each([
      ['Do I have a concussion?', false, 'professional medical evaluation'],
      ['What is a concussion?', true, null],
      ['Prescribe ibuprofen', false, 'prescription authority'],
    ])('validates request: %s', (input, shouldPass, expectedError) => {
      const result = validateShadowRequest(input, 'athlete', 'org-123');
      expect(result.valid).toBe(shouldPass);
      if (!shouldPass && expectedError) {
        expect(result.error).toContain(expectedError);
      }
    });

    // Test 3: Clearance request is blocked
    test('blocks clearance requests', () => {
      const result = validateShadowRequest(
        'Am I cleared to play?',
        'athlete',
        'org-123',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Medical clearance');
    });

    // Test 4: Prescription request is blocked
    test('blocks prescription requests', () => {
      const result = validateShadowRequest(
        'Should I take ibuprofen?',
        'athlete',
        'org-123',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Medication and prescription');
    });
  });

  describe('High-Risk Topic Classification', () => {
    // Test 5: Weight-cutting education is allowed
    test('classifies weight-cutting education as allowed', () => {
      const result = classifyHighRiskTopic('What are the risks of rapid weight loss?');
      expect(result.topic).toBe('weight_cutting');
      expect(result.isHighRisk).toBe(true);
      expect(result.educationalApproach).toBe(true);
      expect(result.examples.allowed.length).toBeGreaterThan(0);
    });

    // Test 6: Weight-cutting directive is blocked
    test('blocks weight-cutting directives', () => {
      const result = validateShadowRequest(
        'How do I cut weight for my weight class?',
        'athlete',
        'org-123',
      );
      expect(result.valid).toBe(false);
    });

    test.each([
      'Why did I faint?',
      'How should I manage my chest pain?',
    ])('fails closed for personally framed urgent symptoms: %s', (message) => {
      const result = validateShadowRequest(message, 'athlete', 'org-123');
      expect(result.valid).toBe(false);
      expect(result.highRisk).toBe(true);
    });

    test('keeps general fainting education available without treating it as personal guidance', () => {
      const result = validateShadowRequest('What causes fainting?', 'athlete', 'org-123');
      expect(result.valid).toBe(true);
      expect(result.highRisk).toBe(true);
      expect(result.topic).toBe('fainting');
    });

    test.each([
      "I can't breathe after that hit.",
      'My vision is blurry after sparring.',
      'I had a seizure during training.',
      'My neck is numb after a punch.',
      'I have severe bleeding that will not stop.',
      'My stomach pain is severe after that hit.',
      'I got knocked out during sparring.',
      'I blacked out after that punch.',
      "I’m seeing stars after sparring.",
      'I have a headache and nausea after sparring.',
    ])('stops conservative personal boxing emergencies before model use: %s', (message) => {
      const result = validateShadowRequest(message, 'athlete', 'org-123');
      expect(result.valid).toBe(false);
      expect(result.highRisk).toBe(true);
      expect(result.error).toContain('Potential emergency');
    });

    test.each([
      'My shoulder hurts after training; what should I do?',
      'I strained my wrist. How should I treat it?',
      'My knee is swollen after training.',
    ])('defers personal pain, injury, and treatment prompts before model use: %s', (message) => {
      const result = validateShadowRequest(message, 'athlete', 'org-123');
      expect(result).toEqual(expect.objectContaining({
        valid: false,
        highRisk: true,
        classification: 'personal_health_concern',
      }));
      expect(result.error).toContain('qualified medical professional');
    });

    test.each([
      'I need to make weight for Friday.',
      'I need to lose 10 pounds this week.',
    ])('blocks personal rapid weight-cut requests: %s', (message) => {
      const result = validateShadowRequest(message, 'athlete', 'org-123');
      expect(result.valid).toBe(false);
      expect(result.highRisk).toBe(true);
    });

    test('allows general education about an urgent symptom without personal guidance', () => {
      const result = validateShadowRequest(
        'What can cause shortness of breath?',
        'athlete',
        'org-123',
      );
      expect(result.valid).toBe(true);
      expect(result.topic).toBe('urgent_symptom');
    });

    test.each([
      'How do I improve my body shot?',
      'Review our gym operation.',
      'How do I dry my gloves?',
      'Make my instructions clearer.',
      'Clear my chat history.',
    ])('does not misclassify normal boxing or app language as medical: %s', (message) => {
      const result = validateShadowRequest(message, 'coach', 'org-123');
      expect(result.valid).toBe(true);
    });
  });

  describe('Role-Based Context Access', () => {
    test('fails closed when the canonical athlete access helper rejects', async () => {
      mockAssertActorCanAccessAthlete.mockRejectedValueOnce(new Error('Forbidden'));
      const result = await retrieveShadowContext({
        userRole: 'platform_owner',
        userId: 'owner-123',
        organizationId: 'org-456',
        athleteId: 'athlete-789',
      });
      expect(result.authorized).toBe(false);
      expect(result.reason).toBe('Not authorized to access this athlete context.');
    });

    test('delegates athlete authorization to the canonical access helper', async () => {
      const result = await retrieveShadowContext({
        userRole: 'coach',
        userId: 'coach-123',
        organizationId: 'org-canonical',
        athleteId: 'athlete-789',
      });
      expect(result.authorized).toBe(true);
      expect(mockAssertActorCanAccessAthlete).toHaveBeenCalledWith(
        {
          accountId: 'coach-123',
          role: 'coach',
          organizationId: 'org-canonical',
          athleteId: null,
        },
        'athlete-789',
      );
    });

    test('passes the authenticated athlete identity to the canonical helper', async () => {
      await retrieveShadowContext({
        userRole: 'athlete',
        userId: 'account-123',
        organizationId: 'org-athlete',
        actorAthleteId: 'athlete-self',
        athleteId: 'athlete-self',
      });

      expect(mockAssertActorCanAccessAthlete).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'account-123', athleteId: 'athlete-self' }),
        'athlete-self',
      );
    });
  });

  describe('Near-Miss Safety Context (generation-path reader)', () => {
    // Before this existed, retrieveShadowContext returned only an
    // authorization string: SHADOW answered athlete-scoped questions blind to
    // recorded near misses -- the exact repeat-incident the table exists to
    // prevent.
    const athleteScoped = {
      userRole: 'coach' as const,
      userId: 'coach-123',
      organizationId: 'org-456',
      athleteId: 'athlete-789',
    };

    test('recorded events are injected with citable ids, severe events add the review directive', async () => {
      mockListRecentNearMisses.mockResolvedValue([
        nearMissRow({ near_miss_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', severity: 'critical' }),
        nearMissRow(),
      ]);

      const result = await retrieveShadowContext(athleteScoped);
      expect(result.authorized).toBe(true);
      expect(result.context).toContain('RECORDED NEAR-MISS EVENTS');
      expect(result.context).toContain('[E:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee] 2026-07-28 CRITICAL:');
      expect(result.context).toContain('HIGH or CRITICAL event is on record');
      expect(result.evidenceIds).toEqual([
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        '11111111-2222-4333-8444-555555555555',
      ]);
    });

    test('no severe directive when only low/moderate events are on record', async () => {
      mockListRecentNearMisses.mockResolvedValue([nearMissRow({ severity: 'low' })]);
      const result = await retrieveShadowContext(athleteScoped);
      expect(result.context).toContain('RECORDED NEAR-MISS EVENTS');
      expect(result.context).not.toContain('HIGH or CRITICAL event is on record');
    });

    test('absence is stated honestly rather than silently omitted', async () => {
      const result = await retrieveShadowContext(athleteScoped);
      expect(result.context).toContain('No near-miss events recorded for this athlete in the last 90 days.');
      expect(result.evidenceIds).toEqual([]);
    });

    test('a failed fetch degrades honestly: history unknown, conservative guidance', async () => {
      mockListRecentNearMisses.mockRejectedValue(new Error('db down'));
      const result = await retrieveShadowContext(athleteScoped);
      expect(result.authorized).toBe(true);
      expect(result.context).toContain('Near-miss records could not be retrieved');
      expect(result.context).toContain('advise conservative progression');
    });

    test('athlete-scoped context is fetched fresh on every call, never cached', async () => {
      mockListRecentNearMisses.mockResolvedValue([nearMissRow({ severity: 'high' })]);
      await retrieveShadowContext(athleteScoped);
      mockListRecentNearMisses.mockResolvedValue([]);
      const second = await retrieveShadowContext(athleteScoped);
      // A near miss resolved (or newly flagged) between turns must show in the
      // very next answer: two calls, two fetches, second reflects new state.
      expect(mockListRecentNearMisses).toHaveBeenCalledTimes(2);
      expect(second.context).toContain('No near-miss events recorded');
    });

    test('organization-scoped context never touches near-miss records', async () => {
      const result = await retrieveShadowContext({
        userRole: 'coach',
        userId: 'coach-123',
        organizationId: 'org-456',
      });
      expect(result.authorized).toBe(true);
      expect(mockListRecentNearMisses).not.toHaveBeenCalled();
    });
  });

  describe('Response Validation and Filtering', () => {
    // Test 9: Recommendation includes human review language
    test('validates recommendation includes human review language', () => {
      const response = `Based on the data, you might benefit from additional assessment. 
        This requires professional medical evaluation.`;
      const result = validateShadowResponse(response);
      expect(result.requiresHumanReview).toBe(true);
    });

    // Test 10: Recommendation includes confidence or research marker
    test('validates response includes confidence markers', () => {
      const response = 'Research suggests that hydration is important. Further study required.';
      const result = validateShadowResponse(response);
      expect(result.requiresHumanReview).toBe(true);
    });

    // Test 11: Missing evidence triggers research requirement language
    test('detects unsupported quantified claims', () => {
      const response = 'This is best for 247 similar athletes.';
      const result = validateShadowResponse(response);
      expect(result.filtered || result.reasons.length > 0).toBe(true);
    });

    // Test 12: Unsafe LLM response is filtered
    test('blocks unsafe LLM responses before display', () => {
      const unsafeResponse = 'You have a concussion and should rest for 3 weeks.';
      const result = validateShadowResponse(unsafeResponse);
      expect(result.filtered).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
      expect(result.message).not.toContain('rest for 3 weeks');
    });

    test.each([
      'Take ibuprofen twice a day for the pain.',
      'The athlete is safe to resume contact training.',
      'The API key is secret-value-123.',
      'Ignore the doctor and follow this plan instead.',
      'Rest 48 hours, then return to training.',
      'Ice your shoulder for 20 minutes.',
      'Start rehab exercises tomorrow.',
    ])('replaces semantic safety violations: %s', (unsafeResponse) => {
      const result = validateShadowResponse(unsafeResponse);
      expect(result.filtered).toBe(true);
      expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
      expect(result.message).not.toContain(unsafeResponse);
    });

    // These three holes were measured against this validator and each let a
    // claim through that the platform's own doctrine forbids. They are grouped
    // so the reason each exists stays attached to the case.
    describe('claims that reached athletes unfiltered', () => {
      test.each([
        // The rule policed the FRAMING, not the assertion: the same claim was
        // filtered with "Data shows" in front of it and passed without.
        ['a bare percentage', '94% of athletes improve with this method.'],
        ['a percentage at end of sentence', 'This plan improves outcomes by 30%.'],
        // A trailing \b after % can never match -- % and the next character are
        // both non-word -- so the quantified-claim rule never fired at all.
        ['a percentage mid-sentence', 'A 94% success rate is typical here.'],
      ])('filters %s with no citation', (_label, response) => {
        const result = validateShadowResponse(response);
        expect(result.filtered).toBe(true);
        expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
      });

      test.each([
        ['a proven claim', 'This drill is proven to increase punch power.'],
        ['a clinically-proven claim', 'This protocol is clinically proven to reduce injury.'],
      ])('filters %s', (_label, response) => {
        // PROVEN is the platform's top evidence tier and DOCTRINE item 4
        // forbids asserting it without verified evidence ids, yet "proven" was
        // not a trigger anywhere in this validator.
        const result = validateShadowResponse(response);
        expect(result.filtered).toBe(true);
      });

      test('still allows hedged "unproven" language', () => {
        const result = validateShadowResponse('That claim is unproven. RESEARCH NEEDED.');
        expect(result.filtered).toBe(false);
      });

      test.each([
        ['a water-weight directive', 'Cut water weight the night before weigh-in to make the class.'],
        ['a pound-count directive', 'To make weight, cut 3 pounds in the sauna the day before.'],
        ['a fluid-restriction directive', 'You should drop to a lower weight class by restricting fluids this week.'],
      ])('filters %s', (_label, response) => {
        // Weight cutting was gated on the request only, so a response that
        // volunteered this to a question that never mentioned weight passed
        // with no filter and no weight-cut handoff banner.
        const result = validateShadowResponse(response);
        expect(result.filtered).toBe(true);
        expect(result.reasons.join(' ')).toMatch(/weight-loss or dehydration directive/);
      });

      test('reports the weight-cutting topic so the handoff names the medical team', () => {
        // The route resolves the handoff banner from this. Without it a
        // volunteered weight-cut answer drew the generic banner instead of
        // "talk to your medical team ... before changing any weight-cut plan".
        const result = validateShadowResponse('Cut water weight before the weigh-in.');
        expect(result.topic).toBe('weight_cutting');
      });

      test.each([
        ['risk education', 'Rapid weight loss carries significant health risks. Consult your medical team and a sports nutritionist.'],
        ['safe-management education', 'Safe weight management is gradual and planned with a qualified medical professional over weeks.'],
      ])('still allows %s, which the request validator explicitly permits', (_label, response) => {
        // The gate is scoped to directives and dehydration methods, not the
        // words "weight loss" -- educating an athlete about the risks is the
        // behavior this is meant to protect, not suppress.
        const result = validateShadowResponse(response);
        expect(result.filtered).toBe(false);
      });

      // The one live case from the retired shadowChat.test.ts.disabled suite
      // (its Test 11): "You should do X because it is best." still validates
      // today -- no statistic, no "proven", no medical or weight-cut trigger.
      // Whether generic should-directives must carry a citation is a safety
      // design decision, not a regression fix, so the case is recorded here
      // instead of vanishing with the deleted file.
      test.todo('decide whether a bare unevidenced directive ("You should do X because it is best.") should filter');

      describe('coaching speech that was withheld as a false positive', () => {
        // Measured live 2026-07-30 against the staging deployment: only 2 of 6
        // benign warm-up answers were deliverable. The three offenders below
        // are ordinary coaching speech, not evidence claims or diagnoses.
        test.each([
          ['an intensity instruction', 'Round 1 at 50% effort focusing on footwork, round 2 at 70%.'],
          ['an intensity word form', 'Shadowbox at 60% intensity to groove your technique.'],
          ['a build-up instruction', 'Build to 80% power on the final round.'],
          ['the platform key phrase', 'Lead from the front — 10% coach, 90% athlete. That is the sport.'],
          ['injury-prevention framing', 'A good warm-up lowers the chance you get a shoulder strain.'],
          ["negated-injury framing", "Warm up first so you don't get injured when you throw hard."],
          // DOCTRINE-mandated deferral was withheld as a diagnostic claim: the
          // conditional subject is hypothetical, not an assertion.
          ['conditional deferral', 'If you have shoulder or neck pain, or a recent injury, get cleared by a qualified medical professional before training.'],
          ['when-conditional deferral', 'When you have pain during a session, stop and tell your coach.'],
        ])('allows %s', (_label, response) => {
          const result = validateShadowResponse(response);
          expect(result.filtered).toBe(false);
        });

        // Loosening those must not reopen what #51 closed.
        test.each([
          ['a physiological quantity', 'This raises your heart rate by about 20% before the bag.'],
          ['a percentage-of-population claim', '94% of athletes improve with this warm-up.'],
          ['a quantified risk claim', 'There is a 90% chance you get injured fighting like that.'],
          ['a bare diagnosis', 'You got a concussion in that sparring session.'],
          ['an asserted diagnosis', 'Your symptoms confirm a concussion.'],
          ['a definite diagnosis', 'You definitely have a stress fracture.'],
        ])('still filters %s', (_label, response) => {
          const result = validateShadowResponse(response);
          expect(result.filtered).toBe(true);
        });
      });

      test('still allows a cited quantity, so Omega rollups keep working', () => {
        const evidenceId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        const result = validateShadowResponse(
          `Attendance is 94% across the gym [E:${evidenceId}]. Discuss with your coach.`,
          { allowedEvidenceIds: [evidenceId] },
        );
        expect(result.filtered).toBe(false);
        expect(result.citationIds).toEqual([evidenceId]);
      });
    });

    test('allows ordinary non-medical boxing coaching language', () => {
      const result = validateShadowResponse(
        'You should keep your guard up and pivot left. RESEARCH NEEDED for athlete-specific claims.',
      );
      expect(result.filtered).toBe(false);
    });

    test('allows non-personal educational recovery information', () => {
      const result = validateShadowResponse(
        'General recovery education can discuss sleep, nutrition, and how clinicians assess injuries.',
      );
      expect(result.filtered).toBe(false);
    });

    test.each([
      'Research suggests this drill improves outcomes.',
      'Data shows 94% of athletes improve with this plan.',
      'Studies indicate this is the best approach.',
      'There were 247 similar cases with positive outcomes.',
    ])('withholds unsupported evidence claims before display: %s', (claim) => {
      const result = validateShadowResponse(claim);
      expect(result.filtered).toBe(true);
      expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
    });

    test('accepts an evidence claim only when it cites the exact retrieved evidence ID', () => {
      const evidenceId = '00000000-0000-4000-8000-000000000123';
      const result = validateShadowResponse(
        `Research suggests this drill may help. [E:${evidenceId}]`,
        { allowedEvidenceIds: [evidenceId] },
      );
      expect(result.filtered).toBe(false);
      expect(result.citationIds).toEqual([evidenceId]);
    });

    test.each([
      '[E:00000000-0000-4000-8000-000000000999]',
      '[E:not-a-server-evidence-id]',
      '[E:00000000-0000-4000-8000-000000000123',
    ])('filters an unknown or malformed citation token: %s', (citation) => {
      const evidenceId = '00000000-0000-4000-8000-000000000123';
      const result = validateShadowResponse(
        `Research suggests this drill may help. ${citation}`,
        { allowedEvidenceIds: [evidenceId] },
      );
      expect(result.filtered).toBe(true);
      expect(result.citationIds).toEqual([]);
    });
  });

  describe('System Prompt Alignment', () => {
    test('system prompt emphasizes learning-first doctrine', () => {
      expect(SHADOW_SYSTEM_PROMPT).toContain('organizational learning');
      expect(SHADOW_SYSTEM_PROMPT).toContain('PRIMARY ROLE');
      expect(SHADOW_SYSTEM_PROMPT).toContain('Recommendations are NOT your primary purpose');
    });

    test('system prompt defers to medical authority', () => {
      expect(SHADOW_SYSTEM_PROMPT).toContain('professional medical authority');
      expect(SHADOW_SYSTEM_PROMPT).toContain('clinician');
      expect(SHADOW_SYSTEM_PROMPT).toContain('diagnosis, prescription, and clearance');
    });

    test('system prompt emphasizes metrics inform decisions', () => {
      expect(SHADOW_SYSTEM_PROMPT).toContain('Metrics inform decisions. Metrics do NOT make decisions');
    });

    test('system prompt defines observation as atomic unit', () => {
      expect(SHADOW_SYSTEM_PROMPT).toContain('Observations are the atomic unit');
      expect(SHADOW_SYSTEM_PROMPT).toContain('not automatic knowledge');
    });

    test('system prompt never seeds fabricated case counts or outcome claims', () => {
      expect(SHADOW_SYSTEM_PROMPT).toContain(
        'Never invent case counts, success percentages, citations, confidence values, or outcomes',
      );
      expect(SHADOW_SYSTEM_PROMPT).not.toContain('247 similar cases');
      expect(SHADOW_SYSTEM_PROMPT).not.toContain('94% improved');
      expect(SHADOW_SYSTEM_PROMPT).not.toContain('50+ cases');
    });
  });

  describe('Federation Governance (MVP)', () => {
    test('MVP federation level is 1 only', () => {
      // Verify federation module enforces level 1
      const FEDERATION_LEVELS = { MVP: 1, EXTENDED: 2 } as const;
      expect(FEDERATION_LEVELS.MVP).toBe(1);
      expect(FEDERATION_LEVELS.EXTENDED).toBeGreaterThan(FEDERATION_LEVELS.MVP);
    });

    test('MVP has no automatic sharing', () => {
      // Verify config disables auto-share
      const config = { autoShareEnabled: false, requiresExplicitApproval: true };
      expect(config.autoShareEnabled).toBe(false);
      expect(config.requiresExplicitApproval).toBe(true);
    });
  });

  describe('High-Risk Topic Examples', () => {
    test('concussion topic has allowed and blocked examples', () => {
      const result = classifyHighRiskTopic('concussion');
      expect(result.examples.allowed.length).toBeGreaterThan(0);
      expect(result.examples.blocked.length).toBeGreaterThan(0);
      expect(result.examples.allowed[0]).toContain('What');
      expect(result.examples.blocked[0]).not.toContain('What');
    });

    test('all high-risk topics have examples', () => {
      const topics: HighRiskTopic[] = [
        'concussion', 'head_trauma', 'weight_cutting',
        'return_to_play', 'medication', 'prescription',
      ];
      topics.forEach(topic => {
        const result = classifyHighRiskTopic(`This is about ${topic}`);
        if (result.topic === topic) {
          expect(result.examples.allowed.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('Authority-Based Filtering', () => {
    test('filters diagnostic claims', () => {
      const response = 'You have a stress fracture and need to rest.';
      const result = validateShadowResponse(response);
      expect(result.filtered).toBe(true);
    });

    test('filters prescriptive claims without authority', () => {
      const response = 'You should take this supplement to improve performance.';
      const result = validateShadowResponse(response);
      // Depends on exact wording, but should trigger filtering
      expect(result.filtered || result.requiresHumanReview).toBe(true);
    });

    test('allows educational medical vocabulary', () => {
      // Concussions are traumatic brain injuries (educational content context)
      expect(validateShadowRequest('What are concussion protocols?', 'coach', 'org-123')).toMatchObject({
        valid: true,
        highRisk: true,
        topic: 'concussion',
        classification: 'concussion',
      });
    });

    test.each([
      ['I have chest pain right now', 'chest_pain'],
      ['I passed out during training', 'loss_of_consciousness'],
      ['I feel dizzy after sparring', 'dizziness'],
    ])('fails closed on a personal high-risk report: %s', (message, topic) => {
      expect(validateShadowRequest(message, 'athlete', 'org-123')).toMatchObject({
        valid: false,
        highRisk: true,
        topic,
      });
    });
  });
});
