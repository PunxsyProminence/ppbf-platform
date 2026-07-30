import { budgetConversationHistory } from './shadowConversationHistory';

describe('budgetConversationHistory', () => {
  test('keeps complete newest turns in original role order', () => {
    const history = [
      { role: 'user' as const, content: 'old-question' },
      { role: 'assistant' as const, content: 'old-answer' },
      { role: 'user' as const, content: 'new-question' },
      { role: 'assistant' as const, content: 'new-answer' },
    ];

    expect(budgetConversationHistory(history, { maxChars: 25, maxMessages: 10 })).toEqual([
      { role: 'user', content: 'new-question' },
      { role: 'assistant', content: 'new-answer' },
    ]);
  });

  test('does not split an oversized newest turn', () => {
    expect(budgetConversationHistory([
      { role: 'user', content: 'x'.repeat(100) },
      { role: 'assistant', content: 'y'.repeat(100) },
    ], { maxChars: 50 })).toEqual([]);
  });

  test('limits the number of messages before applying the character budget', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: String(index),
    }));
    const selected = budgetConversationHistory(history, { maxMessages: 4, maxChars: 100 });

    expect(selected.map((message) => message.content)).toEqual(['8', '9', '10', '11']);
  });
});
