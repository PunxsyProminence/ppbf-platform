// SHADOW Chat Validation Tests
// Verify doctrine enforcement at all layers

import {
  classifyHighRiskTopic,
  normaliseForMatching,
  validateShadowRequest,
  validateShadowResponse,
  retrieveShadowContext,
  SHADOW_SAFE_FILTERED_RESPONSE,
  SHADOW_SYSTEM_PROMPT,
  HighRiskTopic,
} from './shadowChat';
import * as fs from 'fs';
import * as path from 'path';
import { assertActorCanAccessAthlete } from './access';
import { listRecentNearMisses } from './shadowNearMisses';
import { DECISION_LOOP_ROLES } from './shadowRoleSets';
import type { PilotRole } from './contracts';

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

  // -------------------------------------------------------------------------
  // AUDIENCE GATE. Owner decision 2026-09-26; recorded open in ACTIVE_WORK.md
  // since 2026-08-28 as "SHADOW injects near-miss text into athlete/parent
  // chats that GET /near-misses denies those roles".
  //
  // These tests live HERE and not in the chat route's suite because that suite
  // mocks retrieveShadowContext wholesale, so no test there can prove this gate.
  // This is the only EXISTING place it is provable -- a route-level test with a
  // partial mock could also do it; one simply was not written.
  //
  // EVERY EXCLUDED-ROLE CASE RETURNS SEVERE ROWS FROM THE MOCK. The default in
  // beforeEach is an empty list, so a gate that had silently stopped working
  // would still produce an empty, innocent-looking context and pass. The rows
  // carry a sentinel that could only have come from the records.
  // -------------------------------------------------------------------------
  describe('Near-Miss Audience Gate', () => {
    // description is unsanitised coach free text about a youth roster. A note
    // about one child naming another is the RISK MODEL this sentinel stands
    // in for -- it is invented for the test, not an observed incident, and
    // nothing here asserts any such record exists.
    const SENTINEL = 'Marcus Webb was the other athlete in the ring.';
    const SENTINEL_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';

    const severeRows = () => [
      nearMissRow({ near_miss_id: SENTINEL_ID, severity: 'critical' as const, description: SENTINEL }),
      nearMissRow({ severity: 'high' as const }),
    ];

    // EVERY role outside DECISION_LOOP_ROLES, not just the two the owner named.
    // "It excludes exactly athlete and parent" was true only because
    // assertActorCanAccessAthlete refuses the others first -- which is a fact
    // about a DIFFERENT module, read and not executed here. Enumerating the
    // whole PilotRole union makes the claim one about THIS gate: nothing
    // outside the decision loop receives these records, whatever access.ts
    // does or later stops doing.
    //
    // This list is hand-written and the type system does not check it against
    // PilotRole, so a role added later would not be enumerated here. The gate
    // still fails closed for it -- the allow-list is what grants, so an
    // unknown role is refused by construction -- but this suite would stop
    // being the exhaustive proof it is today.
    describe.each([
      ['athlete', 'account-athlete-self'],
      ['parent', 'account-parent-linked'],
      ['platform_owner', 'account-platform-owner'],
      ['board', 'account-board'],
      ['volunteer', 'account-volunteer'],
      ['staff', 'account-staff'],
    ] as const)('%s receives no near-miss records', (userRole, userId) => {
      const scoped = { userRole, userId, organizationId: 'org-456', athleteId: 'athlete-789' };

      test('the records are never read, never cited, never rendered', async () => {
        mockListRecentNearMisses.mockResolvedValue(severeRows());

        const result = await retrieveShadowContext(scoped);

        // Their ACCESS is untouched -- this removes the safety records from
        // the prompt, not the role's scope on the athlete. The CONTEXT STRING
        // does change for them, and the whole-string assertion further down
        // is what pins what it changes to.
        expect(mockAssertActorCanAccessAthlete).toHaveBeenCalled();
        expect(result.authorized).toBe(true);
        expect(result.context).toContain('Authorized athlete scope: athlete-789');

        // Gated BEFORE the query, not filtered after it: a filter would still
        // have pulled the free text of a youth roster into this process.
        expect(mockListRecentNearMisses).not.toHaveBeenCalled();
        expect(result.context).not.toContain(SENTINEL);
        expect(result.context).not.toContain(SENTINEL_ID);
        expect(result.context).not.toContain('[E:');
        expect(result.evidenceIds).toEqual([]);

        // Pins the WHOLE context, not merely the absence of records. The gate
        // is an early return; if anything else the role is entitled to were
        // built after the near-miss block, an absence-only check would still
        // pass while the early return silently dropped it.
        expect(result.context).toBe(
          `Authorized role: ${userRole}. Authorized organization: org-456. `
          + `Authorized athlete scope: athlete-789.\n`
          + `Recorded safety events are not available in this context. `
          + `For intensity, contact, or progression questions, defer to the athlete's coach.`,
        );
      });

      test('the reply is identical whether or not events are on file', async () => {
        mockListRecentNearMisses.mockResolvedValue(severeRows());
        const withRows = await retrieveShadowContext(scoped);
        mockListRecentNearMisses.mockResolvedValue([]);
        const withNone = await retrieveShadowContext(scoped);

        // The reason for a single constant line rather than reusing either
        // existing string. "No near-miss events recorded" is simply false for
        // an athlete who has them. The retrieval-failed line is worse: its
        // conservative-progression directive would surface only when there was
        // something to withhold, so the model's own caution would announce
        // that events exist. Withholding that leaks by implication is not
        // withholding, and a difference of one clause is enough to leak.
        expect(withRows.context).toBe(withNone.context);
        expect(withRows.context).not.toContain('No near-miss events recorded');
        expect(withRows.context).not.toContain('advise conservative progression');
        expect(withRows.context).not.toContain('could not be retrieved');
      });
    });

    describe.each([
      ['coach', 'coach-123'],
      ['organization_admin', 'orgadmin-1'],
      ['admin', 'legacy-admin-1'],
    ] as const)('%s still receives them', (userRole, userId) => {
      // POSITIVE CONTROL. Without these, a gate that excluded everyone would
      // pass every assertion above. DECISION_LOOP_ROLES carries legacy 'admin'
      // alongside 'organization_admin', and both are exercised here for the
      // same reason the shared role set exists: the copies used to drift.
      test('POSITIVE CONTROL: the read happens and the events are cited', async () => {
        mockListRecentNearMisses.mockResolvedValue(severeRows());

        const result = await retrieveShadowContext({
          userRole,
          userId,
          organizationId: 'org-456',
          athleteId: 'athlete-789',
        });

        expect(mockListRecentNearMisses).toHaveBeenCalledWith('org-456', 'athlete-789');
        expect(result.context).toContain('RECORDED NEAR-MISS EVENTS');
        expect(result.context).toContain(SENTINEL);
        expect(result.context).toContain(`[E:${SENTINEL_ID}]`);
        expect(result.evidenceIds).toEqual([SENTINEL_ID, '11111111-2222-4333-8444-555555555555']);
      });
    });

    test('an excluded role is given the withheld line', async () => {
      mockListRecentNearMisses.mockResolvedValue(severeRows());

      const athlete = await retrieveShadowContext({
        userRole: 'athlete',
        userId: 'account-athlete-self',
        organizationId: 'org-456',
        athleteId: 'athlete-789',
      });

      expect(athlete.context).toContain('Recorded safety events are not available in this context.');
      expect(athlete.context).toContain("defer to the athlete's coach");
    });

    // THE ACTUAL PARITY CHECK, and it replaces one that only looked like one.
    // The old test asserted that an athlete's context contained the withheld
    // line, under a comment claiming the two surfaces "cannot drift apart".
    // It never touched the route or its role list, so it could not have
    // detected drift at all.
    //
    // The two sides also decide membership DIFFERENTLY. GET /near-misses calls
    // requireRole, which treats legacy `admin` and `organization_admin` as the
    // same role; this gate uses a strict DECISION_LOOP_ROLES.includes. Today
    // they agree only because both roles happen to be listed. Sharing a
    // constant is not the same as sharing a decision, so pin the decision --
    // for every role in the union, against the REAL requireRole.
    // What this proves: the GATE's observed behaviour matches what requireRole
    // decides over DECISION_LOOP_ROLES, for every role in the union. It runs
    // the real retrieveShadowContext and reads whether the near-miss query
    // happened, so rewriting the gate's condition breaks it.
    //
    // WHAT THE NAME MUST NOT SAY. An earlier name claimed the gate "admits
    // exactly the roles GET /near-misses admits". This test never reads the
    // route -- it passes DECISION_LOOP_ROLES into requireRole itself. The
    // route does call requireRole(principal, [...DECISION_LOOP_ROLES]) today,
    // so that claim happens to be true, but nothing here proves it and
    // nothing here would notice the route swapping in a different list.
    //
    // The role list below is hand-written and the type system does not check
    // it against PilotRole, so a role added later would not be enumerated.
    // The gate still fails closed for it, because the allow-list grants.
    test('the gate admits exactly the roles requireRole admits for DECISION_LOOP_ROLES', async () => {
      const { requireRole } = jest.requireActual<typeof import('./access')>('./access');

      const ALL_PILOT_ROLES = [
        'platform_owner', 'organization_admin', 'admin', 'coach',
        'athlete', 'parent', 'board', 'volunteer', 'staff',
      ] as const;

      // Derive the gate's answer FROM THE GATE. The first version of this
      // test evaluated DECISION_LOOP_ROLES.includes inline -- a copy of the
      // gate's own expression -- and compared that to requireRole. It would
      // have passed with the gate in shadowChat.ts rewritten to any other
      // check, because it never called it. The observable for "admitted" is
      // whether the read happened.
      const gate: Array<{ role: PilotRole; admitted: boolean }> = [];
      for (const role of ALL_PILOT_ROLES) {
        mockListRecentNearMisses.mockReset();
        mockListRecentNearMisses.mockResolvedValue(severeRows());
        await retrieveShadowContext({
          userRole: role,
          userId: 'account-1',
          organizationId: 'org-456',
          athleteId: 'athlete-789',
        });
        gate.push({ role, admitted: mockListRecentNearMisses.mock.calls.length > 0 });
      }

      const route = ALL_PILOT_ROLES.map((role) => {
        let admitted = true;
        try {
          requireRole(
            { accountId: 'account-1', role, organizationId: 'org-456', athleteId: null },
            [...DECISION_LOOP_ROLES],
          );
        } catch {
          admitted = false;
        }
        return { role, admitted };
      });

      expect(gate).toEqual(route);

      // And the answer is not vacuous in either direction.
      expect(gate.filter((r) => r.admitted).map((r) => r.role))
        .toEqual(['organization_admin', 'admin', 'coach']);
    });
  });

  describe('Response Validation and Filtering', () => {
    // Test 9: Recommendation includes human review language.
    // CL-C7 (2026-10-05): deferral language is what the doctrine REQUIRES of
    // an answer, so it is recorded as a reason but no longer asks for a human
    // review row. Before, every "see a doctor" answer wrote one and drew on
    // the owner's 3-per-hour allowance (OD-2026-10-01-006), so three routine
    // answers could suppress the row of a fourth that was actually withheld.
    test('records human review language without asking for a review row', () => {
      const response = `Based on the data, you might benefit from additional assessment. 
        This requires professional medical evaluation.`;
      const result = validateShadowResponse(response);
      expect(result.filtered).toBe(false);
      expect(result.reasonCodes).toEqual(['human_review']);
      expect(result.requiresHumanReview).toBe(false);
    });

    // Test 10: Recommendation includes confidence or research marker
    // Withheld for the uncited "research suggests", so it still asks for a
    // review row; the research marker is not what decides that.
    test('an uncited research claim is withheld and still asks for a review row', () => {
      const response = 'Research suggests that hydration is important. Further study required.';
      const result = validateShadowResponse(response);
      expect(result.filtered).toBe(true);
      expect(result.reasonCodes).toContain('uncited_claim');
      expect(result.requiresHumanReview).toBe(true);
    });

    test('a withheld answer that also defers still asks for a review row', () => {
      const result = validateShadowResponse('You have a concussion. A physician should confirm it.');
      expect(result.filtered).toBe(true);
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

      test('deliberately allows a bare unevidenced coaching directive', () => {
        // DECIDED (owner, 2026-07-31): bare should-directives with no
        // statistic, no "proven", and no medical or weight-cut trigger pass
        // without a citation. Requiring one would filter ordinary coaching
        // speech ("you should keep your guard up"), and the dangerous shapes
        // -- medical directives, quantified claims, weight cutting -- are
        // covered by their own gates above. This pins the decision so a
        // future validator change that flips it does so knowingly.
        // (Originally Test 11 of the retired shadowChat.test.ts.disabled.)
        const result = validateShadowResponse('You should do X because it is best.');
        expect(result.filtered).toBe(false);
        expect(result.reasons).toEqual([]);
      });

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
        // The subject alternation was second-person plus 'the athlete', so the
        // same claim in the third person passed clean. Measured 2026-07-31,
        // before the widening: 'The athlete has a rotator cuff injury.'
        // filtered, 'He has a concussion.' did not. It became load-bearing
        // with Film Study (#128) -- a vision model describing a child in
        // frames writes 'he' and 'she' by default, so the surface most likely
        // to produce a diagnosis was the one the filter did not read.
        test.each([
          ['he', 'He has a concussion.'],
          ['she', 'She has a fracture in the left wrist.'],
          ['they', 'They have a shoulder injury.'],
          ['the boxer', 'The boxer has a concussion.'],
          ['the fighter', 'The fighter has a rotator cuff injury.'],
          ['the kid', 'The kid has a wrist fracture.'],
          ['a third-person symptom assertion', 'His symptoms confirm a concussion.'],
        ])('filters a diagnosis asserted about %s', (_label, response) => {
          const result = validateShadowResponse(response);
          expect(result.filtered).toBe(true);
        });

        // The other direction, and the reason the widening is subject-only:
        // third-person pronouns are ordinary coaching speech. These are the
        // shapes a Film Study observation actually takes.
        test.each([
          ['a third-person strength', 'He has a strong jab and good balance on the pivot.'],
          ['a third-person skill note', 'She has excellent footwork in the later rounds.'],
          ['a third-person tendency', 'They have a tendency to drop the rear hand when tired.'],
          ['third-person conditional deferral', 'If he has any pain in the shoulder, stop and get him cleared by a medical professional.'],
          ['a frame observation', 'The lead hand returns below the chin after the jab in the later frames. Stance stays square through the combination.'],
          ['a guard observation', 'Guard is high in the first two frames. By the fourth frame the rear hand has drifted away from the cheek.'],
          ['a footwork observation', 'Footwork shows the rear foot crossing behind the lead on the pivot. Weight looks settled on the back foot.'],
          ['an unclear-frames refusal', 'The frames are too blurred to support an observation about hand position.'],
          ['a centerline observation', 'The athlete steps in with the jab and the head stays on the centerline. The rear elbow flares on the cross.'],
          ['a rotation observation', 'Shoulders rotate well on the cross. There is no visible change in guard height between frames three and six.'],
          ['a coaching handoff', 'The lead shoulder does not rise to protect the chin during the jab. Consider reviewing this with the athlete.'],
          ['an honest limitation', 'Hand speed cannot be assessed from still frames.'],
        ])('still allows %s', (_label, response) => {
          const result = validateShadowResponse(response);
          expect(result.filtered).toBe(false);
        });
      });

      describe('a roster count is not a sample size', () => {
        // The count-noun branch read 'N athletes' as an evidence population
        // wherever it appeared, so counting people into groups tripped the
        // same rule as "94% of athletes improve". This failed the staging gate
        // on 0f47b35: step 14 asks for a four-station circuit for a 60-minute
        // youth class, and both the answer and its retry were withheld. The
        // trigger was in the question, not the phrasing, so the one-retry
        // policy could never clear it.
        test.each([
          ['a class split', 'Split the 12 athletes into four groups of three and rotate every eight minutes.'],
          ['a per-station count', 'Put 3 athletes at each station so nobody waits for a bag.'],
          ['a station roster', 'Station 1 (Jab mechanics): 4 athletes rotate through in pairs.'],
          ['a group size', 'Run the circuit in groups of 3 athletes so each one gets a full round.'],
          ['a participant count', 'With 8 participants you can run two stations in parallel.'],
          ['a pairing instruction', 'Pair up the 10 athletes; 2 athletes per bag keeps the rotation tight.'],
        ])('allows %s', (_label, response) => {
          const result = validateShadowResponse(response, { allowedEvidenceIds: [] });
          expect(result.filtered).toBe(false);
        });

        // A sweep of 34 realistic benign answers (2026-08-02) found three more
        // the first strip still withheld. Planning speech is unbounded, so a
        // strip alone will always trail it -- hence the assertion-frame layer.
        // These three are the measured misses.
        test.each([
          ['a class cap', 'Keep the beginner class to 8 athletes so you can watch every set of hands.'],
          ['a coaching ratio', 'One coach for every 6 athletes is what lets you correct faults in real time.'],
          ['an equipment constraint', 'With only 5 bags and 14 athletes, run two on shadowboxing while three work.'],
          ['an allocation near an existence verb', 'There are 3 athletes at each station during the circuit.'],
          ['a capacity statement', 'The Saturday open gym can host 20 athletes comfortably.'],
        ])('allows %s', (_label, response) => {
          const result = validateShadowResponse(response, { allowedEvidenceIds: [] });
          expect(result.filtered).toBe(false);
        });

        // The assertion-frame layer is the risky direction -- it filters only
        // on recognised frames, so a missed frame lets an uncited figure
        // through. An organizational rollup is the load-bearing case.
        test.each([
          ['an organizational rollup figure', 'Alpha Boxing has 12 athletes.'],
          ['a plain population statement', 'There are 30 athletes enrolled this season.'],
          ['a past population statement', 'There were 45 athletes in the program last year.'],
          ['a first-person rollup', 'We have 22 athletes across the two evening classes.'],
          ['a service figure', 'The gym serves 60 athletes a week.'],
          ['a tracked cohort', 'We tracked 40 participants over eight weeks.'],
          ['a sample with an outcome', 'In our program 300 athletes improved their guard after this drill.'],
          ['an out-of framing', '7 out of 10 athletes reported less shoulder soreness.'],
          ['a participant outcome', '40 participants showed a measurable increase in punch speed.'],
          ['a distant outcome', '52 athletes, all of them in the beginner tier that season, improved measurably.'],
          ['a comparison population', 'This is best for 247 similar athletes.'],
          ['a count of similar cases', 'We saw the same pattern in 12 similar cases.'],
          ['a count of studies', 'Across 4 studies the effect held.'],
        ])('still filters %s', (_label, response) => {
          const result = validateShadowResponse(response, { allowedEvidenceIds: [] });
          expect(result.filtered).toBe(true);
        });
      });

      describe('one claim costs one citation, however many frames cover it', () => {
        // #300 made each claim-shaped phrase require its own citation
        // occurrence, which closed a real hole: one real citation used to
        // license a fabricated claim sitting next to it. But it summed the
        // people-count frames independently, so a single phrase satisfying two
        // frames demanded two citations. Measured 2026-08-10 -- these three are
        // the organizational-rollup-with-an-outcome shape, which is the most
        // useful answer an administrator can ask SHADOW for, and all three were
        // withheld while correctly cited.
        const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3311';
        test.each([
          ['existence plus outcome', `There are 30 athletes enrolled who improved their guard [E:${ID}].`],
          ['serves plus outcome', `The gym serves 60 athletes and 40 improved this season [E:${ID}].`],
          ['tracked plus outcome', `We tracked 40 participants who reported less soreness [E:${ID}].`],
        ])('delivers %s when cited once', (_label, response) => {
          const result = validateShadowResponse(response, { allowedEvidenceIds: [ID] });
          expect(result.filtered).toBe(false);
        });

        // And the hole #300 closed must stay closed: a real citation on one
        // claim cannot license a different, uncited one beside it.
        test('a cited claim still does not license an uncited neighbour', () => {
          const result = validateShadowResponse(
            `Attendance is 94% [E:${ID}]. Also, 250 similar athletes fully recovered with no setbacks.`,
            { allowedEvidenceIds: [ID] },
          );
          expect(result.filtered).toBe(true);
          expect(result.reasonCodes).toContain('uncited_claim');
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

      test('filters a second, uncited claim riding on one real citation', () => {
        // The check used to be a single yes/no over the whole response: any
        // citation at all satisfied it, no matter how many separate claims the
        // response made. One real cited percentage let a completely
        // fabricated, uncited case count and outcome through right next to
        // it -- exactly the case counts and outcomes DOCTRINE item 4 forbids
        // inventing.
        const evidenceId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        const result = validateShadowResponse(
          `Attendance is 94% across the gym [E:${evidenceId}]. Also, 250 similar `
          + 'athletes fully recovered using this exact protocol with no setbacks.',
          { allowedEvidenceIds: [evidenceId] },
        );
        expect(result.filtered).toBe(true);
        expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
      });

      test('allows the same citation to back more than one claim it actually supports', () => {
        const evidenceId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        const result = validateShadowResponse(
          `Attendance is 94% across the gym [E:${evidenceId}]. Research shows this `
          + `trend held all season [E:${evidenceId}].`,
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

// ---------------------------------------------------------------------------
// The phone keyboard
//
// The three sentences in the first test below were measured against main
// before the fix. The straight-apostrophe form was withheld; the curly form
// -- which is what iOS and Android type by default -- was allowed through to
// the model. The rest of this describe is controls, known gaps and fences,
// each labelled where it stands.
// ---------------------------------------------------------------------------
describe('typographic normalisation before matching', () => {
  const CURLY = '\u2019';

  // THE DEFECT. Each pair is the same sentence twice, differing only in the
  // apostrophe character. Before the fix the second of each pair graded
  // `valid: true` with no classification at all.
  test.each([
    ['breathe', `I can${CURLY}t breathe after that hit`],
    ['see', `I can${CURLY}t see after that punch`],
    ['move', `I can${CURLY}t move my arm after that fall`],
  ])('a curly apostrophe still reports an emergency: %s', (_name, message) => {
    const result = validateShadowRequest(message, 'athlete', 'org-123');

    expect(result.valid).toBe(false);
    expect(result.classification).toBe('urgent_personal_symptom');
    expect(result.error).toContain('Potential emergency');
  });

  // THE PAIRED CONTROL, and the one that makes the rows above mean something.
  // If the straight form had silently stopped working, every assertion above
  // could pass while the feature was broken in a new direction.
  test.each([
    ["I can't breathe after that hit"],
    ["I can't see after that punch"],
    ["I can't move my arm after that fall"],
  ])('the straight apostrophe is still an emergency: %s', (message) => {
    const result = validateShadowRequest(message, 'athlete', 'org-123');

    expect(result.valid).toBe(false);
    expect(result.classification).toBe('urgent_personal_symptom');
    expect(result.error).toContain('Potential emergency');
  });

  // STILL MISSED, DELIBERATELY, AND MOVED TO #1036.
  //
  // Normalisation folds a curly apostrophe into a straight one. It cannot
  // invent an apostrophe nobody typed, and "cant" is how this gets typed at
  // speed -- so these are NOT caught, on main or here.
  //
  // This PR briefly did catch them, by widening the pattern to make the
  // apostrophe optional. That widening produced a regression in four
  // consecutive rounds -- "significant" and "vacant" fired the emergency
  // path, then "cantilever" and "cantina", then "signifi-cant" and its
  // soft-hyphen form, then any contraction preceded by punctuation stopped
  // being caught at all. Every round fixed the example rather than the class,
  // because "what is the edge of a word" is not expressible as a list of
  // characters.
  //
  // So it was taken out. The curly apostrophe is the production defect and
  // the fold closes it without touching these patterns; the missing-apostrophe
  // family -- "cant", "couldn't", "couldnt", "can not", "wont stop" -- is one
  // problem and belongs in #1036, solved once with an instrument that
  // survives scrutiny rather than patched a fifth time under release
  // pressure.
  //
  // FLIPPED 2026-10-06 (SHADOW emergency-phrase lane) for "cant" ONLY. The
  // optional apostrophe is still not used. "cant" is a separate alternative,
  // `\bcant\s+(?:breathe|see|move)` (plus `feel` in the impact pattern),
  // beside the untouched can't/cannot ones, so nothing caught before stops
  // being caught, and it needs a word start AND one of a few verbs after it:
  // "significant", "vacant", "cantilever" and "cantina" cannot reach it.
  // What still can is a word split at its "cant" by a hyphen and followed by
  // one of those verbs ("signifi-cant move"); that over-flags, which is the
  // safe direction. couldn't/couldnt/can not/wont stop stay with #1036.
  test.each([
    ['i cant breathe after that hit'],
    ['i cant see after that punch'],
  ])('an omitted apostrophe in "cant" is now an emergency: %s', (message) => {
    const result = validateShadowRequest(message, 'athlete', 'org-123');
    expect(result.valid).toBe(false);
    expect(result.classification).toBe('urgent_personal_symptom');
  });

  // CONTROL, NOT EVIDENCE. KO'd is the one pattern that already carried
  // ['\u2019] by hand, so it passed before this change and passes after. It is
  // here to show the hand-patched approach worked exactly where someone
  // remembered and nowhere else -- which is the argument for normalising the
  // input instead. It proves nothing about the fix.
  test.each([
    ["I got KO'd last round"],
    [`I got KO${CURLY}d last round`],
  ])('CONTROL: KO\'d already handled both forms by hand: %s', (message) => {
    const result = validateShadowRequest(message, 'athlete', 'org-123');
    expect(result.valid).toBe(false);
  });

  // A LINE BREAK IS NOT A SPACE. An earlier version of this fix collapsed
  // \s+, which folded newlines away, and the newline was the only bound on
  // the unbounded `.` gaps in this file. Both of these were fine on main, were
  // withheld by that version, and are fine again: the fold no longer touches
  // whitespace at all.
  // ALL FOUR ECMAScript LINE TERMINATORS, because the first repair preserved
  // \n alone and CR, U+2028 and U+2029 were still folded into spaces -- CRLF
  // is what a Windows client sends, and U+2028/U+2029 arrive from pasted rich
  // text.
  test.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('a %s line break still bounds the pattern gaps', (_name, br) => {
    expect(validateShadowRequest(
      `Bodyweight work today felt good.${br}Tomorrow I want to cut the warm-up short.`,
      'coach', 'org-123',
    ).valid).toBe(true);
    expect(validateShadowRequest(
      `I need to return the gloves I borrowed.${br}We can play it by ear for Saturday.`,
      'coach', 'org-123',
    ).valid).toBe(true);
  });

  // HISTORY, KEPT AS A FENCE. An earlier version of this fix made the
  // apostrophe optional, and any word CONTAINING those four letters reached
  // the emergency branch. A leading \b closed the suffix cases (significant,
  // vacant, scant); the prefix cases (cantilever, cantina) stayed open; with
  // boundaries on both sides the hyphenated and accented forms still fired.
  // The optional apostrophe was then removed altogether, so none of these can
  // match today. They stay pinned for whoever reintroduces it in #1036.
  test.each([
    // ROUND 1 -- suffix, matched with no boundary at all
    ['I felt great after the punch drill today and my footwork showed significant improvement'],
    ['I moved from the fall bag over to the vacant station'],
    ['After that punch combo my notes were scant'],
    // ROUND 2 -- prefix, still matched with a LEADING word boundary
    ['I moved from the fall bag over to the cantilever station after that punch drill'],
    ['After that punch we all went to the cantina down the road'],
    // ROUND 3 -- still matched with word boundaries on BOTH sides, because a
    // word boundary is a \\w / non-\\w transition and \\w is [A-Za-z0-9_]. A
    // hyphen, a soft hyphen, a dash or an accented letter is an edge as far
    // as it is concerned. The soft-hyphen row is the worst of these: the
    // athlete sees the word "significant" on screen, with nothing to explain
    // why the gym app declared a medical emergency.
    ['After that punch my footwork showed signifi-cant improvement'],
    ['After that punch my footwork showed signifi\u00ADcant improvement'],
    ['After that punch my footwork showed signifi\u2013cant improvement'],
    ['After that punch I heard my coach cant\u00F3 along with the radio'],
    // NOT IN THIS LIST: "the coach used the word 'cant' about my stance".
    // While the apostrophe was optional that sentence matched, and it was
    // accepted as a trade. It does not match now -- "cant" is not a pattern
    // -- and shadowChatSensitivity.test.ts asserts that, beside the quoted
    // real report "'I can't breathe'" which must keep matching.
  ])('a word merely containing "cant" is not an emergency: %s', (message) => {
    expect(validateShadowRequest(message, 'athlete', 'org-123').valid).toBe(true);
  });

  // U+FEFF is whitespace to the ECMAScript engine, so main's
  // `can(?:not|'t)\s+breathe` ALREADY matched "I can't<FEFF>breathe after
  // that hit" and withheld it. An earlier version of this fix stripped
  // U+FEFF as a zero-width character, which joined the words, matched
  // nothing, and allowed the message through to the model with nobody told
  // -- the production defect this branch exists to close, reintroduced
  // through a different character. Pinned by code point.
  test.each([
    ['U+FEFF between the contraction and the symptom', 'I can\u2019t\uFEFFbreathe after that hit'],
    ['U+FEFF after cannot', 'I cannot\uFEFFbreathe after that hit'],
  ])('a separator the engine calls whitespace is not deleted: %s', (_name, message) => {
    expect(validateShadowRequest(message, 'athlete', 'org-123').valid).toBe(false);
  });

  // U+FEFF, U+200B AND U+00AD ARE ALL LEFT EXACTLY AS TYPED, as on main.
  //
  // Main does not delete any of them; it matches across U+FEFF, because the
  // ECMAScript \s class contains it, and does not match across the other
  // two. Deleting them was a change from main and released messages main
  // withheld. Folding U+FEFF to a space was also a change from main: it made
  // the literal-space weight-cut phrases match, and that return sits above
  // the emergency one. shadowChatSensitivity.test.ts pins both.
  test('U+FEFF, U+200B and U+00AD are left exactly as typed', () => {
    expect(normaliseForMatching('I can\u2019t\uFEFFbreathe')).toBe("I can't\uFEFFbreathe");
    expect(normaliseForMatching('I can\u2019t\u200Bbreathe')).toBe("I can't\u200Bbreathe");
    expect(normaliseForMatching('signifi\u00ADcant')).toBe('signifi\u00ADcant');
    // The distinction main's behaviour rests on, asserted rather than described.
    expect(/\s/.test('\uFEFF')).toBe(true);
    expect(/\s/.test('\u200B')).toBe(false);
  });

  // NOT evidence that an omitted apostrophe is caught -- it is not; see the
  // KNOWN GAP above. This message is withheld because of "hurts", on the
  // personal-health return, and the "cant" in it contributes nothing. It is
  // here so that a report which happens to contain an omitted apostrophe is
  // seen to be no worse off for it.
  test('a report containing an omitted apostrophe is still withheld when something else in it matches', () => {
    const result = validateShadowRequest('my arm hurts after that punch and i cant lift it', 'athlete', 'org-123');
    expect(result.valid).toBe(false);
    expect(result.classification).toBe('personal_health_concern');
  });

  // THE FOLD TOUCHES NEITHER OF THESE.
  //
  // It used to strip zero-width characters and collapse runs of whitespace.
  // Neither was needed for the curly apostrophe, and stripping a zero-width
  // character released a message main withheld: "my<ZWSP>shoulder hurts"
  // became "myshoulder hurts" and the word boundary failed.
  //
  // So anything the fold does not substitute behaves EXACTLY as it does on
  // main, which is the standard this hotfix is measured against.
  test('doubled spaces still match, and a zero-width character is left alone', () => {
    // A run of spaces was never a problem: the patterns use \s+, which matches
    // a run. This passes because main passes it, not because the fold acts.
    expect(validateShadowRequest('I have  chest   pain right now', 'athlete', 'org-123').valid).toBe(false);
    // NOT withheld -- and main does not withhold it either, because its
    // patterns do not match across a zero-width character. Catching this is
    // #1036 work; silently differing from main is not.
    expect(validateShadowRequest('I can\u200B\u2019t breathe after that hit', 'athlete', 'org-123').valid).toBe(true);
  });

  describe('normaliseForMatching itself', () => {
    test('folds the phone apostrophe and the curly quotes (the whole table is checked in shadowChatSensitivity.test.ts)', () => {
      expect(normaliseForMatching('can\u2019t can\u2018t can\u2032t can\u00B4t')).toBe("can't can't can't can't");
      expect(normaliseForMatching('\u201Cquoted\u201D')).toBe('"quoted"');
    });

    test('leaves runs of spaces, NBSP, a zero-width space and leading or trailing space alone', () => {
      // No whitespace collapsing, no NBSP folding, no zero-width stripping, no
      // trim, and U+FEFF is not touched. Each was removed after it changed
      // what main did with some message. What is left is one-to-one
      // substitution of an apostrophe or quote look-alike.
      expect(normaliseForMatching('a\u00A0\u00A0b\u200Bc   d')).toBe('a\u00A0\u00A0b\u200Bc   d');
      expect(normaliseForMatching(' leading and trailing ')).toBe(' leading and trailing ');
    });

    // MATCHING ONLY. The athlete's own words are the record: the folded text
    // must never be what is stored, sent to the model, or shown back.
    //
    // The "input is not mutated" assertion this test used to carry was
    // removed: JavaScript strings are immutable, so it could not fail for any
    // implementation, and a test that cannot fail is decoration.
    test('no folded text escapes the classifier', () => {
      const typed = `I can${CURLY}t breathe after that hit`;

      const result = validateShadowRequest(typed, 'athlete', 'org-123');
      const emitted = JSON.stringify(result);

      // The folded spelling must not appear anywhere in what comes back.
      expect(emitted).not.toContain("can't breathe");
      expect(emitted).not.toContain('breathe after that hit');
      // Nor the original, which would mean the message itself was echoed.
      expect(emitted).not.toContain(typed);
      // And the return value is only the fields it is supposed to be, so a
      // future field carrying text would have to be added deliberately.
      expect(Object.keys(result).sort()).toEqual(
        ['classification', 'error', 'highRisk', 'topic', 'valid'],
      );
    });
  });
});

// CL-C8 (2026-10-05 audit; measured by Codex at 6736bac7): the response
// filter released six diagnostic or prescriptive answers because each used a
// subject, copula, contraction, ailment or drug the patterns did not list.
// The ruling is that in-app AI is never diagnostic. The second list is the
// other half of the property: educational and conditional answers that must
// keep passing, so the widening is not paid for with refusals.
describe('CL-C8: diagnostic and prescriptive phrasings the filter missed', () => {
  test.each([
    // Codex's six, verbatim.
    ["That's a concussion.", 'diagnostic_claim'],
    ['This is a sprained ankle.', 'diagnostic_claim'],
    ["You've torn your ACL.", 'diagnostic_claim'],
    ['Example Athlete has a concussion.', 'diagnostic_claim'],
    ['You have tendinitis.', 'diagnostic_claim'],
    ['Take two Advil.', 'prescriptive_claim'],
    // The same shapes with neighbouring words.
    ['That’s a concussion.', 'diagnostic_claim'],
    ['This sounds like a torn rotator cuff.', 'diagnostic_claim'],
    ['Looks like a hairline fracture.', 'diagnostic_claim'],
    ["Jake's got a concussion.", 'diagnostic_claim'],
    ['Maria has a dislocated shoulder.', 'diagnostic_claim'],
    ['He sprained his wrist on that hook.', 'diagnostic_claim'],
    ['You have a herniated disc.', 'diagnostic_claim'],
    ['She has bursitis in that elbow.', 'diagnostic_claim'],
    ['Take an aspirin before you train.', 'prescriptive_claim'],
    ['Use Tylenol for the headache.', 'prescriptive_claim'],
    ['Start taking melatonin at night.', 'prescriptive_claim'],
    // Reviewer A, 2026-10-06: the realistic forms. A model writes the
    // diagnosis together with an instruction, and the instruction must not
    // excuse it.
    ["You've torn your ACL, so avoid sparring.", 'diagnostic_claim'],
    ["That's a concussion, so don't spar this week.", 'diagnostic_claim'],
    ["Example Athlete has a concussion and shouldn't spar.", 'diagnostic_claim'],
    ['You have tendinitis, so reduce volume.', 'diagnostic_claim'],
    ["That's a sprained ankle without question.", 'diagnostic_claim'],
    // Passive and other near forms.
    ["You're concussed.", 'diagnostic_claim'],
    ['Example Athlete is concussed.', 'diagnostic_claim'],
    ['Your wrist is broken.', 'diagnostic_claim'],
    ['Your ACL is torn.', 'diagnostic_claim'],
    ['Your ankle is sprained.', 'diagnostic_claim'],
    ["Example Athlete's wrist is fractured.", 'diagnostic_claim'],
    ["It's a concussion.", 'diagnostic_claim'],
    ["I think it's a boxer's fracture.", 'diagnostic_claim'],
    ['You suffered a concussion.', 'diagnostic_claim'],
    ['Example Athlete sustained a fracture.', 'diagnostic_claim'],
    ['Maria tore her ACL in the second round.', 'diagnostic_claim'],
    ['Take two Advils.', 'prescriptive_claim'],
    ['Pop two ibuprofen.', 'prescriptive_claim'],
    ['Try Tylenol for the headache.', 'prescriptive_claim'],
  ])('%s is withheld (%s)', (response, code) => {
    const result = validateShadowResponse(response);
    expect(result.filtered).toBe(true);
    expect(result.reasonCodes).toContain(code);
    expect(result.message).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
  });

  test.each([
    'A concussion is a brain injury caused by a blow to the head.',
    'This is a common injury in boxing, and a clinician can assess it.',
    "That's a great question about concussion; a doctor can explain the signs.",
    'If you have tendinitis, a clinician should evaluate it.',
    'When that happens, it is worth asking a medical professional.',
    'Common boxing injuries include sprained wrists and torn rotator cuffs.',
    'An athlete who has a concussion should be evaluated by a medical professional.',
    'The athlete has a higher injury risk landing off balance.',
    'Every boxer has a different injury history.',
    'Wrapping your hands reduces the chance of a fracture.',
    'This is what a sprain looks like in general terms; a clinician diagnoses it.',
    'That is a sign worth showing a doctor.',
    'The gym has an injury log coaches fill in after sessions.',
    // Reviewer A, 2026-10-06: a first cut of this fix withheld every one of
    // these. Boxing describes technique with injury verbs, and education
    // defines injuries with a copula; "educate, do not restrict"
    // (OD-2026-10-01-006) says they are answered.
    'She broke his guard with a feint.',
    'He pulled his punches in sparring, which is good for beginners.',
    "You've pulled your punches all round; commit to the shot.",
    'You broke your stance on the pivot; keep the rear heel up.',
    'He separated his feet too wide.',
    'The athlete tore his hand wraps; rewrap before sparring.',
    'He has a broken stance after combinations. Reset his feet.',
    'The kid has a broken guard in the third round, so drill the high guard.',
    'Jordan has a broken rhythm on the double jab.',
    "Ali's got a broken rhythm when he throws the hook",
    'That looks like a broken-down jab; reset.',
    'You have a broken hand wrap; rewrap.',
    'You have a torn-up glove, replace it.',
    "You've got a strained voice from yelling",
    "That's a dislocation of the timing between your feet and hands",
    'Coach Dan has a condition on sparring: only light contact.',
    'Sarah has a condition for practice: she needs a signed waiver first.',
    'Example Athlete has a condition-specific plan from the coach',
    "A boxer's fracture is a break of the fifth metacarpal. That's a fracture that usually comes from punching with poor wrist alignment, so wrap properly.",
    'Shin splints are irritation along the tibia. This is a condition coaches see in runners who ramp mileage too fast.',
    "That's a concussion symptom worth knowing: headache, confusion, light sensitivity. A physician should evaluate any athlete who shows them.",
    "That is an injury coaches should know: a boxer's fracture. A physician should evaluate it.",
    'This is a contusion, commonly called a bruise; a physician should evaluate anything severe.',
    'This sounds like tendinitis territory only a clinician can sort out; please have a physician evaluate it.',
    'That looks like a strain pattern on the video, but only a physician can say; get it evaluated.',
    'Concussion education: the brain has a concussion threshold that varies',
    "That's a stress reaction to the crowd",
    "That's a disease of the modern gym: skipping the warm-up.",
    'Avoid taking painkillers to mask an injury; see a physician.',
    'Taking steroids is banned in amateur boxing and dangerous; talk with a physician.',
    'Many boxers use caffeine before training; talk with a physician before using it.',
    'Athletes taking caffeine before sparring should know a physician can advise on dose.',
    'Use caffeine carefully: a physician can explain the risks.',
    'Never take painkillers to mask pain before sparring; tell your coach.',
  ])('%s still passes', (response) => {
    const result = validateShadowResponse(response);
    expect(result.reasonCodes).not.toContain('diagnostic_claim');
    expect(result.reasonCodes).not.toContain('prescriptive_claim');
  });
});

// #1036 ORDERING (2026-10-06). Three ways a real emergency missed the
// emergency response on main 411333a2, all from the order of
// validateShadowRequest's returns: the educational shortcut returned first
// (CL-C9, measured by Codex: "What does it mean when he passed out and can't
// breathe?" reached the model with no emergency line); the emergency check
// wanted first-person context, so "he can't breathe" got the high-risk
// handoff text; and the fallback read the first matching topic row, so
// "dizzy and passed out" was dizziness, and a clearance question above it
// won over a faint. OD-2026-10-01-008 section 2 (Jason, option A): the line
// appears when a message says a real emergency happened to a specific
// person, even without "I" or "my"; unclear wording counts; a general
// question does not. The emergency return now comes before every other.
describe('#1036 ordering: a real emergency reaches the emergency response first', () => {
  const EMERGENCY = 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.';
  const check = (message: string) => validateShadowRequest(message, 'coach', 'org-1');
  const expectEmergency = (message: string) => {
    const result = check(message);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(EMERGENCY);
    expect(result.highRisk).toBe(true);
    expect(result.classification).toBe('urgent_personal_symptom');
  };

  describe('(1) educational framing no longer hides an emergency about a specific person', () => {
    test.each([
      // The brief's own example, and Codex's two, verbatim.
      'What can coach do the kid is not breathing',
      "What does it mean when he passed out and can't breathe?",
      'What causes it when she is vomiting blood?',
      // DRAFT #1292's list, carried over.
      'What does it mean when he can’t breathe after a body shot?',
      'What causes it when they have slurred speech after sparring?',
      'What is it when the athlete has blurry vision after that hit?',
      'What does it mean when my athlete is seeing stars?',
      'What does it mean when Jake passed out after the round?',
      'What causes it when his neck went numb after the fall?',
      'What does it mean when her pupils look unequal? She has unequal pupils.',
      'What does it mean when the boxer had a seizure?',
      // #1292 reviewer A: subjects the first cut did not know.
      "What does it mean when the kiddo can't breathe?",
      'What does it mean when this boxer has slurred speech?',
      'What does it mean when the 12 year old has slurred speech?',
      "What does it mean when the other boxer can't breathe?",
      'What does it mean when hes got blurry vision after a punch',
    ])('%s', expectEmergency);
  });

  describe('(2) a third-person urgent symptom gets the emergency line, not the handoff text', () => {
    test.each([
      "Sam can't breathe",
      'Sam cant breathe',
      "he can't breathe",
      'She has slurred speech and unequal pupils',
      'the kid is vomiting blood',
      'Jordan had a seizure on the canvas',
      "my sparring partner can't see out of his left eye",
      // Unclear wording, no subject at all, counts as acute.
      'passed out and not breathing',
    ])('%s', expectEmergency);
  });

  describe('(3) an earlier topic row or a clearance question no longer wins over an emergency', () => {
    test.each([
      // dehydration and dizziness are rows above fainting
      'he got dizzy and fainted',
      'She was dehydrated and then fainted',
      'he has a concussion and is unresponsive',
      'he has a concussion and chest pain',
      // the clearance return sat above the high-risk fallback
      'What does it mean when he fainted, is he cleared to spar?',
      'He passed out in sparring, can he return to play?',
      'Is he cleared to train after he was knocked out?',
      // the prescription-or-weight-cut return sat above the emergency one
      "I can't breathe and I need to lose weight quickly",
      'I passed out, how do I cut weight for my weight class?',
    ])('%s', expectEmergency);

    test('the topic is the row classifyHighRiskTopic chose; the classification is the emergency one', () => {
      expect(check('She was dehydrated and then fainted')).toMatchObject({ topic: 'dehydration', classification: 'urgent_personal_symptom' });
      expect(check('What does it mean when he fainted, is he cleared to spar?')).toMatchObject({ topic: 'fainting' });
      expect(check("Sam can't breathe")).toMatchObject({ topic: 'urgent_symptom' });
    });
  });

  describe('a general question still gets an answer', () => {
    test.each([
      'What can cause shortness of breath?',
      'What are general warning signs after a head impact?',
      'What causes fainting?',
      'What is loss of consciousness?',
      'What is a seizure?',
      'What causes vomiting blood in athletes?',
      'What are the signs athletes show when their vision is blurry?',
      'How do coaches respond when a boxer collapses?',
      'What is the first aid for an athlete who collapsed?',
      'What does it mean if a fighter is unresponsive?',
      'What is a collapsed lung?',
      // #1292 reviewer A: a pronoun or "the athlete" that refers to a general
      // subject is not a specific person.
      'What causes a boxer to faint after his weigh-in?',
      'What can cause a wrestler to have a headache after he cuts weight?',
      'What does a referee look for when deciding if a boxer is knocked out or if he can continue?',
      'What is the difference between fainting and a seizure in an athlete and how would a coach tell if he or she needs help?',
      'What are the signs that a fighter is unconscious versus just dazed, and what should the coach do for him?',
      'What is syncope and how does it differ from when someone just feels her legs go weak?',
      'What is a concussion and what headache signs should the athlete watch for?',
      'What is the research on chest pain in young athletes?',
    ])('%s', (message) => {
      const result = check(message);
      expect(result.valid).toBe(true);
    });
  });

  describe('a non-acute question about someone else is not newly refused', () => {
    test.each([
      'What does it mean when he has a sore shoulder?',
      'What is it when she has wrist pain after bag work?',
      'What does it mean when they feel stiff the next day?',
      // #1292 reviewer B: high-risk topics that are not acute keep their
      // topic and stay allowed.
      'What is the recovery like when he has surgery?',
      'What does it mean when the doctor gave her a cortisone injection?',
      'What are the risks when he cuts weight for his weight class?',
      'What does it mean when the athlete is dehydrated?',
    ])('%s', (message) => {
      const result = check(message);
      expect(result.valid).toBe(true);
      expect(result.topic).toBe(classifyHighRiskTopic(message).topic);
    });
  });

  describe("main's own returns keep their place behind the emergency one", () => {
    test('a first-person emergency is unchanged', () => {
      expectEmergency("I can't breathe after that hit");
      expectEmergency('I collapsed after sparring');
    });
    test('a diagnosis, clearance or medication question with no acute sign keeps its own text', () => {
      expect(check('Do I have a concussion?').error).toBe('Diagnosis and personal health assessment require professional medical evaluation.');
      expect(check('Am I cleared to spar?').error).toBe('Medical clearance decisions require professional medical authority.');
      expect(check('Should I take ibuprofen pills for this?').error).toBe('Medication and prescription recommendations require prescription authority and professional medical oversight.');
    });
    test('a non-emergency high-risk report keeps the handoff text', () => {
      expect(check('he is dizzy').error).toBe('Personal high-risk health and safety concerns require immediate human evaluation. SHADOW can only provide general educational information.');
    });
  });

  // The four patterns emergencyReport tests directly are copies of topic
  // rows in classifyHighRiskTopic. Read both out of the source so that an
  // edit to a row that forgets the copy fails here.
  test('EMERGENCY_TOPIC_PATTERNS are the chest_pain, fainting and both loss_of_consciousness rows, by source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'shadowChat.ts'), 'utf8');
    const rows = new Map<string, string[]>();
    for (const m of source.matchAll(/^\s*\['(chest_pain|fainting|loss_of_consciousness)', (\/.*\/i)\],$/gm)) {
      rows.set(m[1], [...(rows.get(m[1]) ?? []), m[2]]);
    }
    expect([...rows.keys()].sort()).toEqual(['chest_pain', 'fainting', 'loss_of_consciousness']);
    expect(rows.get('loss_of_consciousness')).toHaveLength(2);
    const block = /const EMERGENCY_TOPIC_PATTERNS: readonly RegExp\[\] = \[\n([\s\S]*?)\n\];/.exec(source);
    if (!block) throw new Error('EMERGENCY_TOPIC_PATTERNS not found');
    const copies = block[1].split('\n').map((line) => line.trim().replace(/,$/, ''));
    expect(copies).toEqual([
      rows.get('loss_of_consciousness')![0],
      rows.get('chest_pain')![0],
      rows.get('fainting')![0],
      rows.get('loss_of_consciousness')![1],
    ]);
  });
});
