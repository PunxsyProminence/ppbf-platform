import { SHADOW_SYSTEM_PROMPT } from './shadowChat';
import { indicatesInsufficientContext, LIBRARY_HAS_NOTHING_YET } from './shadowNoAnswer';

// F-161 (d). The prompt asked for "the Library has nothing on that yet" and the
// check did not recognise it, so an answer that declined in the prompt's own
// words was graded and labelled as if it had answered. These pin the two
// together.

// Every phrase a prompt hands the model in quotes as its "nothing here" words.
function quotedNoAnswerPhrases(prompt: string): string[] {
  return [...prompt.matchAll(/\("([^"]*\blibrary\b[^"]*\bnothing\b[^"]*)"\)/gi)].map((match) => match[1]);
}

describe('the no-answer words the prompts ask for are the words the check reads', () => {
  test('the system prompt quotes the shared phrase, and only it', () => {
    const quoted = quotedNoAnswerPhrases(SHADOW_SYSTEM_PROMPT);
    expect(quoted.length).toBeGreaterThan(0);
    for (const phrase of quoted) {
      expect(phrase).toBe(LIBRARY_HAS_NOTHING_YET);
      expect(indicatesInsufficientContext(phrase)).toBe(true);
    }
  });

  test.each([
    LIBRARY_HAS_NOTHING_YET,
    'The Library has nothing on that yet.',
    'Short answer: the Library has nothing on that yet, so ask your coach.',
    'The Library has nothing\non that yet.',
    'The Library has nothing on resting heart rate yet.',
    'The Library holds nothing on that yet.',
    // The older phrasings still count.
    'I do not have enough context to answer that.',
    'There is not enough context here.',
  ])('reads %p as a no-answer', (answer) => {
    expect(indicatesInsufficientContext(answer)).toBe(true);
  });

  test.each([
    'Heart rate climbs across the rounds of a bout.',
    'The Library has a passage on that.',
    'Nothing beats roadwork for the base.',
  ])('does not read %p as a no-answer', (answer) => {
    expect(indicatesInsufficientContext(answer)).toBe(false);
  });
});
