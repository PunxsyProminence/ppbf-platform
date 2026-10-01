import {
  SHADOW_SYSTEM_PROMPT,
  buildRegisterPrompt,
  buildResponseLengthPrompt,
  composeShadowSystemPrompt,
  validateShadowRequest,
} from './shadowChat';

// The base prompt had no length guidance and one line of youth protection, and
// the measured result was 14-17k characters per answer in a single register for
// every audience. These tests pin the composition rules that fix that: a word
// budget on the quick tiers, and a register selected from the authenticated
// role rather than left to the model's judgment.

describe('response length budget', () => {
  test.each(['quick_round', 'recovery_round'])('%s carries the 150-word budget', (sessionType) => {
    const prompt = buildResponseLengthPrompt(sessionType);
    expect(prompt).toContain('150 words');
    expect(prompt).toContain('Lead with the answer');
  });

  test.each(['heavy_bag', 'film_study', 'scout_report', 'board_summary'])(
    '%s stays long-form and is never capped at 150 words',
    (sessionType) => {
      const prompt = buildResponseLengthPrompt(sessionType);
      expect(prompt).not.toContain('150 words');
      expect(prompt).toContain('Long-form');
    },
  );

  test('the budget explicitly subordinates itself to safety text', () => {
    // A model told to be brief trims the deferral first unless told not to.
    // If this line disappears, brevity starts competing with doctrine.
    const prompt = buildResponseLengthPrompt('quick_round');
    expect(prompt).toContain('Safety text always wins');
    expect(prompt).toMatch(/Never shorten or drop a required medical deferral/);
  });
});

// Owner, 2026-10-01: "dark humor for everyone that part of the gym identity",
// and on the athlete wording, "A but it should not take responsibility away
// from the kid or make excuses for them". Both registers are pinned whole:
// this text is read by a model talking to minors, so a reworded line should
// fail here and be looked at, not slip through a toContain.
const ATHLETE_REGISTER = `## AUDIENCE REGISTER
You are speaking with an athlete. Assume they may be a minor.
- The gym's dry, dark humor is part of how this place talks. Use it the way a coach who likes the kid would: aim it at the mistake, the excuse or the situation, not at the kid. Keep the language clean.
- Hold them to it. Do not make excuses for them or take the responsibility off them: the mistake is theirs to own and theirs to fix.
- Short sentences. Plain words -- about an 8th-grade reading level.
- Define any training or medical term in a few words the first time you use it.
- Point them toward their coach for decisions rather than toward long theory.`;

const PARENT_REGISTER = `## AUDIENCE REGISTER
You are speaking with a parent or guardian. Assume no boxing or sports-science background.
- Plain language. Explain any technical or platform term the first time it appears, including evidence labels like RESEARCH NEEDED.
- The gym's dry, dark humor is welcome. Put the plain meaning beside any gym slang.
- Be clear about what needs a coach or medical professional, and how to reach one.`;

const STAFF_REGISTER = `## AUDIENCE REGISTER
You are speaking with staff. Use the full technical register: precise terminology, direct analysis, and the complete persona defined above.`;

describe('audience register', () => {
  test('the athlete register is exactly the approved text', () => {
    expect(buildRegisterPrompt('athlete')).toBe(ATHLETE_REGISTER);
  });

  test('athletes are still assumed minors, in clean language, at a plain reading level', () => {
    const prompt = buildRegisterPrompt('athlete');
    expect(prompt).toContain('Assume they may be a minor');
    expect(prompt).toContain('Keep the language clean');
    expect(prompt).toContain('8th-grade');
  });

  test('the athlete register no longer forbids the humor the base persona asks for', () => {
    const prompt = buildRegisterPrompt('athlete');
    expect(prompt).not.toContain('No dark or sarcastic humor');
    expect(prompt).toContain('not at the kid');
    expect(prompt).toContain('Do not make excuses for them or take the responsibility off them');
  });

  test('the parent register is exactly the approved text', () => {
    expect(buildRegisterPrompt('parent')).toBe(PARENT_REGISTER);
  });

  test.each(['coach', 'organization_admin', 'admin', 'platform_owner', 'staff', 'volunteer'])(
    '%s keeps the full technical register, unchanged',
    (role) => {
      expect(buildRegisterPrompt(role)).toBe(STAFF_REGISTER);
    },
  );
});

// The register is prompt text. The urgent and emergency replies are canned
// strings returned before any model is called, so no register -- and no humor
// -- can reach them. Pinned byte for byte, for an athlete and for staff.
describe('canned urgent replies do not vary with the audience', () => {
  const EMERGENCY = 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.';
  const PERSONAL_HEALTH = 'Personal pain, injury, and treatment questions require evaluation by a qualified medical professional. SHADOW can only provide general educational information.';

  test.each([
    ['I cannot breathe after that hit', EMERGENCY],
    ['I have a headache and blurry vision right now', EMERGENCY],
    ['I passed out during training', EMERGENCY],
    ['My shoulder is sore after sparring', PERSONAL_HEALTH],
  ])('%s', (message, expected) => {
    const asAthlete = validateShadowRequest(message, 'athlete', 'org-1');
    const asParent = validateShadowRequest(message, 'parent', 'org-1');
    const asCoach = validateShadowRequest(message, 'coach', 'org-1');
    expect(asAthlete.valid).toBe(false);
    expect(asAthlete.error).toBe(expected);
    expect(asParent).toEqual(asAthlete);
    expect(asCoach).toEqual(asAthlete);
  });
});

describe('composed prompt', () => {
  test('doctrine and persona are carried unchanged', () => {
    const prompt = composeShadowSystemPrompt({ role: 'athlete', sessionType: 'quick_round' });
    // The audience must never change the rules, only the wording register.
    expect(prompt).toContain(SHADOW_SYSTEM_PROMPT);
    expect(prompt).toContain('DOCTRINE — NON-NEGOTIABLE');
  });

  test('an athlete quick round gets both the budget and the youth register', () => {
    const prompt = composeShadowSystemPrompt({ role: 'athlete', sessionType: 'quick_round' });
    expect(prompt).toContain('150 words');
    expect(prompt).toContain(ATHLETE_REGISTER);
  });

  test('a coach heavy bag gets long-form and the staff register', () => {
    const prompt = composeShadowSystemPrompt({ role: 'coach', sessionType: 'heavy_bag' });
    expect(prompt).not.toContain('150 words');
    expect(prompt).toContain('full technical register');
  });
});
