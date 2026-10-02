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
- The gym's dry, dark, sarcastic humor is part of how this place talks. Use it the way a coach who likes the kid would: aim it at the mistake, the excuse or the situation, not at the kid. Keep the language clean.
- Hold them to it. Do not make excuses for them or take the responsibility off them: the mistake is theirs to own and theirs to fix. Being treated badly by someone else is not a mistake and not an excuse.
- Short sentences. Plain words -- about an 8th-grade reading level.
- Define any training or medical term in a few words the first time you use it.
- Point them toward their coach for decisions rather than toward long theory.`;

const PARENT_REGISTER = `## AUDIENCE REGISTER
You are speaking with a parent or guardian. Assume no boxing or sports-science background.
- Plain language. Explain any technical or platform term the first time it appears, including evidence labels like RESEARCH NEEDED.
- Respectful. The gym's dry, dark humor is welcome: aim it at the situation, never at the parent or their child. Put the plain meaning beside any gym slang.
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

// OD-2026-09-30-006: high-risk questions get education, not a refusal. The model
// copies its examples, and the old diagnosis example opened with "that's not my
// lane" and taught only if asked again -- measured on 2026-10-01, a sore
// shoulder was answered "stop sparring ... get checked" with no teaching.
describe('teach first', () => {
  test('the base prompt orders health answers: teach, coach, then the limit', () => {
    // The exact category list, not just the words TEACH FIRST. Weight-cut
    // education is a separate piece of work with its own sources and limits;
    // naming weight here would change those answers through this heading.
    const heading = SHADOW_SYSTEM_PROMPT.split('\n').find((line) => line.startsWith('TEACH FIRST'));
    expect(heading).toBe('TEACH FIRST — PAIN, INJURY, HEAD KNOCKS AND RECOVERY QUESTIONS:');
    expect(SHADOW_SYSTEM_PROMPT).toContain('Never open with what you cannot do');
    expect(SHADOW_SYSTEM_PROMPT).toContain('Never answer with only "see a professional"');
    const teach = SHADOW_SYSTEM_PROMPT.indexOf('1. Teach the thing');
    const coach = SHADOW_SYSTEM_PROMPT.indexOf('2. Say what to tell the coach');
    const limit = SHADOW_SYSTEM_PROMPT.indexOf('3. Last, in one sentence, say what you cannot do');
    expect(teach).toBeGreaterThan(-1);
    expect(coach).toBeGreaterThan(teach);
    expect(limit).toBeGreaterThan(coach);
  });

  test('teaching does not loosen the doctrine', () => {
    expect(SHADOW_SYSTEM_PROMPT).toContain('1. Never diagnose a condition');
    expect(SHADOW_SYSTEM_PROMPT).toContain('2. Never prescribe treatment or medication.');
    expect(SHADOW_SYSTEM_PROMPT).toContain('3. Never grant medical clearance or return-to-play approval.');
    expect(SHADOW_SYSTEM_PROMPT).toContain('Do not prescribe exercises, stretches, ice, heat or medication as treatment');
  });

  test('the health examples teach before they state the limit', () => {
    for (const heading of ['EXAMPLE — diagnosis request', 'EXAMPLE — soreness after training']) {
      const start = SHADOW_SYSTEM_PROMPT.indexOf(heading);
      expect(start).toBeGreaterThan(-1);
      const next = SHADOW_SYSTEM_PROMPT.indexOf('EXAMPLE —', start + heading.length);
      const example = SHADOW_SYSTEM_PROMPT.slice(start, next === -1 ? undefined : next);
      const body = example.slice(example.indexOf('\n') + 1);
      const limit = body.indexOf("I can't tell you");
      expect(limit).toBeGreaterThan(body.length / 2);
      expect(body).toContain('Tell your coach');
    }
  });

  test('the deflect-first example is gone', () => {
    expect(SHADOW_SYSTEM_PROMPT).not.toContain("that's not my lane");
    expect(SHADOW_SYSTEM_PROMPT).not.toContain('Want that?');
  });
});

// The register is prompt text. The urgent and emergency replies are canned
// strings returned before any model is called, so no register -- and no humor
// -- can reach them. Pinned byte for byte, for an athlete, a parent and a coach.
// validateShadowRequest ignores its role argument today, so the cross-role
// equality bites only if someone makes it role-aware; the toBe on the text is
// the pin that bites now. It does not cover FALLBACK_RESPONSES in the route.
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

  test('a parent quick round gets the parent register', () => {
    const prompt = composeShadowSystemPrompt({ role: 'parent', sessionType: 'quick_round' });
    expect(prompt).toContain(PARENT_REGISTER);
    expect(prompt).not.toContain(ATHLETE_REGISTER);
  });

  test('a coach heavy bag gets long-form and the staff register', () => {
    const prompt = composeShadowSystemPrompt({ role: 'coach', sessionType: 'heavy_bag' });
    expect(prompt).not.toContain('150 words');
    expect(prompt).toContain('full technical register');
  });
});
