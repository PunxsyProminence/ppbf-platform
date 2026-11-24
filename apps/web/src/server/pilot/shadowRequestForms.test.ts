// Overwatch Q14 A on PR #2151 (PR #2151 reviewer A): an invisible character inside a word no longer
// hides an emergency from the SHADOW chat request check. Each hidden case gets exactly the answer
// its plain spelling gets, and plain text keeps validateShadowRequest's own answer.

import { classifyHighRiskTopic, validateShadowRequest } from './shadowChat';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CRITICAL_REVIEW_TOPICS, HIGH_RISK_TOPIC_ORDER, validateShadowRequestInEveryForm } from './shadowRequestForms';

const check = (message: string) => validateShadowRequestInEveryForm(message, 'athlete', 'org-test');

describe('invisible characters inside a word (Q14)', () => {
  test.each([
    ["I can't bre\u200Bathe", "I can't breathe", 'urgent_symptom'],
    ['I cant bre\u200Bathe', 'I cant breathe', 'urgent_symptom'],
    ['I have ch\u200Best pain', 'I have chest pain', 'chest_pain'],
    ['my friend pa\u00ADssed out at practice', 'my friend passed out at practice', 'loss_of_consciousness'],
    ['I can\u200B’t breathe after that hit', 'I can’t breathe after that hit', 'urgent_symptom'],
  ])('%j gets the answer %j gets', (hidden, plain, topic) => {
    // The classifier reads the topic in the form with the invisible character removed...
    expect(classifyHighRiskTopic(plain).topic).toBe(topic);
    expect(classifyHighRiskTopic(hidden.replace(/[\u200B\u00AD]/g, '')).topic).toBe(topic);
    // ...which the typed form alone does not give (the gap this closes).
    expect(validateShadowRequest(hidden, 'athlete', 'org-test').classification).not.toBe('urgent_personal_symptom');

    const answer = check(hidden);
    expect(answer).toEqual(validateShadowRequest(plain, 'athlete', 'org-test'));
    expect(answer.valid).toBe(false);
    expect(answer.classification).toBe('urgent_personal_symptom');
  });

  // The Q14 delta reviewer: an invisible character IN PLACE of a space joins the words when removed,
  // so it is also read as a space.
  test.each([
    ["I can't\u200Bbreathe", "I can't breathe"],
    ['I have chest\u200Bpain', 'I have chest pain'],
    ['my friend passed\u200Bout at practice', 'my friend passed out at practice'],
  ])('%j, an invisible character in place of a space, gets the answer %j gets', (hidden, plain) => {
    const answer = check(hidden);
    expect(answer).toEqual(validateShadowRequest(plain, 'athlete', 'org-test'));
    expect(answer.classification).toBe('urgent_personal_symptom');
  });

  // Codex P1 on PR #2151: an educational question with a hidden high-risk topic is valid in every
  // form, so neither the emergency step nor the withhold step picks it. It must still come back
  // high-risk, as its plain spelling does, so the chat route takes the high-risk path.
  test.each([
    ['what is ch\u200Best pain', 'what is chest pain'],
    ['what is chest\u200Bpain', 'what is chest pain'],
  ])('%j, a hidden high-risk topic in a question, gets the answer %j gets', (hidden, plain) => {
    const plainAnswer = validateShadowRequest(plain, 'athlete', 'org-test');
    expect(plainAnswer.valid).toBe(true);
    expect(plainAnswer.highRisk).toBe(true);
    // The typed form alone does not read the topic (the gap this closes).
    expect(validateShadowRequest(hidden, 'athlete', 'org-test').highRisk).not.toBe(true);

    expect(check(hidden)).toEqual(plainAnswer);
  });

  // PR #2152 reviewers: two invisible characters doing different jobs, and two topics.
  test.each([
    ["I can't\u200Bbre\u200Bathe after that hit", "I can't breathe after that hit"],
    ["I can\u200B't\u200Bbreathe after that hit", "I can't breathe after that hit"],
    ['what is ch\u200Best\u200Bpain', 'what is chest pain'],
    ['what is ch\u200Best pain and surgery', 'what is chest pain and surgery'],
    ["I can't\u2800breathe after that hit", "I can't breathe after that hit"],
    ["I can't bre\u200Aathe after that hit", "I can't breathe after that hit"],
    ["I can't bre\u2009athe after that hit", "I can't breathe after that hit"],
  ])('%j gets the answer %j gets', (hidden, plain) => {
    expect(check(hidden)).toEqual(validateShadowRequest(plain, 'athlete', 'org-test'));
  });

  // PR #2154 safety reviewer: a topic the route files as critical ranks first, so a hidden topic
  // never drops the review row from critical to high (main gave chest_pain for both).
  test.each([
    'what is chest pain and con\u200Bcussion',
    'what is con\u200Bcussion and chest pain',
  ])('%j keeps the critical topic', (hidden) => {
    const answer = check(hidden);
    expect(answer.highRisk).toBe(true);
    expect(answer.topic).toBe('chest_pain');
  });

  // PR #2154 reviewers: emoji (variation selectors, joiners) do not use up the combinations.
  test('six emoji hearts do not switch off the combined readings', () => {
    const answer = check("I can't\u200Bbre\u200Bathe after that hit " + '\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F');
    expect(answer.classification).toBe('urgent_personal_symptom');
    expect(answer.valid).toBe(false);
  });

  test('times with a narrow space do not switch off the combined readings', () => {
    const answer = check("I can't\u200Bbre\u200Bathe after that hit" + ' at 5:00\u202FPM'.repeat(5));
    expect(answer.classification).toBe('urgent_personal_symptom');
  });

  test("CRITICAL_REVIEW_TOPICS is the chat route's own critical list", () => {
    const route = readFileSync(join(__dirname, '../../../app/api/pilot/shadow/chat/route.ts'), 'utf8');
    const list = /const reviewIsCritical = \[([^\]]*)\]/.exec(route)?.[1] ?? '';
    const topics = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(topics.filter((t) => t !== 'urgent_personal_symptom').sort()).toEqual([...CRITICAL_REVIEW_TOPICS].sort());
  });

  test("HIGH_RISK_TOPIC_ORDER is classifyHighRiskTopic's own order", () => {
    const probe: Record<string, string> = {
      concussion: 'concussion', head_trauma: 'head injury', loss_of_consciousness: 'passed out',
      dizziness: 'dizziness', dehydration: 'dehydration', weight_cutting: 'cut weight',
      rapid_weight_loss: 'fast weight loss', chest_pain: 'chest pain', fainting: 'fainting',
      medication: 'taking medication', prescription: 'prescription', surgery: 'surgery',
      injection: 'injection', return_to_play: 'return to play', medical_clearance: 'medical clearance',
      youth_safety: 'child safety', urgent_symptom: 'headache',
    };
    expect(Object.keys(probe).sort()).toEqual([...HIGH_RISK_TOPIC_ORDER].sort());
    for (const topic of HIGH_RISK_TOPIC_ORDER) {
      expect(classifyHighRiskTopic(`what is ${probe[topic]}`).topic).toBe(topic);
    }
    for (let i = 0; i + 1 < HIGH_RISK_TOPIC_ORDER.length; i += 1) {
      const [first, next] = [HIGH_RISK_TOPIC_ORDER[i], HIGH_RISK_TOPIC_ORDER[i + 1]];
      expect(classifyHighRiskTopic(`what is ${probe[next]} and ${probe[first]}`).topic).toBe(first);
    }
  });

  test('a message withheld only in its typed form stays withheld', () => {
    // Stripped, "myshoulder hurts" is not personal to any pattern; typed, it is withheld.
    expect(validateShadowRequest('myshoulder hurts', 'athlete', 'org-test').valid).toBe(true);
    const answer = check('my\u200Bshoulder hurts');
    expect(answer).toEqual(validateShadowRequest('my\u200Bshoulder hurts', 'athlete', 'org-test'));
    expect(answer.valid).toBe(false);
  });

  test('plain text has one form and gets validateShadowRequest\'s own answer', () => {
    for (const text of [
      'How do I throw a better jab?',
      'What causes fainting?',
      'my knee hurts after sparring',
      "I can't breathe",
      'how do i cut weight fast',
      'Should I take this medication?',
    ]) {
      expect(check(text)).toEqual(validateShadowRequest(text, 'athlete', 'org-test'));
    }
  });

  test('ordinary text whose only invisible character is in an emoji keeps its answer', () => {
    for (const text of ['thanks coach ❤\uFE0F the app is great', 'our family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} loves the gym']) {
      expect(check(text)).toEqual({ valid: true, highRisk: false, topic: 'none' });
    }
  });
});
