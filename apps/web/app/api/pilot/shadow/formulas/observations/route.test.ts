import { NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { queryOne } from '@/src/server/pilot/db';
import { saveFormulaObservation } from '@/src/server/pilot/formulas/repository';
import { recalculateForSupersededObservation } from '@/src/server/pilot/formulas/runner';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getSafetyGateDefinition,
  recordSafetyGateEvaluation,
} from '@/src/server/pilot/safetyGateMatrix';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { getLatestMedicalAdministrativeStatus } from '@/src/server/pilot/shadowMedicalStatus';
import { findNearMissByTriggerContext, flagNearMiss } from '@/src/server/pilot/shadowNearMisses';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { POST as postObservation } from './route';

/**
 * Route-level coverage for the two contact safety gates this endpoint calls.
 *
 * WHY THIS FILE EXISTS. This is the only route in the platform that records
 * that a child took physical contact, and it carries two safety gates:
 * flagContactWithoutClearance and flagContactDuringHold. Both gate FUNCTIONS
 * are well covered by their own unit tests (contactClearanceGate.test.ts,
 * trainingHolds.test.ts). Neither gate CALL was covered. The route's only
 * indirect coverage, formulaRoutes.test.ts, posts 'session_rpe', 'pain_report'
 * and 'recovery_notes' -- not one of them a contact kind -- so every gate call
 * short-circuited at the shared isContactObservation check and the bodies never
 * ran. Deleting both `await flag...` calls from route.ts left the entire suite
 * green. That is the specific claim these tests falsify: each test below fails
 * if its gate call is removed from the route.
 *
 * The gates are deliberately NOT mocked here. The point is the wiring -- that
 * the route reaches the real gate logic with the real principal and the real
 * payload -- so only the edges beneath the gates (medical status, the holds
 * table read, the near-miss store, the gate matrix) are faked. Mocking the
 * gates themselves would re-create the gap this file closes.
 *
 * ON "REFUSED". Both gates FLAG and keep the record; neither refuses the write,
 * and the tests below assert that rather than a rejection. This is not an
 * oversight in the route -- it is documented doctrine in contactClearanceGate.ts
 * ("WHY THIS DOES NOT REFUSE THE WRITE") and restated in flagContactDuringHold:
 * this endpoint records contact that has ALREADY happened, refusing the write
 * would destroy the only evidence it occurred and would teach whoever is
 * logging to leave the contact fields blank next time, and under-reporting is
 * the failure mode that actually hurts an athlete. So the safety property to
 * pin down is "kept AND escalated to a human", not "rejected". A test asserting
 * a 4xx here would be encoding the opposite of the safeguarding decision.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return { ...actual, saveFormulaObservation: jest.fn() };
});
jest.mock('@/src/server/pilot/formulas/runner', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/runner');
  return { ...actual, recalculateForSupersededObservation: jest.fn() };
});

// The edges the REAL gates read through. flagContactWithoutClearance resolves
// clearance via shadowMedicalStatus; flagContactDuringHold reads
// pilot.training_holds through db.queryOne.
jest.mock('@/src/server/pilot/shadowMedicalStatus', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowMedicalStatus');
  return { ...actual, getLatestMedicalAdministrativeStatus: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('@/src/server/pilot/safetyGateMatrix', () => ({
  getSafetyGateDefinition: jest.fn(),
  recordSafetyGateEvaluation: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowNearMisses', () => ({
  flagNearMiss: jest.fn(),
  findNearMissByTriggerContext: jest.fn(),
}));
jest.mock('@/src/server/pilot/escalationLadder', () => ({
  fileEscalation: jest.fn().mockResolvedValue({ escalation_id: 'esc-1' }),
}));
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockSaveObservation = jest.mocked(saveFormulaObservation);
const mockRecalculate = jest.mocked(recalculateForSupersededObservation);
const mockMedicalStatus = getLatestMedicalAdministrativeStatus as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockGetGate = getSafetyGateDefinition as jest.Mock;
const mockRecordEvaluation = recordSafetyGateEvaluation as jest.Mock;
const mockFlagNearMiss = flagNearMiss as jest.Mock;
const mockFindNearMiss = findNearMissByTriggerContext as jest.Mock;
const mockEmitShadowEvent = jest.mocked(emitShadowEvent);

const CLEARANCE_TRIGGER = 'contact_observation_without_medical_clearance';
const HOLD_TRIGGER = 'contact_observation_during_training_hold';

const GATE_LESSON = 'Record a cleared medical administrative status before contact continues.';

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-account-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function jsonRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/formulas/observations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * A genuine contact observation: 'contact_level' with a positive value is
 * contact by definition -- it cannot happen without a partner. The value must
 * be above zero, because 0 is the "None" position on the contact-level slider
 * and recording no contact must never trip a safety flag.
 */
const contactObservationBody = {
  athleteId: 'athlete-1',
  contextId: 'sparring-2026-08-18',
  kind: 'contact_level',
  value: 2,
  unit: 'level_0_3',
  dimensions: {},
  observedAt: '2026-08-18T18:00:00.000Z',
  idempotencyKey: 'sparring-2026-08-18-contact_level',
};

/** The non-contact kind the pre-existing indirect test used. */
const nonContactObservationBody = {
  ...contactObservationBody,
  kind: 'session_rpe',
  value: 5,
  unit: 'rpe_0_10',
  idempotencyKey: 'sparring-2026-08-18-session_rpe',
};

/** An active hold whose scope covers contact, as the gate's query selects it. */
const contactBlockingHold = { hold_id: 'hold-1', scope: 'contact_only' };

function nearMissCallsWithTrigger(trigger: string) {
  return mockFlagNearMiss.mock.calls.filter(([input]) => input?.metadata?.trigger === trigger);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAssertAccess.mockResolvedValue(undefined);
  mockReadiness.mockResolvedValue(undefined);
  mockSaveObservation.mockImplementation(async (input) => ({
    observationId: 'observation-1',
    ...input,
    supersedesObservationId: input.supersedesObservationId ?? null,
  }));
  mockRecalculate.mockResolvedValue([]);
  mockEmitShadowEvent.mockResolvedValue(undefined);

  // Cleared and unheld by default, so each test below opts INTO the one unsafe
  // condition it is about.
  mockMedicalStatus.mockResolvedValue({ status: 'cleared' });
  mockQueryOne.mockResolvedValue(null);

  mockGetGate.mockResolvedValue({
    gate_id: 'gate_org_1_contact_medical_clearance',
    gate_key: 'contact_medical_clearance',
    name: 'Contact Requires Medical Clearance',
    category: 'medical',
    enforcement: 'flag',
    requirement_text: GATE_LESSON,
    active_flag: true,
  });
  mockRecordEvaluation.mockResolvedValue(undefined);
  mockFindNearMiss.mockResolvedValue(null);
  mockFlagNearMiss.mockResolvedValue({ near_miss_id: 'near-miss-1' });
});

describe('contact logged for an athlete with no clearance on file', () => {
  // The audit's concrete claim was that deleting the flagContactWithoutClearance
  // call would leave the suite green. This is the test that goes red.
  test('raises a near miss a human will see', async () => {
    mockMedicalStatus.mockResolvedValue(null);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(CLEARANCE_TRIGGER)).toHaveLength(1);
    expect(mockFlagNearMiss).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      severity: 'high',
      detectedBy: 'system',
      detectedByAccountId: 'coach-account-1',
      detectedByRole: 'coach',
      metadata: expect.objectContaining({
        trigger: CLEARANCE_TRIGGER,
        observation_kind: 'contact_level',
        observation_value: 2,
        medical_status: 'no_record',
        context_id: 'sparring-2026-08-18',
      }),
    }));
  });

  // Absence of a clearance decision is not a clearance decision, and an
  // affirmative "must not take contact" being overridden is the most serious
  // version of this. Proving the route passes the kind and value through far
  // enough for the real gate to grade severity, not merely that it flags.
  test.each([
    ['not_cleared', 'critical'],
    ['restricted', 'critical'],
    ['pending', 'high'],
  ])('a %s status is reported back to the logger as %s', async (status, severity) => {
    mockMedicalStatus.mockResolvedValue({ status });

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      safetyReview: {
        raised: true,
        reason: 'contact_without_medical_clearance',
        medicalStatus: status,
        severity,
        lesson: GATE_LESSON,
      },
    }));
  });

  // The doctrine, asserted rather than assumed: the record of contact that
  // already happened survives. Refusing it would destroy the only evidence.
  test('keeps the observation rather than discarding the evidence', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
    expect(mockSaveObservation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'contact_level',
      value: 2,
      athleteId: 'athlete-1',
      organizationId: 'org-1',
    }));
  });
});

describe('contact logged for an athlete under a hold covering contact', () => {
  // Deleting the flagContactDuringHold call turns this one red.
  test('raises a near miss naming the hold', async () => {
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(HOLD_TRIGGER)).toHaveLength(1);
    expect(mockFlagNearMiss).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      severity: 'high',
      detectedBy: 'system',
      metadata: expect.objectContaining({
        trigger: HOLD_TRIGGER,
        observation_kind: 'contact_level',
        observation_value: 2,
        hold_id: 'hold-1',
        hold_scope: 'contact_only',
        context_id: 'sparring-2026-08-18',
      }),
    }));
  });

  // The gate reads the holds table scoped to the authenticated organization and
  // the athlete in the payload -- an unscoped read here would let one gym's
  // hold silence another's, or miss the hold entirely.
  test('looks the hold up scoped to the principal organization and the athlete', async () => {
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    await postObservation(jsonRequest(contactObservationBody));

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('pilot.training_holds'),
      ['org-1', 'athlete-1'],
    );
    const [sql] = mockQueryOne.mock.calls[0];
    // Only an active, unexpired hold whose scope covers contact counts.
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("scope in ('all_training', 'contact_only')");
    expect(sql).toContain('expires_at is null or expires_at > now()');
  });

  test('keeps the observation rather than discarding the evidence', async () => {
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
  });

  // Both gates run on the same request, so an uncleared AND held athlete must
  // produce both alerts -- one gate must not mask the other.
  test('an uncleared athlete who is also held raises both near misses', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(CLEARANCE_TRIGGER)).toHaveLength(1);
    expect(nearMissCallsWithTrigger(HOLD_TRIGGER)).toHaveLength(1);
  });
});

describe('the same contact observation for a cleared, unheld athlete', () => {
  test('is stored with no near miss and no safety review in the response', async () => {
    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);

    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.observation).toEqual(expect.objectContaining({ observationId: 'observation-1' }));
    expect(payload).not.toHaveProperty('safetyReview');
  });

  // A pass is evidence too: the audit trail must record that the gate was
  // checked and cleared, not just the failures.
  test('records a passed clearance evaluation in the gate matrix', async () => {
    await postObservation(jsonRequest(contactObservationBody));

    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      gateKey: 'contact_medical_clearance',
      athleteId: 'athlete-1',
      outcome: 'passed',
    }));
  });
});

describe('the gates run BEFORE the observation is persisted', () => {
  /**
   * The load-bearing ordering the route's own comment describes. Asserting the
   * HTTP status is not enough -- the failure this guards against is contact
   * being persisted while the alert silently failed, which is invisible from
   * the response. So each test below proves the absence of the write.
   */
  test('a clearance-gate failure aborts the request and stores nothing', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });
    mockFlagNearMiss.mockRejectedValueOnce(new Error('near miss store unavailable'));

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(500);
    // The whole point: no contact row nobody was alerted to.
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });

  test('a hold-gate failure aborts the request and stores nothing', async () => {
    mockQueryOne.mockResolvedValue(contactBlockingHold);
    mockFlagNearMiss.mockRejectedValueOnce(new Error('near miss store unavailable'));

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(500);
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });

  // A hold read that fails for any reason other than the pre-migration
  // missing-table case must not be swallowed into a silent store either.
  test('a holds-table read failure aborts the request and stores nothing', async () => {
    mockQueryOne.mockRejectedValueOnce(Object.assign(new Error('connection reset'), {
      code: '08006',
    }));

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(500);
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });

  // Ordering proved positively, not only through the failure paths: on a
  // successful flagged request the alert is written first.
  test('the near miss is written before the observation on a flagged request', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    await postObservation(jsonRequest(contactObservationBody));

    expect(mockFlagNearMiss).toHaveBeenCalled();
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);

    const lastNearMissOrder = Math.max(
      ...mockFlagNearMiss.mock.invocationCallOrder,
    );
    const [saveOrder] = mockSaveObservation.mock.invocationCallOrder;
    expect(lastNearMissOrder).toBeLessThan(saveOrder);
  });

  // The gates read the athlete from the payload, so they must not run before
  // the caller has been proven allowed to touch that athlete at all.
  test('neither gate runs when athlete access is refused', async () => {
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: athlete outside scope'));

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(403);
    expect(mockMedicalStatus).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });
});

describe('non-contact observations are not gated', () => {
  /**
   * The over-broadening guard. 'session_rpe' is the kind the pre-existing
   * indirect test posted, which is exactly why both gates were dead code from
   * the suite's point of view. It must STAY ungated: flagging ordinary
   * conditioning would bury the real alerts, and a body-weight log must not
   * cost two database round trips.
   */
  test('a session_rpe observation triggers no clearance or hold lookup at all', async () => {
    mockMedicalStatus.mockResolvedValue(null);

    const response = await postObservation(jsonRequest(nonContactObservationBody));

    expect(response.status).toBe(200);
    expect(mockMedicalStatus).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockGetGate).not.toHaveBeenCalled();
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
  });

  // Even with an uncleared athlete under an active contact hold -- the two
  // conditions that flag a contact kind -- a non-contact kind stays clean.
  test('a session_rpe observation is unflagged even for an uncleared, held athlete', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest(nonContactObservationBody));

    expect(response.status).toBe(200);
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    await expect(response.json()).resolves.not.toHaveProperty('safetyReview');
  });

  // 'None' on the contact-level slider. Recording that there was no contact is
  // accurate reporting and must never be punished with a flag.
  test('a contact kind with value 0 is not treated as contact', async () => {
    mockMedicalStatus.mockResolvedValue(null);
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest({
      ...contactObservationBody,
      value: 0,
      idempotencyKey: 'sparring-2026-08-18-contact_level-none',
    }));

    expect(response.status).toBe(200);
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockMedicalStatus).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
  });
});

describe('every contact kind reaches both gates', () => {
  /**
   * A single sparring submission posts contact_level, contact_rounds and
   * punch_absorbed as separate requests. If the route only reached the gates
   * for one of them, two thirds of a session's contact would go unchecked --
   * so the wiring is asserted per kind, not just for the representative one.
   */
  test.each([
    ['contact_level', 2, 'level_0_3'],
    ['contact_rounds', 3, 'count'],
    ['punch_absorbed', 11, 'count'],
  ])('%s reaches the clearance and hold gates', async (kind, value, unit) => {
    mockMedicalStatus.mockResolvedValue(null);
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest({
      ...contactObservationBody,
      kind,
      value,
      unit,
      idempotencyKey: `sparring-2026-08-18-${kind}`,
    }));

    expect(response.status).toBe(200);
    expect(mockMedicalStatus).toHaveBeenCalledWith('org-1', 'athlete-1');
    expect(nearMissCallsWithTrigger(CLEARANCE_TRIGGER)).toHaveLength(1);
    expect(nearMissCallsWithTrigger(HOLD_TRIGGER)).toHaveLength(1);
  });
});

describe('the gates use the authenticated principal, not the request body', () => {
  // A caller who could name their own organization could point the clearance
  // and hold lookups at a gym with no hold on file and log contact unflagged.
  test('an organizationId in the payload cannot redirect either gate', async () => {
    mockMedicalStatus.mockResolvedValue(null);
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    await postObservation(jsonRequest({
      ...contactObservationBody,
      organizationId: 'org-spoofed',
    }));

    expect(mockMedicalStatus).toHaveBeenCalledWith('org-1', 'athlete-1');
    expect(mockQueryOne).toHaveBeenCalledWith(expect.any(String), ['org-1', 'athlete-1']);
    expect(mockFlagNearMiss).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
    }));
  });

  // An athlete logging their own contact is the common case on the sparring
  // page, and the near miss must attribute it to them rather than to nobody.
  test('an athlete logging their own contact is flagged and attributed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({
      accountId: 'athlete-account-1',
      role: 'athlete',
      athleteId: 'athlete-1',
    }));
    mockMedicalStatus.mockResolvedValue(null);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(mockFlagNearMiss).toHaveBeenCalledWith(expect.objectContaining({
      detectedByAccountId: 'athlete-account-1',
      detectedByRole: 'athlete',
      metadata: expect.objectContaining({ trigger: CLEARANCE_TRIGGER }),
    }));
  });
});

describe('one alert per session, not per contact observation', () => {
  // Three contact observations from one submission share a contextId. Without
  // the dedup the gym gets three near misses and three escalations for one
  // session, and the repeated-pattern detector reads them as repeated
  // SESSIONS. Asserted at the route so the contextId actually reaches the
  // dedup key.
  test('a second contact observation in the same session files no second near miss', async () => {
    mockMedicalStatus.mockResolvedValue({ status: 'not_cleared' });
    mockFindNearMiss.mockResolvedValue({ near_miss_id: 'nm-existing' });

    const response = await postObservation(jsonRequest({
      ...contactObservationBody,
      kind: 'punch_absorbed',
      value: 9,
      unit: 'count',
      idempotencyKey: 'sparring-2026-08-18-punch_absorbed',
    }));

    expect(response.status).toBe(200);
    expect(mockFlagNearMiss).not.toHaveBeenCalled();
    expect(mockFindNearMiss).toHaveBeenCalledWith(
      'org-1',
      'athlete-1',
      CLEARANCE_TRIGGER,
      'sparring-2026-08-18',
    );
    // The logger is still told the truth about this observation.
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      safetyReview: expect.objectContaining({ raised: true, medicalStatus: 'not_cleared' }),
    }));
  });
});

describe('degradation on a pre-migration database', () => {
  // The holds gate promises a missing training_holds relation reads as "no
  // hold" rather than a 500 on the observation path -- a gym mid-migration
  // must still be able to record contact.
  test('a missing training_holds relation does not fail the observation', async () => {
    mockQueryOne.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), {
      code: '42P01',
    }));

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(HOLD_TRIGGER)).toHaveLength(0);
    expect(mockSaveObservation).toHaveBeenCalledTimes(1);
  });

  // A missing gate row must not stop the near miss that actually matters, and
  // must not be written as an evaluation it would violate a foreign key on.
  test('a missing gate row still raises the clearance near miss', async () => {
    mockGetGate.mockResolvedValue(null);
    mockMedicalStatus.mockResolvedValue(null);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(CLEARANCE_TRIGGER)).toHaveLength(1);
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
    const payload = await response.json();
    expect(payload.safetyReview.lesson).toEqual(expect.stringContaining('cleared'));
  });

  // An organization can deactivate the clearance gate without a code change.
  // The hold gate is separate and must keep working when it does.
  test('a deactivated clearance gate does not disable the hold gate', async () => {
    mockGetGate.mockResolvedValue({
      gate_id: 'gate_org_1_contact_medical_clearance',
      gate_key: 'contact_medical_clearance',
      name: 'Contact Requires Medical Clearance',
      category: 'medical',
      enforcement: 'flag',
      requirement_text: GATE_LESSON,
      active_flag: false,
    });
    mockMedicalStatus.mockResolvedValue(null);
    mockQueryOne.mockResolvedValue(contactBlockingHold);

    const response = await postObservation(jsonRequest(contactObservationBody));

    expect(response.status).toBe(200);
    expect(nearMissCallsWithTrigger(CLEARANCE_TRIGGER)).toHaveLength(0);
    expect(nearMissCallsWithTrigger(HOLD_TRIGGER)).toHaveLength(1);
    await expect(response.json()).resolves.not.toHaveProperty('safetyReview');
  });
});
