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
- Point them toward their coach for decisions rather than toward long theory.
- Weight cutting, sauna, sweat suit, water loading: teach it for a young athlete. Coach-set limits are not shown to you here. Say their coach may have set limits for them, and to ask the coach what they are before doing any of it.`;

const PARENT_REGISTER = `## AUDIENCE REGISTER
You are speaking with a parent or guardian. Assume no boxing or sports-science background.
- Plain language. Explain any technical or platform term the first time it appears, including evidence labels like RESEARCH NEEDED.
- Respectful. The gym's dry, dark humor is welcome: aim it at the situation, never at the parent or their child. Put the plain meaning beside any gym slang.
- Be clear about what needs a coach or medical professional, and how to reach one.
- Weight cutting, sauna, sweat suit, water loading: teach it for a young athlete, in plain words. Coach-set limits are not shown to you here. Say the coach may have set limits for their child (heat, weight cut, contact, supervision) and that the coach has them.`;

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

// Lane S1, OD-2026-10-10-004 ruling 1 (Jason, "B: Relax for everyone": SHADOW
// teaches weight cutting safely from real sources, age-tuned, and the coach
// decides) and OD-2026-10-01-001 ("we can educate it in a safe way", "the app
// should rarely say dont"). The section is pinned whole for the same reason
// the registers are: a model talking to minors reads it. Overwatch accepted
// this text before it was built.
const WEIGHT_CUT_SECTION = `WEIGHT CUTTING, HEAT AND "AM I CLEARED" QUESTIONS — TEACH, THE COACH DECIDES:
Making weight is part of boxing, and this gym teaches it instead of hiding it. When someone asks about cutting weight, making weight, a sauna, a sweat suit, water loading or dehydration:
1. Teach how it works: what the method does in the body, what actually comes off and how fast it comes back, and why fighters use it.
2. Teach how it is done as safely as possible: the slow way before the fast way, what makes it riskier, and the warning signs that mean stop and tell the coach now.
3. Tune it to age. When the context says the athlete is a minor, or you are speaking with an athlete or a parent, teach it for a young athlete: smaller amounts, wider margins, an adult watching. Use only what the context tells you about age; do not guess one.
4. Ground it in the Library. Use what the verified evidence in your context says, and cite it. Where the Library holds nothing on a point, say so in plain words ("the Library has nothing on that yet") and do not fill the gap with a number, a schedule or a rule of your own.
5. Leave the decision with the coach. You teach; the coach decides whether, how much and when. When coach-set limits are in your context, give them as written, each with its id. When they are not, say that the coach may have set limits for this athlete and that those come first.
A question about being "cleared" to spar, train or take contact is a question about what the coach has set. Answer from the recorded contact cap when it is in your context, with its id; when it is not, say the coach sets that, and to ask them. You never clear anyone yourself, and medical clearance stays a medical professional's call.
Add no warnings, disclaimers or refusals beyond these steps. Say "don't" rarely, and only where the teaching itself calls for it.`;

describe('weight cutting, heat and "am I cleared" questions are taught', () => {
  test('the section is exactly the approved text, between TEACH FIRST and PHRASING', () => {
    expect(SHADOW_SYSTEM_PROMPT.split(WEIGHT_CUT_SECTION)).toHaveLength(2);
    const teachFirst = SHADOW_SYSTEM_PROMPT.indexOf('TEACH FIRST — PAIN, INJURY, HEAD KNOCKS AND RECOVERY QUESTIONS:');
    const section = SHADOW_SYSTEM_PROMPT.indexOf(WEIGHT_CUT_SECTION);
    const phrasing = SHADOW_SYSTEM_PROMPT.indexOf('PHRASING — A RESPONSE FILTER ENFORCES THIS:');
    expect(teachFirst).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(teachFirst);
    expect(phrasing).toBeGreaterThan(section);
    // Its own section: the TEACH FIRST block ends where it did, and the
    // section is followed by a blank line and PHRASING.
    expect(SHADOW_SYSTEM_PROMPT).toContain(`Do not prescribe exercises, stretches, ice, heat or medication as treatment.\n\n${WEIGHT_CUT_SECTION}\n\nPHRASING — A RESPONSE FILTER ENFORCES THIS:`);
  });

  test('every audience gets the same section: it is in the base prompt, not in a register', () => {
    for (const role of ['coach', 'organization_admin', 'athlete', 'parent']) {
      for (const sessionType of ['quick_round', 'heavy_bag']) {
        expect(composeShadowSystemPrompt({ role, sessionType }).split(WEIGHT_CUT_SECTION)).toHaveLength(2);
      }
    }
  });

  test('it teaches in order: how it works, as safely as possible, age, the Library, the coach decides', () => {
    const order = ['1. Teach how it works', '2. Teach how it is done as safely as possible', '3. Tune it to age', '4. Ground it in the Library', '5. Leave the decision with the coach']
      .map((step) => WEIGHT_CUT_SECTION.indexOf(step));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('it says the Library has nothing instead of filling the gap, and never guesses an age', () => {
    expect(WEIGHT_CUT_SECTION).toContain('Where the Library holds nothing on a point, say so in plain words');
    expect(WEIGHT_CUT_SECTION).toContain('do not fill the gap with a number, a schedule or a rule of your own');
    expect(WEIGHT_CUT_SECTION).toContain('Use only what the context tells you about age; do not guess one.');
  });

  test('it does not loosen the doctrine: no clearance from SHADOW, and no new warnings', () => {
    expect(WEIGHT_CUT_SECTION).toContain("You never clear anyone yourself, and medical clearance stays a medical professional's call.");
    expect(WEIGHT_CUT_SECTION).toContain('Add no warnings, disclaimers or refusals beyond these steps.');
    expect(SHADOW_SYSTEM_PROMPT).toContain('3. Never grant medical clearance or return-to-play approval.');
    expect(SHADOW_SYSTEM_PROMPT).toContain('2. Never prescribe treatment or medication.');
  });

  test('athletes and parents are pointed back to the coach-set limits; the staff register is unchanged', () => {
    expect(buildRegisterPrompt('athlete')).toContain('Say their coach may have set limits for them, and to ask the coach what they are before doing any of it.');
    expect(buildRegisterPrompt('parent')).toContain('Say the coach may have set limits for their child (heat, weight cut, contact, supervision) and that the coach has them.');
    // Limits are staff only (OD-2026-10-08-007); these two registers say so
    // in the prompt's own terms.
    for (const role of ['athlete', 'parent']) {
      expect(buildRegisterPrompt(role)).toContain('Coach-set limits are not shown to you here.');
    }
    expect(buildRegisterPrompt('coach')).toBe(STAFF_REGISTER);
  });

  // One line, under its own lead-in: the clearance rule, which lane S1 did
  // not touch and which withholds "ask your coach what you are cleared for".
  // The line gives the model a way to say the true thing.
  //
  // There is NO line about weight cutting. The reply filter on it is gone
  // (OD-2026-10-10-005 ruling 2), so there is nothing to phrase around. Two
  // earlier versions of a second line stood here: one named the old
  // patterns' trigger words (the lane's second reviewer returned CONFLICT on
  // it), one described a rule that was withdrawn. Neither may come back.
  test('PHRASING names the clearance rule a taught answer has to get past, and says nothing about weight cutting', () => {
    const lead = 'With or without a citation, the filter also WITHHOLDS your entire answer if it:';
    expect(SHADOW_SYSTEM_PROMPT.split(lead)).toHaveLength(2);
    const after = SHADOW_SYSTEM_PROMPT.slice(SHADOW_SYSTEM_PROMPT.indexOf(lead) + lead.length);
    expect(after.startsWith(`
- puts "cleared" after "you" or after "the athlete is" in the same sentence, even in "ask your coach what you are cleared for". Give a recorded contact cap as a cap ("the contact cap is <value> [E:id]"), or say "what your coach has set"
Without a supplied evidence ID,`)).toBe(true);
    expect(SHADOW_SYSTEM_PROMPT.indexOf('- states a percentage, or a count of cases, athletes, participants, or studies')).toBeLessThan(SHADOW_SYSTEM_PROMPT.indexOf(lead));
    expect(SHADOW_SYSTEM_PROMPT).not.toContain('puts cut, cutting, drop, shed or lose shortly before');
    expect(SHADOW_SYSTEM_PROMPT).not.toContain('gives a number, a set time or a "go without" instruction');
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
