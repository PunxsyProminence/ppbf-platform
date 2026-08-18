import {
  CONTACT_OBSERVATION_KINDS,
  flagContactWithoutClearance,
  isContactObservation,
} from './contactClearanceGate';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from './safetyGateMatrix';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { findNearMissByTriggerContext, flagNearMiss } from './shadowNearMisses';

const GATE_LESSON = 'Set status to cleared before contact continues (test gate text).';

// Only the database read is mocked. isClearanceCurrent / effectiveMedicalStatus
// are pure functions and are the shared rule this gate is being tested against
// -- stubbing them out would test the mock instead of the time bound.
jest.mock('./shadowMedicalStatus', () => {
  const actual = jest.requireActual('./shadowMedicalStatus');
  return { ...actual, getLatestMedicalAdministrativeStatus: jest.fn() };
});

jest.mock('./shadowNearMisses', () => ({
  flagNearMiss: jest.fn().mockResolvedValue({ near_miss_id: 'nm-1' }),
  findNearMissByTriggerContext: jest.fn().mockResolvedValue(null),
}));

jest.mock('./safetyGateMatrix', () => ({
  getSafetyGateDefinition: jest.fn().mockResolvedValue({
    gate_id: 'gate_punxsy_prominence_contact_medical_clearance',
    gate_key: 'contact_medical_clearance',
    name: 'Contact Requires Medical Clearance',
    category: 'medical',
    enforcement: 'flag',
    requirement_text: 'Set status to cleared before contact continues (test gate text).',
    active_flag: true,
  }),
  recordSafetyGateEvaluation: jest.fn().mockResolvedValue(undefined),
}));

const mockStatus = getLatestMedicalAdministrativeStatus as jest.Mock;
const mockFlag = flagNearMiss as jest.Mock;
const mockFindExisting = findNearMissByTriggerContext as jest.Mock;
const mockGetGate = getSafetyGateDefinition as jest.Mock;
const mockRecordEvaluation = recordSafetyGateEvaluation as jest.Mock;

function call(overrides: Partial<Parameters<typeof flagContactWithoutClearance>[0]> = {}) {
  return flagContactWithoutClearance({
    organizationId: 'punxsy_prominence',
    athleteId: 'Neeko-001',
    kind: 'contact_level',
    value: 3,
    actorAccountId: 'nneale',
    actorRole: 'athlete',
    contextId: 'sparring_123',
    observedAt: '2026-07-29T12:00:00.000Z',
    ...overrides,
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('which observations count as contact', () => {
  test.each([...CONTACT_OBSERVATION_KINDS])('%s with a positive value is contact', (kind) => {
    expect(isContactObservation(kind, 1)).toBe(true);
  });

  // Zero is the athlete recording that there was NO contact -- "None" is the 0
  // position on the contact-level slider. Flagging that would punish accurate
  // reporting, which is the opposite of what this gate is for.
  test.each([...CONTACT_OBSERVATION_KINDS])('%s with value 0 is not contact', (kind) => {
    expect(isContactObservation(kind, 0)).toBe(false);
  });

  test('a null reading is not contact', () => {
    expect(isContactObservation('contact_level', null)).toBe(false);
  });

  // Bag and mitt work produce these too, so treating them as contact would flag
  // ordinary conditioning.
  test.each(['punch_attempted', 'punch_landed', 'session_rpe', 'body_weight'])(
    '%s is not contact even with a high value',
    (kind) => {
      expect(isContactObservation(kind, 50)).toBe(false);
    },
  );
});

describe('a cleared athlete is never flagged', () => {
  test('no near miss is raised', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'cleared' });

    await expect(call()).resolves.toEqual({ flagged: false });
    expect(mockFlag).not.toHaveBeenCalled();
  });

  test('a clearance with an expiry still ahead of it is not flagged', async () => {
    const wellAhead = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    mockStatus.mockResolvedValueOnce({ status: 'cleared', expires_at: wellAhead });

    await expect(call()).resolves.toEqual({ flagged: false });
    expect(mockFlag).not.toHaveBeenCalled();
  });
});

// The finding this closes: this gate compared `record?.status === 'cleared'`
// with no time bound, so a clearance recorded once counted forever. The
// observation is still kept either way -- that doctrine does not change -- but
// contact under a lapsed clearance now raises the near miss it always should
// have.
describe('a clearance that has lapsed is not read as cleared', () => {
  const LAPSED = { status: 'cleared', expires_at: '2026-01-01T00:00:00.000Z' };

  test('contact under an expired clearance is flagged', async () => {
    mockStatus.mockResolvedValueOnce(LAPSED);

    await expect(call()).resolves.toEqual({
      flagged: true,
      medicalStatus: 'cleared_expired',
      severity: 'high',
      lesson: GATE_LESSON,
    });
    expect(mockFlag).toHaveBeenCalledTimes(1);
  });

  test('the near miss says the clearance expired, not that the status is unrecognised', async () => {
    mockStatus.mockResolvedValueOnce(LAPSED);

    await call();

    const { description, metadata } = mockFlag.mock.calls[0][0];
    expect(description).toContain('expiry');
    expect(metadata).toMatchObject({ medical_status: 'cleared_expired' });
  });

  test('the Safety Gate Matrix records it as flagged, not passed', async () => {
    mockStatus.mockResolvedValueOnce(LAPSED);

    await call();

    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      gateKey: 'contact_medical_clearance',
      outcome: 'flagged',
    }));
  });

  // An expired clearance is a lapse, not an affirmative "must not take
  // contact" -- so it belongs with pending/no_record at 'high', not with
  // restricted/not_cleared at 'critical'.
  test('the severity is high, the same as never having recorded one', async () => {
    mockStatus.mockResolvedValueOnce(LAPSED);

    const outcome = await call();

    expect(outcome.severity).toBe('high');
  });
});

describe('contact without a current clearance raises a near miss', () => {
  // An affirmative medical decision that this athlete must not take contact,
  // overridden -- the most serious version of this.
  test.each(['not_cleared', 'restricted'])('%s is critical', async (status) => {
    mockStatus.mockResolvedValueOnce({ status });

    await expect(call()).resolves.toEqual({ flagged: true, medicalStatus: status, severity: 'critical', lesson: GATE_LESSON });
    expect(mockFlag).toHaveBeenCalledTimes(1);
  });

  // Nobody has decided yet: a real gap needing review, but a process failure
  // rather than a known contraindication being ignored.
  test('pending is high', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'pending' });

    await expect(call()).resolves.toEqual({ flagged: true, medicalStatus: 'pending', severity: 'high', lesson: GATE_LESSON });
  });

  test('no record at all is high, and reported as no_record', async () => {
    mockStatus.mockResolvedValueOnce(null);

    await expect(call()).resolves.toEqual({ flagged: true, medicalStatus: 'no_record', severity: 'high', lesson: GATE_LESSON });
  });

  test('the near miss is system-detected and carries the triggering detail', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });

    await call({ kind: 'punch_absorbed', value: 14 });

    expect(mockFlag).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'punxsy_prominence',
      athleteId: 'Neeko-001',
      detectedBy: 'system',
      detectedByAccountId: 'nneale',
      severity: 'critical',
      metadata: expect.objectContaining({
        trigger: 'contact_observation_without_medical_clearance',
        observation_kind: 'punch_absorbed',
        observation_value: 14,
        medical_status: 'not_cleared',
        context_id: 'sparring_123',
      }),
    }));
  });

  test('the description says the observation was kept, so a reviewer is not hunting for a rejected record', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });

    await call();

    const { description } = mockFlag.mock.calls[0][0];
    expect(description).toContain('Neeko-001');
    expect(description).toMatch(/kept|must not be discarded/);
  });
});

describe('non-contact observations never reach the medical lookup', () => {
  // Not merely "is not flagged": a body-weight log must not cost a database
  // round trip on every submission. Extended to the matrix lookup too --
  // generalizing the gate must not undo the original optimization.
  test('no status lookup and no gate lookup happens for a non-contact kind', async () => {
    await expect(call({ kind: 'body_weight', value: 72 })).resolves.toEqual({ flagged: false });
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockGetGate).not.toHaveBeenCalled();
  });

  test('no status lookup happens for zero contact', async () => {
    await expect(call({ kind: 'contact_level', value: 0 })).resolves.toEqual({ flagged: false });
    expect(mockStatus).not.toHaveBeenCalled();
  });
});

describe('a failure while flagging propagates', () => {
  // The route calls this before persisting the observation precisely so that a
  // flagging failure aborts the request instead of storing contact silently.
  // Swallowing the error here would defeat that.
  test('does not swallow the error', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });
    mockFlag.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(call()).rejects.toThrow('database unavailable');
  });
});

describe('every evaluation is recorded through the Safety Gate Matrix, pass or flag', () => {
  test('a cleared athlete records a passed evaluation', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'cleared' });

    await call();

    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'punxsy_prominence',
      gateKey: 'contact_medical_clearance',
      athleteId: 'Neeko-001',
      outcome: 'passed',
    }));
  });

  test('a flagged athlete records a flagged evaluation, in addition to the near miss', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });

    await call();

    expect(mockFlag).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
    expect(mockRecordEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      gateKey: 'contact_medical_clearance',
      outcome: 'flagged',
      reason: expect.stringContaining('Neeko-001'),
    }));
  });

  test('non-contact observations record no evaluation either', async () => {
    await call({ kind: 'body_weight', value: 72 });
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });
});

describe('an organization can deactivate the gate without a code change', () => {
  test('active_flag: false skips both the near miss and the evaluation record', async () => {
    mockGetGate.mockResolvedValueOnce({
      gate_id: 'gate_punxsy_prominence_contact_medical_clearance',
      gate_key: 'contact_medical_clearance',
      name: 'Contact Requires Medical Clearance',
      category: 'medical',
      enforcement: 'flag',
      requirement_text: GATE_LESSON,
      active_flag: false,
    });

    await expect(call()).resolves.toEqual({ flagged: false });

    // Deactivated means no monitoring at all for this org, not "monitor but
    // never flag" -- the medical status lookup itself is skipped.
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });
});

describe('a missing gate row (pre-migration organization) still fails toward alerting', () => {
  test('falls back to a plain-language lesson rather than an empty one', async () => {
    mockGetGate.mockResolvedValueOnce(null);
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });

    const result = await call();

    expect(result.flagged).toBe(true);
    expect(result.lesson).toEqual(expect.stringContaining('cleared'));
    expect(mockFlag).toHaveBeenCalledTimes(1);
  });

  // pilot.safety_gate_evaluations foreign-keys to (organization_id, gate_key)
  // in pilot.safety_gates. Recording an evaluation with no matching gate row
  // would violate that constraint and abort the whole request -- the near
  // miss above must land regardless, so recording is skipped rather than
  // attempted and left to fail.
  test('does not attempt to record an evaluation with no gate row to reference', async () => {
    mockGetGate.mockResolvedValueOnce(null);
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });

    await call();

    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });

  test('a cleared athlete with no gate row is still not flagged, and records nothing', async () => {
    mockGetGate.mockResolvedValueOnce(null);
    mockStatus.mockResolvedValueOnce({ status: 'cleared' });

    await expect(call()).resolves.toEqual({ flagged: false });
    expect(mockRecordEvaluation).not.toHaveBeenCalled();
  });
});

describe('one near miss per session, not per contact observation', () => {
  // A single sparring submission posts contact_level, contact_rounds, and
  // punch_absorbed as separate requests with the SAME contextId. Without
  // dedup, one uncleared session filed three near-identical near misses and
  // three open escalations -- and three same-trigger rows then read to the
  // repeated-pattern detector as a pattern, which is supposed to mean
  // repeated SESSIONS.
  test('a second contact observation in the same session does not file a second near miss', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });
    mockFindExisting.mockResolvedValueOnce({ near_miss_id: 'nm-existing' });

    const result = await call({ kind: 'punch_absorbed', value: 9 });

    expect(mockFlag).not.toHaveBeenCalled();
    // The caller still learns the truth: this observation IS flagged, with
    // the same severity and lesson the first one carried.
    expect(result.flagged).toBe(true);
    expect(result.severity).toBe('critical');
    expect(result.lesson).toBe(GATE_LESSON);
    // The evaluation audit trail still records that this observation was
    // checked -- that table is the audit trail, not the alert surface.
    expect(mockRecordEvaluation).toHaveBeenCalledTimes(1);
  });

  test('the dedup key is athlete + trigger + context', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'pending' });
    mockFindExisting.mockResolvedValueOnce(null);

    await call({ kind: 'contact_level', value: 2 });

    expect(mockFindExisting).toHaveBeenCalledWith(
      'punxsy_prominence',
      'Neeko-001',
      'contact_observation_without_medical_clearance',
      'sparring_123',
    );
    expect(mockFlag).toHaveBeenCalledTimes(1);
  });

  test('the same athlete in a NEW session is flagged fresh', async () => {
    mockStatus.mockResolvedValueOnce({ status: 'not_cleared' });
    mockFindExisting.mockResolvedValueOnce(null);

    await call({ contextId: 'sparring_next_week' });

    expect(mockFlag).toHaveBeenCalledTimes(1);
  });
});
