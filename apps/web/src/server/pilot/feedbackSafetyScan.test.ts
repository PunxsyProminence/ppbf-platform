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

// HF1 (lane HF12). Every sentence below was missed by the scan on main
// 4f77642 (OBSERVED by a jest probe): no cue, so no disclosure alert. The
// phrases are invented for these tests. Each new phrase sits in an existing cue
// id, so routing and severity follow rulings already in force (Overwatch on
// PR 2059: Q1 = A, the sexual-abuse words go into grooming_or_isolation).
describe('HF1: crisis phrasings reach a person as crisis', () => {
  test.each([
    'im suicidal',
    'i feel suicidal again',
    'i keep thinking about suicide',
    'sometimes i think about sucide',
    'i thought about suiside last night',
    'thinking about sewerslide',
    'i want to unalive myself',
    'i might un alive myself',
    'kms',
    'honestly kms',
    'i want to end my life',
    'i want to end my own life',
    'i thought about ending my life',
    'i want to take my own life',
    'i want to kill my self',
    'i want to kil myself',
    'i want to kill myslef',
    'i dont want to live anymore',
    'i dont wanna live',
    'i do not want to live',
    'i want to be dead',
    'i wanna be dead',
    'everyone would be better off if i was dead, im better off dead',
    'i want to slit my wrists',
    'i want to hang myself',
    'i thought about overdose',
    'i self harm',
    'i started selfharm',
    'i have been self harming',
    'i want to harm myself',
    'i keep harming myself',
    'i want to hurt my self',
    'i cut my self last night',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});

describe('HF1: sexual-abuse words reach a person as grooming_or_isolation', () => {
  test.each([
    'my uncle molested me',
    'someone molests me',
    'he was molesting me',
    'he is a molester',
    'i got raped',
    'he raped me',
    'he tried to rape me',
    'i was sexually abused',
    'it was sexual abuse',
    'i was sexually assaulted',
    'it was a sexual assault',
    'he sexually touched me',
    'he groped me',
    'he gropes me',
    'he fondled me',
    'he made me touch him',
    'he makes me touch his',
    'he sent me nudes',
    'he asked me for nudes',
    'he asked for nudes',
    'he wants nudes',
    'he said send nudes',
    'he is a pedo',
    'he had sex with me',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF1: abuse said as abuse reaches a person', () => {
  test.each([
    'he abused me',
    'my stepdad abuses me',
    'she keeps abusing me',
    'i was abused',
    'i got abused at home',
    'i have been abused',
    'i am being abused',
  ])('someone_is_hurting_me: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('someone_is_hurting_me');
  });
});

describe('HF1: a look-alike apostrophe does not hide a disclosure', () => {
  // ´ U+00B4, ʹ U+02B9, ʻ U+02BB, ʽ U+02BD, ˈ U+02C8, ′ U+2032, ‛ U+201B,
  // ＇ U+FF07, ꞌ U+A78C, and a combining acute U+0301 after a space-free n.
  test.each([
    'i don´t feel safe',
    'i donʹt feel safe',
    'i donʻt feel safe',
    'i donʽt feel safe',
    'i donˈt feel safe',
    'i don′t feel safe',
    'i don‛t feel safe',
    'i don＇t feel safe',
    'i donꞌt feel safe',
    'i dońt feel safe',
  ])('does_not_feel_safe: %p', (sentence) => {
    expect(normalizeForSafetyScan(sentence)).toBe('i dont feel safe');
    expect(scanForSafetyLanguage(sentence).cues).toContain('does_not_feel_safe');
  });

  test('split words are joined', () => {
    expect(normalizeForSafetyScan('kill my self')).toBe('kill myself');
    expect(normalizeForSafetyScan('un alive')).toBe('unalive');
  });
});

describe('HF1: gym and boxing talk stays out of the new cues', () => {
  // The new crisis phrases override boxing context in SHADOW, so the patterns
  // themselves have to stay out of ordinary training talk.
  test.each([
    'i ran 5 kms this morning',
    'we did 3 kms of roadwork',
    'a few kms before practice',
    'a couple kms on the treadmill',
    'how many kms should i run',
    'we did suicides at the end',
    'suicide drills today were rough',
    'coach had us do suicide sprints',
    'kill it in sparring tonight',
    'i killed it at pad work',
    'that combo is killer',
    'this drill is killing me',
    'my legs are dead after roadwork',
    'im dead tired',
    'end the round strong',
    'i want to take my life seriously in boxing',
    'i want to take my life back after the loss',
    'grape juice after training',
    'can you show me grappling defense',
    'the therapist said rest',
    'the drapes in the lobby are new',
  ])('no new cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });
});

// Safeguarding review on PR 2059 (lane HF12), round 1. Each sentence was
// missed by the first HF1 build (OBSERVED by the reviewer's probe, re-run
// here). Invented phrases.
describe('HF1 review: the guards no longer swallow a disclosure', () => {
  test.each([
    'im thinking of kms',
    'thoughts of kms again',
    'the kms thoughts are back',
    'more kms thoughts',
    'some days kms',
    'suicide runs in my family and i think about it',
    'thinking about suicide lines up with my mood',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});

describe('HF1 review: held keys inside a split word', () => {
  test.each([
    'i want to kill myyy self',
    'i want to kill my selfff',
    'i want to un aliveee myself',
    'i want to unnn alive myself',
    'i wanna hurt my selff',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});

describe('HF1 review: past and -ing forms, and more short forms', () => {
  test.each([
    'i self harmed last night',
    'i selfharmed again',
    'i overdosed on pills',
    'thinking about overdosing',
    'i want to unalive',
    'i wanna unalive tbh',
    'thinking about unaliving',
    'gonna slit my wrist',
    'i want to off myself',
    'i want to shoot myself',
    'i want to neck myself',
    'i wanna killmyself',
    'im suicidial',
    'im suisidal',
    'thinking about suicde',
    'i want to commit sudoku',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});

describe('HF1 review: sexual abuse said other ways is grooming_or_isolation', () => {
  test.each([
    'my uncle is sexually abusing me',
    'he is sexually assaulting me',
    'i was sexualy abused',
    'i think he is grooming me',
    'he groomed me',
    'he sent me a dick pic',
    'he keeps asking for pictures of me',
    'he asks me for pics',
    'there was molestation',
    'he is a paedo',
    'he r*ped me',
    'he r@ped me',
    'he rap3d me',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF1 review: abuse and assault named as such', () => {
  test.each([
    'he is abusive',
    'my dad is abusive',
    'she was abusive to me',
    'he assaulted me',
  ])('someone_is_hurting_me: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('someone_is_hurting_me');
  });
});

describe('HF1 review: gym talk the narrowed guards still keep out', () => {
  test.each([
    'i did twenty kms of roadwork',
    'we ran fifteen kms',
    'hundreds of kms this year',
    'we did suicide shuttles today',
    'suicide sprints again',
    'my pedometer says 10k',
    'rapeseed oil in my meal prep',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });
});

describe('HF1 review round 2: the scope review\'s false alerts', () => {
  test.each([
    'three kms of roadwork',
    'we ran eighteen kms',
    'suicide squad is a good movie',
  ])('no crisis cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('crisis');
  });

  test.each([
    'coach made me touch gloves before sparring',
    'make me touch gloves before the round',
    'he made me touch my toes in warmup',
  ])('touching gloves or toes is not grooming: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });

  test.each([
    'he made me touch him',
    'he makes me touch it',
    'he made me touch her',
    'he makes me touch them',
    'he made me touch there',
    'he made me touch myself',
  ])('being made to touch a person still is: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate: "suicide runs" is a
  // conditioning drill, but the guard no longer covers "runs" because "suicide
  // runs in my family" is a disclosure. A false alert costs a reading; a miss
  // costs the child (this module's header).
  test('accepted false alert: "suicide runs after sparring" files crisis', () => {
    expect(scanForSafetyLanguage('suicide runs after sparring').cues).toContain('crisis');
  });
});

// Safeguarding re-review on PR 2059 (lane HF12), round 2. The first round of
// false-alarm fixes over-narrowed: each sentence below was missed at f3bef05
// (OBSERVED by the reviewer's probe). A missed child costs more than a false
// alert, so the guards went back to the narrowest form that keeps the gym's
// commonest phrasings out. Invented phrases.
describe('HF1 re-review: what the narrowed guards had swallowed', () => {
  test.each([
    'i dont want to live in this world anymore',
    'i dont want to live on this earth',
    'i dont want to live at all',
    'i dont want to live on like this',
    'i dont wanna live in this body',
    'after sparring i dont want to live at all',
    'this happens so often kms',
    'got beaten kms',
    'i feel so rotten kms',
    'im a teen kms',
    'listen kms',
    'im 14 kms',
    'im only 13 kms',
    'i am 15 kms',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  test.each([
    'he made me touch down there',
    'my coach makes me touch down there after sparring',
    'he made me touch my privates',
    'he made me touch something',
    'he made me touch stuff i didnt want to',
    'made me touch u know what',
    'he made me touch',
    'he made me touch inappropriate places',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each([
    'i took the wraps off myself',
    'got the tape off myself',
    'my mum keeps asking for pics of my fight',
    'coach is asking for pictures of the event',
    'thirteen kms of roadwork',
    'we did ten kms',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): without a number, roadwork verbs no longer shield "kms", and a
  // place after "dont want to live" no longer shields it either.
  test.each([
    'i ran kms before school',
    'i dont wanna live in this town',
  ])('accepted false alert, files crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});
