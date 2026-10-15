jest.mock('./escalationLadder', () => ({
  ...jest.requireActual('./escalationLadder'),
  fileEscalation: jest.fn(async (input: Record<string, unknown>) => ({ escalation_id: 'esc-1', ...input })),
}));
jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn(async () => null), withTransaction: jest.fn() }));

import { ATHLETE_VOICE_TRIAGED_HIGH_CUES, athleteVoiceSeverity } from './athleteVoice';
import { queryOne } from './db';
import { fileEscalation } from './escalationLadder';
import { validateShadowRequest } from './shadowChat';
import {
  detectShadowDisclosure,
  fileShadowDisclosureEscalation,
  isCriticalShadowDisclosure,
  markShadowDisclosure,
  namesGymStaff,
  SHADOW_DISCLOSURE_CLASSIFICATION,
  SHADOW_DISCLOSURE_MEDICAL_ONLY_CUES,
  SHADOW_DISCLOSURE_REASON,
} from './shadowDisclosure';

const mockFileEscalation = jest.mocked(fileEscalation);

// F-076's five sentences, verbatim from LEADS-CHECK-2026-10-15 (the probe rows
// and the lead), with where each must go under OD-2026-10-01-008 s3 and
// Overwatch's staff-named exception.
export const F076_SENTENCES: ReadonlyArray<{ message: string; namesGymStaff: boolean }> = [
  { message: 'My coach hits me and I am scared to go to the gym', namesGymStaff: true },
  { message: 'My coach touched me and told me not to tell anyone', namesGymStaff: true },
  { message: 'my coach makes me stay behind after everyone leaves', namesGymStaff: true },
  { message: 'My dad hits me', namesGymStaff: false },
  { message: 'I want to kill myself', namesGymStaff: false },
];

beforeEach(() => {
  mockFileEscalation.mockClear();
  jest.mocked(queryOne).mockClear();
});

describe('detectShadowDisclosure', () => {
  test.each(F076_SENTENCES)('an athlete typing "$message" is a disclosure', ({ message, namesGymStaff: staff }) => {
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.namesGymStaff).toBe(staff);
  });

  test('a plain training question is not', () => {
    expect(detectShadowDisclosure('How do I throw a better jab?', 'athlete')).toBeNull();
  });

  test('a message whose only cues are medical files nothing (item D)', () => {
    expect(detectShadowDisclosure('My legs are sore after roadwork, what should I stretch?', 'athlete')).toBeNull();
    expect(detectShadowDisclosure('I think I broke my thumb on the bag', 'athlete')).toBeNull();
  });

  test('a medical cue with a disclosure cue still files', () => {
    expect(detectShadowDisclosure('My dad hits me and it hurts', 'athlete')).not.toBeNull();
  });

  test.each(['coach', 'parent', 'organization_admin', 'admin', 'staff', 'volunteer', 'board', 'platform_owner'])(
    'role %s is out of scope',
    (role) => {
      expect(detectShadowDisclosure('My dad hits me', role)).toBeNull();
    },
  );

  test('the medical-only cue ids are real scan cues', () => {
    for (const cue of SHADOW_DISCLOSURE_MEDICAL_ONLY_CUES) {
      expect(ATHLETE_VOICE_TRIAGED_HIGH_CUES).toContain(cue);
    }
  });
});

describe('namesGymStaff', () => {
  test.each([
    'Mr Dave touched me and told me not to tell anyone',
    'Mr. Neale makes me stay behind',
    'Miss Sarah yells at me every practice',
    'sir keeps me after when everyone leaves',
    'my coachhh hits me',
    'my cooooach touched me',
    'my c0ach touched me',
    'c o a c h touched me',
    'my coatch grabbed my arm',
    'the guy who runs the gym touched me',
    'the man who holds the pads grabbed my neck',
    'mi entrenador me pego',
    'my COACH yells at me',
    'the trainer touched me',
    'an instructor keeps me after',
    'one of the staff hits me',
    'a volunteer took a picture of me',
    'someone at the gym hurt me',
    'in the locker room he grabbed my arm',
    "my coach's friend scares me",
  ])('"%s" names gym staff', (message) => {
    expect(namesGymStaff(message)).toBe(true);
  });

  test.each(['My dad hits me', 'my brother pushes me', 'I want to kill myself', 'kids at school bully me'])(
    '"%s" does not',
    (message) => {
      expect(namesGymStaff(message)).toBe(false);
    },
  );
});

// Overwatch 2026-10-15, decision 1 (option A): ordinary sparring talk reaches
// nobody's list; the reviewer's sentences, verbatim.
describe('boxing-technique context', () => {
  test.each([
    'How do I keep my guard up when he punches me?',
    'My sparring partner keeps hitting me with his jab, how do I slip it?',
    'He hit my head with a hook in sparring, how do I block that?',
    'I get nervous about my first fight',
    'How do I stop being scared of getting hit?',
    'my new gloves are uncomfortable',
    'I dont want to spar today',
    'I hurt my wrist on the heavy bag',
  ])('"%s" files nothing', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).toBeNull();
  });

  test.each([
    // staff harm
    ['coach hits me in sparring on purpose', true],
    ['my coach punches me in the face during pad work', true],
    // intent markers
    ['My sparring partner hits me after the bell every time', false],
    ['he keeps punching me in sparring even when i tap', false],
    // crisis, grooming, secrecy, not feeling safe
    ['I want to kill myself after sparring', false],
    ['he keeps me after sparring when everyone leaves', true],
    ['I dont feel safe sparring with him', false],
    // a person or place outside the gym
    ['My dad hits me when we spar at home', false],
  ])('"%s" still files (admin-only: %s)', (message, adminOnly) => {
    const disclosure = detectShadowDisclosure(message as string, 'athlete');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.adminOnly).toBe(adminOnly);
  });

  test.each([
    'my moms partner hits me',
    'the security guard touched me',
    'my brother hits me when we fight',
  ])('an everyday sense of a boxing word does not suppress "%s"', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).not.toBeNull();
  });
});

// Overwatch 2026-10-15, decision 2: item D's exemption needs no person at the gym named.
describe('medical-only cues with a person at the gym', () => {
  test.each(['Coach hurt my arm on purpose', 'coach broke my nose'])('"%s" files admin-only', (message) => {
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.adminOnly).toBe(true);
  });

  test('a location alone is not a person: "I hurt my wrist at the gym" files nothing', () => {
    expect(detectShadowDisclosure('I hurt my wrist at the gym', 'athlete')).toBeNull();
  });
});

// Overwatch 2026-10-15, decision 3.
describe('isCriticalShadowDisclosure', () => {
  test('critical where the Tell us box files critical, and only there', () => {
    expect(isCriticalShadowDisclosure(detectShadowDisclosure('I want to kill myself', 'athlete'))).toBe(true);
    expect(isCriticalShadowDisclosure(detectShadowDisclosure('My dad hits me', 'athlete'))).toBe(true);
    expect(isCriticalShadowDisclosure(detectShadowDisclosure('I am scared of the older kids', 'athlete'))).toBe(false);
    expect(isCriticalShadowDisclosure(null)).toBe(false);
  });
});

describe('adminOnly', () => {
  test.each([
    'Dave touches me when everyone leaves',
    'he keeps me after and says its our secret',
    'My uncle touched me',
  ])('"%s" is admin-only with no staff word', (message) => {
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.namesGymStaff).toBe(false);
    expect(disclosure?.adminOnly).toBe(true);
  });

  test.each(F076_SENTENCES)('"$message" is admin-only exactly when it names staff', ({ message, namesGymStaff: staff }) => {
    expect(detectShadowDisclosure(message, 'athlete')?.adminOnly).toBe(staff);
  });
});

describe('markShadowDisclosure leaves the answer alone', () => {
  test.each(F076_SENTENCES)('"$message" becomes high-risk with no topic and no fallback key', ({ message }) => {
    const base = validateShadowRequest(message, 'athlete', 'org');
    expect(base).toEqual({ valid: true, highRisk: false, topic: 'none' });
    const marked = markShadowDisclosure(base, detectShadowDisclosure(message, 'athlete'));
    expect(marked).toEqual({ valid: true, highRisk: true, topic: 'none', classification: SHADOW_DISCLOSURE_CLASSIFICATION });
  });

  test('an already high-risk or withheld result is returned unchanged', () => {
    const message = 'My dad hits me and now I have a headache';
    const base = validateShadowRequest(message, 'athlete', 'org');
    expect(base.highRisk).toBe(true);
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'athlete'))).toBe(base);
  });

  test('no disclosure, no change', () => {
    const base = validateShadowRequest('How do I throw a better jab?', 'athlete', 'org');
    expect(markShadowDisclosure(base, null)).toBe(base);
  });
});

describe('fileShadowDisclosureEscalation', () => {
  test.each(F076_SENTENCES)('"$message" files one non-disclosing escalation to the right audience', async ({ message, namesGymStaff: staff }) => {
    const disclosure = detectShadowDisclosure(message, 'athlete')!;
    await fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: 'ATH-1', conversationId: 'conv-1', disclosure });

    expect(mockFileEscalation).toHaveBeenCalledTimes(1);
    expect(athleteVoiceSeverity(disclosure.cues)).toBe(message.includes('touched') ? 'high' : 'critical');
    const input = mockFileEscalation.mock.calls[0][0];
    expect(input).toEqual({
      organizationId: 'org-1',
      sourceType: staff ? 'athlete_voice' : 'shadow_disclosure',
      sourceId: null,
      athleteId: 'ATH-1',
      // The Tell us box's own triage: harm, grooming and crisis cues are critical.
      severity: athleteVoiceSeverity(disclosure.cues),
      reason: SHADOW_DISCLOSURE_REASON,
      escalatedToRole: staff ? 'organization_admin' : 'coach',
      triggeredBy: 'system',
      metadata: { channel: 'shadow_chat', conversation_id: 'conv-1' },
    });
    // No word of the message, and no cue id, anywhere in what is stored.
    const stored = JSON.stringify(input).toLowerCase();
    for (const word of message.toLowerCase().split(/\s+/).filter((w) => w.length > 3)) {
      if (['said', 'something', 'that', 'needs', 'person', 'read', 'admins', 'message', 'shadow', 'chat', 'athlete'].includes(word)) continue;
      expect(stored).not.toContain(word);
    }
    for (const cue of disclosure.cues) expect(stored).not.toContain(cue);
  });

  test('a conversation that already filed admin-only keeps every later disclosure admin-only', async () => {
    jest.mocked(queryOne).mockResolvedValueOnce({ found: true });
    const disclosure = detectShadowDisclosure('I want to kill myself', 'athlete')!;
    expect(disclosure.adminOnly).toBe(false);
    await fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: 'ATH-1', conversationId: 'conv-1', disclosure });

    expect(jest.mocked(queryOne)).toHaveBeenCalledWith(expect.stringContaining("source_type = 'athlete_voice'"), ['org-1', 'ATH-1', 'conv-1']);
    expect(mockFileEscalation.mock.calls[0][0]).toEqual(expect.objectContaining({
      sourceType: 'athlete_voice',
      escalatedToRole: 'organization_admin',
    }));
  });

  test('a database without the shadow_disclosure value files admin-only instead of losing it', async () => {
    mockFileEscalation.mockRejectedValueOnce(Object.assign(new Error('violates check constraint'), { code: '23514' }));
    const disclosure = detectShadowDisclosure('My dad hits me', 'athlete')!;
    await fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: 'ATH-1', conversationId: null, disclosure });

    expect(mockFileEscalation).toHaveBeenCalledTimes(2);
    expect(mockFileEscalation.mock.calls[0][0].sourceType).toBe('shadow_disclosure');
    expect(mockFileEscalation.mock.calls[1][0]).toEqual(expect.objectContaining({
      sourceType: 'athlete_voice',
      escalatedToRole: 'organization_admin',
    }));
  });

  test('any other failure is not retried', async () => {
    mockFileEscalation.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
    const disclosure = detectShadowDisclosure('My dad hits me', 'athlete')!;
    await expect(fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: 'ATH-1', conversationId: null, disclosure }))
      .rejects.toThrow('connection lost');
    expect(mockFileEscalation).toHaveBeenCalledTimes(1);
  });

  test('no athlete record files nothing', async () => {
    const disclosure = detectShadowDisclosure('My dad hits me', 'athlete')!;
    await expect(fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: null, conversationId: null, disclosure }))
      .resolves.toBeNull();
    expect(mockFileEscalation).not.toHaveBeenCalled();
  });

  test('fear alone files high, not critical', async () => {
    const disclosure = detectShadowDisclosure('I am scared of the older kids', 'athlete')!;
    await fileShadowDisclosureEscalation({ organizationId: 'org-1', athleteId: 'ATH-1', conversationId: null, disclosure });
    expect(mockFileEscalation.mock.calls[0][0].severity).toBe('high');
  });
});
