import {
  ATHLETE_VOICE_CRITICAL_CUES,
  ATHLETE_VOICE_REASON,
  athleteVoiceSeverity,
  fileAthleteVoiceEscalation,
} from './athleteVoice';
import { queryOne } from './db';
import { fileEscalation } from './escalationLadder';
import { scanForSafetyLanguage } from './feedbackSafetyScan';

jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

jest.mock('./escalationLadder', () => ({
  fileEscalation: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;
const mockFileEscalation = jest.mocked(fileEscalation);

afterEach(() => {
  jest.clearAllMocks();
});

// ─── athleteVoiceSeverity ────────────────────────────────────────────────────

describe('athleteVoiceSeverity', () => {
  test('pain/fear language alone is high, not critical', () => {
    expect(athleteVoiceSeverity(['pain_or_injury'])).toBe('high');
    expect(athleteVoiceSeverity(['fear', 'does_not_want_to_be_there'])).toBe('high');
  });

  test('no cues at all is still high -- a safeguarding submission never files quietly', () => {
    expect(athleteVoiceSeverity([])).toBe('high');
  });

  test.each(ATHLETE_VOICE_CRITICAL_CUES.map((cue) => [cue]))('%s makes the escalation critical', (cue) => {
    expect(athleteVoiceSeverity([cue])).toBe('critical');
    // Even buried among lower-grade cues.
    expect(athleteVoiceSeverity(['pain_or_injury', cue, 'fear'])).toBe('critical');
  });
});

// ─── the cue-id drift alarm ──────────────────────────────────────────────────
//
// The critical-cue list names cue ids from feedbackSafetyScan. That module's
// ids are not exported as data, so this drives the REAL scanner with a
// canonical sentence for each critical cue and asserts the end-to-end
// severity. If a cue id is ever renamed in the scan module, the sentence
// still matches its pattern but the id no longer matches the critical set --
// and this test fails loudly instead of a crisis silently downgrading.

describe('critical severity end-to-end against the real scanner', () => {
  test.each([
    ['crisis', 'i want to kill myself'],
    ['crisis_indirect', 'sometimes i wish i was dead'],
    ['someone_is_hurting_me', 'coach mike hits me after practice'],
    ['grooming_or_isolation', 'he says its our little secret'],
    ['harm_to_someone_else', 'he hits the other kids too'],
  ])('%s: "%s" files critical', (cue, sentence) => {
    const scan = scanForSafetyLanguage(sentence);
    expect(scan.safeguarding).toBe(true);
    expect(scan.cues).toContain(cue);
    expect(athleteVoiceSeverity(scan.cues)).toBe('critical');
  });

  test('a plain pain sentence files high', () => {
    const scan = scanForSafetyLanguage('my wrist hurts when i punch');
    expect(scan.safeguarding).toBe(true);
    expect(athleteVoiceSeverity(scan.cues)).toBe('high');
  });
});

// ─── fileAthleteVoiceEscalation ──────────────────────────────────────────────

describe('fileAthleteVoiceEscalation', () => {
  const params = {
    organizationId: 'org-1',
    accountId: 'acct-athlete-1',
    submissionId: 'sub-123',
    body: 'coach mike hits me after practice',
  };

  test('resolves the athlete and files a non-disclosing, admin-routed escalation', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-1' });
    mockFileEscalation.mockResolvedValueOnce({ escalation_id: 'esc-1' } as never);

    const filed = await fileAthleteVoiceEscalation(params);

    expect(filed).toEqual({ escalation_id: 'esc-1' });
    expect(mockFileEscalation).toHaveBeenCalledWith({
      organizationId: 'org-1',
      sourceType: 'athlete_voice',
      sourceId: 'sub-123',
      athleteId: 'ATH-1',
      severity: 'critical',
      reason: ATHLETE_VOICE_REASON,
      escalatedToRole: 'organization_admin',
      triggeredBy: 'system',
      metadata: { submission_id: 'sub-123' },
    });
  });

  // The property the whole design hangs on: the escalation row travels to
  // surfaces the disclosure body must never reach.
  test('nothing filed contains any word of the submission body', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-1' });
    mockFileEscalation.mockResolvedValueOnce({ escalation_id: 'esc-1' } as never);

    await fileAthleteVoiceEscalation(params);

    const [input] = mockFileEscalation.mock.calls[0];
    const serialized = JSON.stringify({ reason: input.reason, metadata: input.metadata }).toLowerCase();
    for (const word of ['coach', 'mike', 'hits', 'practice']) {
      expect(serialized).not.toContain(word);
    }
    // And no cue ids either -- the scan module's contract is that cues are
    // never persisted.
    expect(serialized).not.toContain('someone_is_hurting_me');
    expect(serialized).not.toContain('cue');
  });

  test('severity follows the body: pain-only text files high', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ATH-1' });
    mockFileEscalation.mockResolvedValueOnce({ escalation_id: 'esc-2' } as never);

    await fileAthleteVoiceEscalation({ ...params, body: 'my wrist hurts when i punch' });

    expect(mockFileEscalation).toHaveBeenCalledWith(expect.objectContaining({ severity: 'high' }));
  });

  test('an account with no athlete record returns null and files nothing', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: null });

    await expect(fileAthleteVoiceEscalation(params)).resolves.toBeNull();
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });

  test('an unknown account returns null and files nothing', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(fileAthleteVoiceEscalation(params)).resolves.toBeNull();
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });

  test('the account lookup is scoped to the organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await fileAthleteVoiceEscalation(params);

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('organization_id = $2'),
      ['acct-athlete-1', 'org-1'],
    );
  });
});
