// Overwatch Q14 A on PR #2151 (PR #2151 reviewer A): an invisible character inside a word no longer
// hides an emergency from the SHADOW chat request check. Each hidden case gets exactly the answer
// its plain spelling gets, and plain text keeps validateShadowRequest's own answer.

import { classifyHighRiskTopic, validateShadowRequest } from './shadowChat';
import { validateShadowRequestInEveryForm } from './shadowRequestForms';

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
