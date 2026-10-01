import {
  SHADOW_SYSTEM_PROMPT,
  buildRegisterPrompt,
  buildResponseLengthPrompt,
  composeShadowSystemPrompt,
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

describe('audience register', () => {
  test('athletes are assumed minors: no dark humor, plain reading level', () => {
    const prompt = buildRegisterPrompt('athlete');
    expect(prompt).toContain('may be a minor');
    expect(prompt).toContain('No dark or sarcastic humor');
    expect(prompt).toContain('8th-grade');
  });

  test('parents get plain language and term explanations', () => {
    const prompt = buildRegisterPrompt('parent');
    expect(prompt).toContain('parent or guardian');
    expect(prompt).toContain('Explain any technical or platform term');
    // The evidence vocabulary is exactly the jargon a parent hits first.
    expect(prompt).toContain('RESEARCH NEEDED');
  });

  test.each(['coach', 'organization_admin', 'admin', 'platform_owner', 'staff', 'volunteer'])(
    '%s keeps the full technical register',
    (role) => {
      const prompt = buildRegisterPrompt(role);
      expect(prompt).toContain('full technical register');
      expect(prompt).not.toContain('may be a minor');
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
    expect(prompt).toContain('No dark or sarcastic humor');
  });

  test('a coach heavy bag gets long-form and the staff register', () => {
    const prompt = composeShadowSystemPrompt({ role: 'coach', sessionType: 'heavy_bag' });
    expect(prompt).not.toContain('150 words');
    expect(prompt).toContain('full technical register');
  });
});
