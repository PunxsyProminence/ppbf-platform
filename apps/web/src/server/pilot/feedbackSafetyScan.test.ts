// The sentences below are written the way a twelve-year-old types them --
// lowercase, no apostrophes, misspelled, run together. A scan that only fires
// on tidy adult prose would be a scan that never fires for the person it exists
// for.
//
// The costs are not symmetric and the tests are not either. A false
// safeguarding route costs an admin thirty seconds of reading; a missed one
// costs a child the one time they worked up the nerve to type it. So the
// "routes to a human" list is long and forgiving, and the "stays product" list
// holds only sentences that are plainly about the software.

import { normalizeForSafetyScan, scanForSafetyLanguage } from './feedbackSafetyScan';

describe('language that must reach a person', () => {
  test.each([
    'someone at the gym keeps hurting me and im scared to come back',
    'my ribs hurt after practice and i didnt want to say it out loud',
    'im scared of thursday',
    'i am afraid of what happens if i show up on thursday',
    'it hurts when i spar with him and he knows',
    'coach yells at me in front of everybody and i hate it',
    'the big kids make fun of me every day',
    'he grabbed me by the arm really hard',
    'i dont want to come to practice anymore',
    'i dont wanna go on tuesdays anymore please',
    'my head hurts after i got hit and nobody noticed',
    'i think i broke my thumb but i didnt tell anyone',
    'i hide in the bathroom until my ride comes',
    'he told me not to tell anyone about it',
    'i dont feel safe in the locker room',
    'somebody keeps pushing me when the coach isnt looking',
    'i want to quit because im scaaaared',
    'im afriad to say this out loud',
    'it makes me uncomfortable when he stands that close',
    'nobody listens when i say stop',
    'my arm is bruised from wednesday',
    'i cant breathe right after conditioning and it scares me',
    'they laughed at me until i cried',
    'i want to die',
    'he wont leave me alone even when i ask',
  ])('routes to a human: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).safeguarding).toBe(true);
  });

  test('a shouted, misspelled, punctuation-free disclosure still trips it', () => {
    const result = scanForSafetyLanguage('IM SCAREDDDD!!!! HE HITS ME!!!');

    expect(result.safeguarding).toBe(true);
    expect(result.cues).toEqual(expect.arrayContaining(['fear', 'someone_is_hurting_me']));
  });

  test('curly apostrophes from a phone keyboard do not hide a disclosure', () => {
    expect(scanForSafetyLanguage('i don’t want to come back, i don’t feel safe').safeguarding).toBe(true);
  });

  // The sentence a negation-aware scan would drop, and the exact sentence that
  // most needs a person to read it.
  test('a denial does not suppress the cue it denies', () => {
    expect(scanForSafetyLanguage('im not scared of him or anything but he hits me').safeguarding).toBe(true);
    expect(scanForSafetyLanguage('nothing hurts, i just dont want to come anymore').safeguarding).toBe(true);
  });
});

describe('language about the software', () => {
  test.each([
    'the attendance page loses my selection when i scroll',
    'can you add a water break timer to the workout screen',
    'i wish the schedule showed next week too',
    'the app is broken on my moms phone',
    'the login screen took me three tries and i typed it right',
    'please make the buttons bigger on the tablet',
    'the leaderboard never updates after a session',
    'it would be cool if i could pick my own profile color',
  ])('stays in the product queue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence)).toEqual({ safeguarding: false, cues: [] });
  });

  test('an empty or whitespace-only string trips nothing', () => {
    expect(scanForSafetyLanguage('').safeguarding).toBe(false);
    expect(scanForSafetyLanguage('   \n\t  ').safeguarding).toBe(false);
  });
});

describe('normalization', () => {
  test('apostrophes close up rather than becoming word breaks', () => {
    expect(normalizeForSafetyScan("I don't")).toBe('i dont');
    expect(normalizeForSafetyScan('I don’t')).toBe('i dont');
    expect(normalizeForSafetyScan("I'm")).toBe('im');
  });

  test('a held-down key collapses without damaging ordinary words', () => {
    // Collapses to TWO, not one: collapsing to one would turn "bullying" into
    // "bulying" and "bleeding" into "bleding". scanForSafetyLanguage reads both
    // this form and the fully-collapsed one, so "sooooo" is still reachable.
    expect(normalizeForSafetyScan('sooooo scaredddd')).toBe('soo scaredd');
    expect(normalizeForSafetyScan('attendance schedule bullying')).toBe('attendance schedule bullying');
  });

  test('punctuation and line breaks become single spaces', () => {
    expect(normalizeForSafetyScan('Help!!!  He\n\nhit  me.')).toBe('help he hit me');
  });
});

// Every sentence below was demonstrably routed to the product backlog by an
// earlier version of this scan. They are kept as a fixed corpus because the
// failure mode here is silent: a missed disclosure looks exactly like a gym
// where nothing is wrong.
describe('disclosures that must never fall back to the product queue', () => {
  test.each([
    // A held-down key over a doubled letter.
    'he keeps bulllllying me',
    'that guy is creeeeepy',
    'he slapppped me',
    'i was bleeeeeding',
    'my knee is swolllllen',
    // Refusal phrased as a request or a question.
    'please dont make me go back',
    'can i just not go anymore',
    'i do not want to go back to the gym',
    // Unelided negation.
    'i do not feel safe in the locker room',
    // The object is a body part, not "me".
    'he grabbed my arm really hard',
    'he twisted my arm',
    'he squeezed my neck',
    'he shoved my head into the mat',
    // The person harmed is someone else.
    'he punched my little brother',
    'he hits the other kids',
    'my dad hits my mom',
    // The grooming register: isolation, secrecy, sexualized contact.
    'he touches my leg when nobody is looking',
    'he made me take my shirt off in the office',
    'he took a picture of me changing',
    'he keeps me after everyone leaves',
    'he said if i tell anyone i will be off the team',
    'im not allowed to tell my mom',
    'he texts me at night and says dont show anyone',
    'he says its our little thing',
    'i feel weird when hes around',
    // Crisis that never says "kill" or "die".
    'i wish i was dead',
    'i wish i wasnt alive',
    'im gonna do something bad to myself',
    'i want to run away',
    // Distress reported as a body or a routine.
    'i cry in the car after practice',
    'im nervous about tuesday',
  ])('reaches a person: %s', (sentence) => {
    expect(scanForSafetyLanguage(sentence).safeguarding).toBe(true);
  });
});

describe('ordinary feedback still reaches the product queue', () => {
  // The other half of the promise. A scan that routed everything to a human
  // would bury the disclosures inside product noise, which is the same failure
  // wearing a different face.
  test.each([
    'the schedule page is confusing on my phone',
    'can you add a dark mode',
    'the goals tab takes forever to load',
    'i wish the app showed next weeks classes',
    'the login button is hard to find',
    'my bag ripped, where do i buy a new one',
  ])('stays product: %s', (sentence) => {
    expect(scanForSafetyLanguage(sentence).safeguarding).toBe(false);
  });
});
