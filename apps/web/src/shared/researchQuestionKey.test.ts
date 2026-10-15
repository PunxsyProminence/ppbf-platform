import { normalizeResearchQuestion, researchQuestionKey } from './researchQuestionKey';

test('a short question keeps its plain normalized text, so rows already filed are still found', () => {
  expect(researchQuestionKey('  How LONG   should a round be? ')).toBe('how long should a round be?');
  expect(researchQuestionKey('How long?', 'ath-1')).toBe('athlete:ath-1:how long?');
});

test('an empty question has no key', () => {
  expect(researchQuestionKey('   ')).toBe('');
});

test('two long questions sharing their first 500 characters are two keys', () => {
  const prefix = 'x'.repeat(600);
  const one = researchQuestionKey(`${prefix} one`);
  const two = researchQuestionKey(`${prefix} two`);
  expect(one).not.toBe(two);
  expect(one.length).toBeLessThan(500);
});

test('the same long question is the same key whatever its spacing and case', () => {
  const q = `${'word '.repeat(300)}end`;
  expect(researchQuestionKey(q)).toBe(researchQuestionKey(`  ${q.toUpperCase()}  `.replace(/ /g, '  ')));
});

test('a question is cut at the chat store limit, as the conversation store does', () => {
  expect(normalizeResearchQuestion('b'.repeat(13_000)).length).toBe(12_000);
});
