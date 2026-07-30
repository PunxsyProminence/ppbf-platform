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
