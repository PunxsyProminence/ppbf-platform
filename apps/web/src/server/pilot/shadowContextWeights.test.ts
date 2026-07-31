import { detectQueryType } from './shadowContextWeights';

describe('detectQueryType', () => {
  test('classifies plain technique and recovery queries', () => {
    expect(detectQueryType('How do I throw a better jab?')).toBe('technique');
    expect(detectQueryType('I am sore and not recovering between sessions')).toBe('recovery');
  });

  test('resolves score ties to safety, not insertion order', () => {
    // "weight cut" is a keyword in BOTH training and safety. The old
    // insertion-order tie-break sent every weight-cut query to training --
    // the one category built to catch risk lost exactly the queries it
    // shares with another list.
    expect(detectQueryType('weight cut')).toBe('safety');
  });

  test('returns general when nothing matches', () => {
    expect(detectQueryType('hello there')).toBe('general');
  });
});
