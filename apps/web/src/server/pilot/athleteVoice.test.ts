import fs from 'node:fs';
import path from 'node:path';

import {
  ATHLETE_VOICE_CRITICAL_CUES,
  ATHLETE_VOICE_REASON,
  ATHLETE_VOICE_TRIAGED_HIGH_CUES,
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

// ─── the cue-vocabulary drift alarm ──────────────────────────────────────────
//
// The scan module does not export its cue ids as data, so this sweeps its
// SOURCE for `id: '...'` entries and asserts the severity triage covers the
// vocabulary exhaustively in both directions. A cue ADDED or SPLIT in the
// scanner (say, sexualized-contact phrases moved out of a non-critical cue
// into their own id) must be triaged in athleteVoice.ts on purpose --
// without this sweep it would silently default to 'high' by simply not
// being in the critical set.

describe('the severity triage covers the scanner vocabulary exhaustively', () => {
  const scannerSource = fs.readFileSync(path.join(__dirname, 'feedbackSafetyScan.ts'), 'utf8');
  const scannerCueIds = [...scannerSource.matchAll(/^\s*id: '([a-z_]+)',$/gm)].map((match) => match[1]);
  const triaged = new Set([...ATHLETE_VOICE_CRITICAL_CUES, ...ATHLETE_VOICE_TRIAGED_HIGH_CUES]);

  test('the sweep itself found the vocabulary (guards against a regex rot)', () => {
    expect(scannerCueIds.length).toBeGreaterThanOrEqual(15);
    expect(scannerCueIds).toContain('crisis');
    expect(scannerCueIds).toContain('secrecy');
  });

  test('every scanner cue is triaged as critical or deliberately high', () => {
    const untriaged = scannerCueIds.filter((id) => !triaged.has(id));
    expect(untriaged).toEqual([]);
  });

  test('every triaged id still exists in the scanner (catches renames/removals)', () => {
    const scannerSet = new Set(scannerCueIds);
    const stale = [...triaged].filter((id) => !scannerSet.has(id));
    expect(stale).toEqual([]);
  });

  test('no cue is triaged both ways', () => {
    const both = ATHLETE_VOICE_CRITICAL_CUES.filter((id) => ATHLETE_VOICE_TRIAGED_HIGH_CUES.includes(id));
    expect(both).toEqual([]);
  });
});

// ─── the cue-id drift alarm ──────────────────────────────────────────────────
//
// The vocabulary sweep above proves coverage; this proves BEHAVIOR: it
// drives the REAL scanner with a canonical sentence for each critical cue
// and asserts the end-to-end severity. If a cue id is ever renamed in the
// scan module, the sentence still matches its pattern but the id no longer
// matches the critical set -- and this fails loudly instead of a crisis
// silently downgrading.

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
