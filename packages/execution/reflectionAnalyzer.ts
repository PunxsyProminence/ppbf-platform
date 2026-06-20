export function analyzeReflection(reflection: string) {
  const positiveWords = ['good', 'better', 'improved', 'great', 'progress'];
  const negativeWords = ['difficult', 'hard', 'struggle', 'tired', 'pain'];

  const lower = reflection.toLowerCase();
  const positiveCount = positiveWords.filter(w => lower.includes(w)).length;
  const negativeCount = negativeWords.filter(w => lower.includes(w)).length;

  let sentiment = 'neutral';
  if (positiveCount > negativeCount) sentiment = 'positive';
  if (negativeCount > positiveCount) sentiment = 'negative';

  return {
    sentiment,
    positiveCount,
    negativeCount,
    wordCount: reflection.split(' ').length,
  };
}
