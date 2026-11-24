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
  shadowDisclosureFilesEscalation,
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

  test.each(['coach', 'organization_admin', 'admin', 'staff', 'volunteer', 'board', 'platform_owner'])(
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

// HF8-1 B (Jason, 2026-11-21, Q1 = B "office review only", relayed by
// Overwatch on #2083): a parent's SHADOW message gets the athlete's scan and
// the same carve-outs. A match is office review only: the org admin's SHADOW
// review row for that one exchange (OD-2026-10-07-009 ruling 4), never a
// coach alert or an escalation entry.
describe('a parent\'s message (HF8-1, Q1 = B)', () => {
  test.each(F076_SENTENCES)('a parent typing "$message" is a disclosure', ({ message, namesGymStaff: staff }) => {
    const disclosure = detectShadowDisclosure(message, 'parent');
    expect(disclosure).not.toBeNull();
    // The same reading as an athlete's, except that it files no escalation.
    expect({ ...disclosure, filesEscalation: true }).toEqual(detectShadowDisclosure(message, 'athlete'));
    expect(disclosure?.filesEscalation).toBe(false);
    expect(disclosure?.namesGymStaff).toBe(staff);
  });

  test.each(F076_SENTENCES)('an athlete\'s "$message" files an escalation', ({ message }) => {
    expect(detectShadowDisclosure(message, 'athlete')?.filesEscalation).toBe(true);
  });

  test('a parent\'s disclosure files nothing, even when an athlete id is passed', async () => {
    const disclosure = detectShadowDisclosure('My coach touched me and told me not to tell anyone', 'parent')!;
    await expect(fileShadowDisclosureEscalation({
      organizationId: 'org-1', athleteId: 'ATH-1', conversationId: 'conv-1', disclosure,
    })).resolves.toBeNull();
    expect(mockFileEscalation).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  test('the carve-outs hold for a parent as for an athlete', () => {
    expect(detectShadowDisclosure('How do I throw a better jab?', 'parent')).toBeNull();
    expect(detectShadowDisclosure('My legs are sore after roadwork, what should I stretch?', 'parent')).toBeNull();
    expect(detectShadowDisclosure('I think I broke my thumb on the bag', 'parent')).toBeNull();
    expect(detectShadowDisclosure('How do I keep my guard up when he punches me?', 'parent')).toBeNull();
  });

  test('only an athlete\'s disclosure files an escalation; a parent\'s is office review only', () => {
    expect(shadowDisclosureFilesEscalation('athlete')).toBe(true);
    for (const role of ['parent', 'coach', 'organization_admin', 'admin', 'staff', 'volunteer', 'board', 'platform_owner', '']) {
      expect(shadowDisclosureFilesEscalation(role)).toBe(false);
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

  // The emergency line is main's emergency handling, kept for a disclosure
  // too (OD-2026-10-10-006; Overwatch, F-093 Q1). The escalation still files.
  test.each([
    'My dad hits me and now I have a headache',
    'my dad hits me and now I cant breathe',
  ])('"%s" keeps the emergency return unchanged', (message) => {
    const base = validateShadowRequest(message, 'athlete', 'org');
    expect(base.classification).toBe('urgent_personal_symptom');
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'athlete'))).toBe(base);
  });

  test('an allowed high-risk result is returned unchanged', () => {
    const base = { valid: true, highRisk: true, topic: 'concussion', classification: 'concussion' } as const;
    const message = 'My dad hits me and it hurts';
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'athlete'))).toBe(base);
  });
});

// F-093: a disclosure that also trips the pain or medical request filter was
// withheld as a medical question. SHADOW still answers a disclosure
// (OD-2026-10-10-007); only the emergency return stays ahead of it.
describe('a disclosure wins over the non-emergency medical withhold', () => {
  test.each([
    'my coach hits me and it hurts',
    'My dad hits me and it hurts',
    'Coach hit me on purpose and my arm is sore',
    'my stepdad hits me and my ribs are bruised',
    'my coach touched me and it hurt',
    'my coach punches me after practice, do I have a fracture?',
    'my coach hits me, should I take medicine for the pain',
  ])('"%s" is answered on the disclosure path', (message) => {
    const base = validateShadowRequest(message, 'athlete', 'org');
    expect(base.valid).toBe(false);
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure).not.toBeNull();
    const marked = markShadowDisclosure(base, disclosure);
    expect(marked).toEqual({ valid: true, highRisk: true, topic: base.topic, classification: SHADOW_DISCLOSURE_CLASSIFICATION });
  });

  test('a pain report that is no disclosure is still withheld as main had it', () => {
    const message = 'My legs are sore after roadwork';
    const base = validateShadowRequest(message, 'athlete', 'org');
    expect(base.classification).toBe('personal_health_concern');
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'athlete'))).toBe(base);
  });

  test('a coach sending the same words is unchanged (coaches are not scanned)', () => {
    const message = 'my coach hits me and it hurts';
    const base = validateShadowRequest(message, 'coach', 'org');
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'coach'))).toBe(base);
  });

  // HF8-1 B: the F-093 change applies to a parent (Overwatch on #2083,
  // comment 7065230094: "the pain-word change (F-093) applies").
  test('a parent\'s disclosure with a pain word is answered, not withheld (F-093, Q1 = B)', () => {
    const message = 'my coach hits me and it hurts';
    const base = validateShadowRequest(message, 'parent', 'org');
    expect(base.valid).toBe(false);
    expect(base.classification).toBe('personal_health_concern');
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'parent'))).toEqual({
      valid: true, highRisk: true, topic: base.topic, classification: SHADOW_DISCLOSURE_CLASSIFICATION,
    });
  });

  test('a parent\'s disclosure with no pain word is marked high-risk and still answered (Q1 = B)', () => {
    const message = 'My dad hits me';
    const base = validateShadowRequest(message, 'parent', 'org');
    expect(base.valid).toBe(true);
    expect(base.highRisk).not.toBe(true);
    const marked = markShadowDisclosure(base, detectShadowDisclosure(message, 'parent'));
    expect(marked).toEqual({ ...base, highRisk: true, classification: SHADOW_DISCLOSURE_CLASSIFICATION });
    expect(marked.valid).toBe(true);
  });

  test('a parent\'s pain report that is no disclosure is still withheld as main had it', () => {
    const message = 'My legs are sore after roadwork';
    const base = validateShadowRequest(message, 'parent', 'org');
    expect(base.classification).toBe('personal_health_concern');
    expect(markShadowDisclosure(base, detectShadowDisclosure(message, 'parent'))).toBe(base);
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

// HF1 and Overwatch's Q1/Q2 on PR 2059 (lane HF12). Invented sentences.
describe('HF1: the new phrasings file from SHADOW chat', () => {
  test.each([
    'im suicidal',
    'kms',
    'i want to end my life',
    'i want to kill my self',
    'i don´t feel safe',
  ])('files, coach of record included: %p', (message) => {
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.adminOnly).toBe(false);
  });

  test.each([
    'my uncle molested me',
    'i got raped',
    'he groped me',
    'he asked me for nudes',
  ])('sexual abuse files admin-only and critical (Q1 = A): %p', (message) => {
    const disclosure = detectShadowDisclosure(message, 'athlete');
    expect(disclosure?.adminOnly).toBe(true);
    expect(isCriticalShadowDisclosure(disclosure)).toBe(true);
  });

  test.each([
    'i want to end my life, i hate sparring',
    'im suicidal and my jab is bad',
    'he molested me after pad work',
  ])('files even in boxing context: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).not.toBeNull();
  });

  test('crisis phrasings are critical', () => {
    expect(isCriticalShadowDisclosure(detectShadowDisclosure('im suicidal', 'athlete'))).toBe(true);
  });
});

describe('HF1: boxing talk files nothing', () => {
  test.each([
    'hit me with your best shot',
    'hit me with your best combo',
    'give me your best shot on the pads',
    'i ran 5 kms before sparring',
    'we did suicides after rounds',
    'kill it in sparring tonight',
    'this drill is killing me',
  ])('null: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).toBeNull();
  });

  test('a person outside the gym still overrides "your best shot"', () => {
    expect(detectShadowDisclosure('my dad hit me and said thats your best shot', 'athlete')).not.toBeNull();
  });

  test('naming a coach still files in boxing context (Overwatch 2026-10-15, decision 2)', () => {
    expect(detectShadowDisclosure('coach hit me with your best shot on purpose', 'athlete')).not.toBeNull();
  });
});

describe('HF1 review: sexual abuse in the present tense routes admin-only', () => {
  test.each([
    'my uncle is sexually abusing me',
    'my uncle is sexually abusing me after sparring rounds',
    'i think he is grooming me',
  ])('admin-only: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')?.adminOnly).toBe(true);
  });
});

// HF12b (PR 2076), safeguarding review round 7: a spelled-out staff word with a
// symbol for a letter or mixed gaps routed admin-only on main and must still.
// Invented phrases.
describe('HF12b: spelled-out staff words keep main\'s routing', () => {
  test.each([
    'my c o @ c h hit me',
    'my c.o.@.c.h hits me',
    'c.o.a.c. h hit me',
    'my c o a c  h hurt me on purpose',
    'c o @ c h punched me in sparring',
    'my c o a c  h punched me in sparring',
    'my . c-o-a-c . h . broke . my . nose',
    'my c o.a.c.h hit me',
    'my c-o-a-c h broke my nose',
  ])('files admin-only: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).toEqual(expect.objectContaining({ adminOnly: true }));
  });

  test.each([
    'he got me alone n r***ped me',
    'u r***ped me',
    'he got me alone n r . ped me',
    'he_got_me_alone_n_r@ped_me',
  ])('an obfuscated word after a text-speak letter files admin-only: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).toEqual(expect.objectContaining({ adminOnly: true }));
  });

  // The spelled-out reading adds routing evidence; it never removes main's.
  test.each([
    'm y c o a c h h i t s m e',
    'he t o u c h e d m e',
  ])('a spelled-out staff or touch word routes admin-only: %p', (message) => {
    expect(detectShadowDisclosure(message, 'athlete')).toEqual(expect.objectContaining({ adminOnly: true }));
  });

  test('text-speak before the sparring-intent words still overrides boxing context', () => {
    expect(detectShadowDisclosure('he kept hitting me in sparring o k i said stop', 'athlete')).not.toBeNull();
  });
});

describe('HF12b: the spelled-out reading only adds routing evidence', () => {
  test('a spelled-out sparring-intent phrase overrides boxing context', () => {
    expect(detectShadowDisclosure('he hit me in sparring o n p u r p o s e', 'athlete')).not.toBeNull();
  });

  test('a spelled-out boxing word does not suppress a disclosure main filed', () => {
    expect(detectShadowDisclosure('he hits me when we s p a r', 'athlete')).not.toBeNull();
  });
});

// Codex P1 on #2138, Claude Science F4 (reopened PAIN-NOTES lane, 2026-11-24): an invisible
// character inside "coach" hid the staff word, so a SHADOW chat message (and a pain note, which
// uses this same check) about a coach was not filed admin-only. OD-2026-11-23-003 "A: Keep strict".
describe('invisible characters inside a staff word (SHADOW chat and pain notes)', () => {
  test.each(['\u200B', '\u200C', '\u200D', '\u2060', '\u00AD', '\uFEFF'])(
    'U+%s inside "coach" is still a staff disclosure, filed admin-only',
    (mark) => {
      const disclosure = detectShadowDisclosure(`My co${mark}ach hits me and I am scared to go to the gym`, 'athlete');
      expect(disclosure).not.toBeNull();
      expect(disclosure?.namesGymStaff).toBe(true);
      expect(disclosure?.adminOnly).toBe(true);
      expect(namesGymStaff(`my co${mark}ach`)).toBe(true);
    },
  );

  test('an invisible character as the only gap before "coach" still names the coach', () => {
    expect(detectShadowDisclosure('my\u200Bcoach hits me', 'athlete')?.adminOnly).toBe(true);
  });

  test('a routine pain note naming a coach, with a hidden character, is held as the plain one is (Q7)', () => {
    const plain = detectShadowDisclosure('hurt my wrist on the heavy bag, coach wrapped it', 'athlete');
    const hidden = detectShadowDisclosure('hurt my wrist on the heavy bag, co\u200Bach wrapped it', 'athlete');
    expect(plain?.adminOnly).toBe(true);
    expect(hidden?.adminOnly).toBe(true);
  });

  test('ordinary messages get the same verdict as before', () => {
    expect(detectShadowDisclosure('my knee hurts since practice', 'athlete')).toBeNull();
    expect(detectShadowDisclosure('how do I keep my guard up when sparring', 'athlete')).toBeNull();
    expect(detectShadowDisclosure('My dad hits me', 'athlete')?.adminOnly).toBe(false);
  });
});
