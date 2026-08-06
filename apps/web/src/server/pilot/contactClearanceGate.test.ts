import {
  CONTACT_OBSERVATION_KINDS,
  flagContactWithoutClearance,
  isContactObservation,
} from './contactClearanceGate';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from './safetyGateMatrix';
import { getLatestMedicalAdministrativeStatus } from './shadowMedicalStatus';
import { flagNearMiss } from './shadowNearMisses';

const GATE_LESSON = 'Set status to cleared before contact continues (test gate text).';

jest.mock('./shadowMedicalStatus', () => ({
  getLatestMedicalAdministrativeStatus: jest.fn(),
}));

jest.mock('./shadowNearMisses', () => ({
  flagNearMiss: jest.fn().mockResolvedValue({ near_miss_id: 'nm-1' }),
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
});
