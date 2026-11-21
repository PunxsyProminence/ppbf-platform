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

// Safeguarding re-review round 3 on PR 2059 (lane HF12). Each guard that
// named what to KEEP (intent words before "off myself", "me" in a picture
// request, a list of gym objects after "made me touch") dropped real
// disclosures. The guards now name only the specific gym phrase to EXCLUDE,
// and the rest is accepted as false alerts. Invented phrases.
describe('HF1 re-review round 3: misses', () => {
  test.each([
    'ill off myself',
    'i should off myself',
    'imma off myself',
    'i might just off myself',
    'finna off myself',
    'im fourteen kms',
    'im ten kms',
    'i am thirteen kms',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  test.each([
    'he keeps asking for pics',
    'my coach keeps asking for pictures',
    'coach asked for pics',
    'he asked for a pic of me',
    'he asked me for a pic',
    'he wants photos of me',
    'he asked me to send pics',
    'he asked for selfies',
    'he made me touch the ground and then he got on top of me',
    'makes me touch my toes while he stands behind me',
    'coach made me touch my gloves to his crotch',
    'he made me touch the bag in his room',
    'he made me touch the floor of his car',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF1 re-review round 3: the specific gym phrases stay out', () => {
  test.each([
    'i took the tape off myself',
    'i pulled the wraps off myself',
    'got my gloves off myself',
    'my mum keeps asking for pics of my fight',
    'coach is asking for pictures of the event',
    'can you send pics of the tournament',
    'coach made me touch gloves before sparring',
    'we touch gloves before every round',
    'im 2 kms from the gym',
    'i am 5 kms away',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate: a stretching instruction
  // reads as being made to touch something. Excluding it also excluded
  // "makes me touch my toes while he stands behind me".
  test('accepted false alert: "he made me touch my toes in warmup" files grooming_or_isolation', () => {
    expect(scanForSafetyLanguage('he made me touch my toes in warmup').cues).toContain('grooming_or_isolation');
  });
});

// Words and scope re-review round 4 on PR 2059 (lane HF12): the age guard's
// lookahead had swallowed "im 14 kms today", and "am"/"only" had been dropped.
describe('HF1 re-review round 4', () => {
  test.each([
    'im 14 kms today',
    'only 14 kms',
    'am 14 kms',
    'im 14 kms more than ever',
    'i want to do it off myself',
    'i wanna end it, off myself',
    'im gonna do it. off myself tonight',
    'im only 14 kms today',
    'im 14 kms out here',
    'im 13 kms from now',
    'im 14 kms left alone',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): each reads like a disclosure to a word match.
  test.each([
    ['only 3 kms today', 'crisis'],
    ['i want a picture with the champ', 'grooming_or_isolation'],
    ['coach wants photos for the website', 'grooming_or_isolation'],
    ['make me touch my gloves', 'grooming_or_isolation'],
    ['take the pressure off myself', 'crisis'],
    ['i want a picture with my coach', 'grooming_or_isolation'],
  ])('accepted false alert: %p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });
});

describe('HF1 re-review round 4: picture requests said the common ways', () => {
  test.each([
    'he wanted pics',
    'he wanted a selfie',
    'he keeps wanting photos',
    'he asked me to send him pics',
    'he asked me to send him a selfie',
    'he told me to send pics',
    'he said to send him pics',
    'he says send her a selfie',
    'he asked for more pics',
    'he asked for some pics',
    'he asked for private pics',
    'he asked to see a pic of me',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each([
    'my mum wants a picture of my sparring',
    'can you send pics of the tournament',
    'i took it off myself',
    'got the tape off myself',
    'took my mouthguard off myself',
    'got my headguard off myself',
    'im 2 kms from the gym',
    'i am 5 kms away',
    'im 3 kms to go',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });
});

// Safeguarding re-review round 5 on PR 2059 (lane HF12): two common false
// alerts the round-4 widening introduced. Invented phrases.
describe('HF1 re-review round 5', () => {
  test.each([
    'can you send more photos from the tournament',
    'wanted more pictures from the event',
    'pls send pictures from class',
    'send me a pic of the scale',
    'send pictures of my class to my mum',
    'up at 6 am 5 kms before school',
    'roadwork at 5 am 10 kms',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });

  test.each([
    ['he said can you send me pics', 'grooming_or_isolation'],
    ['he asked me to send him private pics', 'grooming_or_isolation'],
    ['send me pics of you', 'grooming_or_isolation'],
    ['am 14 kms', 'crisis'],
    ['i am 14 kms', 'crisis'],
  ])('still files: %p', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });
});

// Safeguarding re-review round 6 on PR 2059 (lane HF12): "weight", "weigh
// in", day names and "show" are not specific gym phrases; excluding them hid
// requests for body pictures. Invented phrases.
describe('HF1 re-review round 6', () => {
  test.each([
    'coach keeps asking me to send pics of my weight loss progress',
    'he wants me to send pics of my weight cut with no top on',
    'he asked me to send pics of the weigh in in my underwear',
    'he asked for pics from the weigh in',
    'he asked for pics from saturday night when i stayed over',
    'he keeps asking for pics from last friday at his house',
    'he asked me for pics from the show at his place',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): these ask for gym pictures, but the words cannot tell them apart
  // from the requests above.
  test.each([
    'please send some pics from sunday',
    'send any pics from the show',
    'send him a pic of my weight each morning',
  ])('accepted false alert, files grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

// HF12b (lane HF12b): the "Known misses" PR 2059 listed. Each sentence below
// was missed on main 4f26461 (OBSERVED by a jest probe) unless the test says
// otherwise. Invented phrases.
describe('HF12b: a word spelled out letter by letter', () => {
  test.each([
    ['s u i c i d e', 'crisis'],
    ['i keep thinking about s u i c i d e', 'crisis'],
    ['k m s', 'crisis'],
    ['k.m.s', 'crisis'],
    ['k i l l  m y s e l f', 'crisis'],
    ['k.i.l.l m.y.s.e.l.f', 'crisis'],
    ['k-i-l-l m-y-s-e-l-f', 'crisis'],
    ['k i l l m y s e l f', 'crisis'],
    ['he r a p e d me', 'grooming_or_isolation'],
    ['he m o l e s t e d me', 'grooming_or_isolation'],
    ['he a b u s e d me', 'someone_is_hurting_me'],
    ['im s c a r e d of him', 'fear'],
    ['i k m s', 'crisis'],
    ['i think about s u i c i d e a lot', 'crisis'],
  ])('%p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });

  test('a spelled-out word is joined in the normal form every consumer reads', () => {
    expect(normalizeForSafetyScan('he t o u c h e d me')).toBe('he touched me');
    expect(normalizeForSafetyScan('k.i.l.l m.y.s.e.l.f')).toBe('kill myself');
    expect(normalizeForSafetyScan('i  w a n t  t o  d i e')).toBe('i want to die');
  });

  test.each([
    'up at 6 a.m. 5 kms before school',
    'i ran 5 k m s this morning',
    'grade a b c on the test',
    'the u.s.a. team won',
  ])('no crisis or grooming cue: %p', (sentence) => {
    const { cues } = scanForSafetyLanguage(sentence);
    expect(cues).not.toContain('crisis');
    expect(cues).not.toContain('grooming_or_isolation');
  });
});

// "kys" and "kill yourself" are said TO a child. Filed as crisis so they reach
// a person even in boxing context (this module errs toward a human; crisis
// is a SHADOW override cue).
describe('HF12b: being told to kill yourself', () => {
  test.each([
    'kys',
    'he keeps telling me kys',
    'they said kill yourself',
    'everyone at school says i should kill urself',
    'he told me to go kill ur self',
    'k y s',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  test.each([
    'dont kill yourself in the first round',
    'pace it, dont kill yourself in round one',
    'dont kill yourself on the bag',
  ])('coaching about pace is not crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('crisis');
  });

  test('a pace guard does not hide what follows it', () => {
    expect(scanForSafetyLanguage('he said kill yourself in the locker room').cues).toContain('crisis');
  });
});

describe('HF12b: picture requests said as pix, vid or snaps', () => {
  test.each([
    'send me pix',
    'he keeps asking for pix',
    'send me a vid',
    'he wants vids of me',
    'he asked me for a video',
    'he asked me to send snaps',
    'send him a snap',
    'send me a vid of your body',
    'he asked me for a video of how i look',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  // A boxing gym asks for technique videos all the time. Each guard names the
  // gym phrase only.
  test.each([
    'can you send me a video of the drill',
    'send me a vid of your jab',
    'please send a video on footwork',
    'send a video of how to slip',
    'send me a vid of the combo',
    'can you send a video of my pad work',
    'send me a video of a combo',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });
});

// A gym noun no longer hides what follows it: a picture near a place or state
// of undress files, in either order, whatever comes between. Two of these
// already filed on main 4f26461 ("getting changed", "underwear") and are kept
// as regression cases.
describe('HF12b: pictures near a changing room, a shower or undress', () => {
  test.each([
    'pics of the team changing room',
    'pics of my sparring partner in the shower',
    'he took pics in the locker room',
    'he asked for pics from the tournament in the changing room',
    'in the shower he took a video',
    'naked pics',
    'he wants nude photos',
    'he asked for pics of me getting changed',
    'he wanted pics of me in my underwear',
    'he took a video of me in the bathroom',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each([
    'the profile pics keep changing',
    'can you add pics of the new heavy bags',
    'the showers in the locker room are cold',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });
});

describe('HF12b: "of myself" typed for "off myself" after a word of intent', () => {
  test.each([
    'gonna of myself',
    'im going to of myself tonight',
    'i wanna of myself',
    'imma of myself',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  test.each([
    'im proud of myself',
    'i want to take care of myself',
    'im gonna think of myself first',
  ])('no crisis cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('crisis');
  });
});

describe('HF12b: an age typed with a split "i m"', () => {
  // Closed by the spelled-out-run join (two single letters read as one word),
  // so this test was green when added.
  test.each(['i m 14 kms', 'i m fourteen kms'])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): "im 14 kms in my room" is a disclosure, so a distance word after
  // the number does not shield it.
  test.each(['im 5 kms in', 'im 5 kms behind', 'im 5 kms short'])(
    'accepted false alert, files crisis: %p',
    (sentence) => {
      expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
    },
  );
});

describe('HF12b: "sa\'d" (sexually assaulted) is not read as "sad"', () => {
  test.each([
    "he sa'd me",
    'he sa’d me',
    'i got sa´d',
    'he SA-ed me',
    "they sa'ed her",
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each(['im sad', 'i feel sad today', 'sad me'])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });
});

// Review round 1 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review: text-speak single letters are not joined into a word', () => {
  test.each([
    'he hits me when we spar n i said stop',
    'my sparring partner hits me n i told him to stop',
    'my spar partner punches me k i told him to stop',
    'he grabbed my arm during pad work n i said stop',
  ])('the SHADOW sparring-intent override still reads it: %p', (sentence) => {
    expect(normalizeForSafetyScan(sentence)).toMatch(/\bi (?:said|told)\b/);
  });

  test('a split "i m" is still read as "im"', () => {
    expect(normalizeForSafetyScan('i m 14 kms')).toBe('im 14 kms');
  });
});

describe('HF12b review: a phrase spelled out with one space throughout', () => {
  test.each([
    ['h u r t m y s e l f', 'crisis'],
    ['i want to c u t m y s e l f', 'crisis'],
    ['i w a n t t o d i e', 'crisis'],
    ['he says its o u r s e c r e t', 'grooming_or_isolation'],
    ['i a m s c a r e d of him', 'fear'],
    ['k y s u loser', 'crisis'],
    ['he t o u c h e d m e', 'someone_is_frightening_me'],
  ])('%p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });

  test('the touch word is spaced back out for the SHADOW touch check', () => {
    expect(normalizeForSafetyScan('he t o u c h e d m e')).toMatch(/\btouched me\b/);
  });

  test('"s.a\'d" is read as sexually assaulted', () => {
    expect(scanForSafetyLanguage("i got s.a'd by him").cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review: the picture guard hides no request main already caught', () => {
  // Each filed grooming_or_isolation on main 4f26461 and nothing on a64d3e3.
  test.each([
    'he asked for pics showing how to kiss',
    'he wants pics about how to touch him',
    'send me pics of how to undress',
    'send me pics on the drill',
    'he wants pics of a hook up',
    'he asked me for pics of your stance',
    'he keeps asking for pics of how to kiss',
    'he asked me to send pics of how to pose on my bed',
    'he asks for pics of my jab with my shirt off',
    'he asks for pics of my stance in my sports bra',
    'he asked me to send him a pic of my hooks wearing nothing',
    'he asks me for pics of my footwork in my swimsuit',
    'he wants a pic of your stance in your bra',
    'he keeps asking for pics of my stance',
    'he asked for pics of my jab',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each([
    'he asked for a video of how to undress',
    'he wants a video of your stance with your shirt off',
    'he wants a vid of a hook up',
    'send me a video of how to pose on my bed',
    'send me a video of how to kiss',
  ])('a video request carrying undress or a non-boxing how-to files: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test.each([
    'send a video of how to slip',
    'can you send me a video of how to throw a jab',
  ])('a boxing how-to video stays out: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });
});

describe('HF12b review: the place window and product talk', () => {
  test.each([
    'i do the workout videos in my bedroom',
    'videos keep buffering in my bedroom',
    'i watch boxing videos in bed every night',
    'can the gym post pics of the new locker room',
    'the photos of the new showers look great',
    'pic of the locker room lights broken',
    'can we get photos of the toilet that is blocked',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });

  // "he wants pics of me in bed" and "he filmed me in the toilet ..." already
  // filed on main 4f26461; kept as regression cases for the person rule.
  test.each([
    'he took pics in the locker room',
    'he took a video of me in the bathroom',
    'he wants pics of me in bed',
    'he filmed me in the toilet with his phone, then sent the video',
    'in the bedroom he took photos',
    'pics he took in the locker room',
  ])('a person or request near the weaker place words still files: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): "shower" files without a person, because "pics of my sparring
  // partner in the shower" names nobody doing it.
  test('accepted false alert: "watched the video after my shower" files grooming_or_isolation', () => {
    expect(scanForSafetyLanguage('watched the video after my shower').cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review: pace guard on the heavy bag', () => {
  test('coaching about pace on the heavy bag is not crisis', () => {
    expect(scanForSafetyLanguage('dont kill yourself on the heavy bag').cues).not.toContain('crisis');
  });
});

describe('HF12b review: pictures keep the guard they had on main', () => {
  // Accepted, and pinned so a change is deliberate: the technique-noun guard
  // covers video words only, because on picture words it hid body-picture
  // requests ("pics of my jab with my shirt off").
  test('accepted false alert: "send me pics of the combo" files grooming_or_isolation', () => {
    expect(scanForSafetyLanguage('send me pics of the combo').cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review: the pace guard stays narrow', () => {
  test('"in sparring" is not a pace phrase: it is where a child may be told it', () => {
    expect(scanForSafetyLanguage('he said kill yourself in sparring').cues).toContain('crisis');
  });
});

// Review round 2 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review 2: a lone "i" after a spelled-out run stays a word', () => {
  test.each([
    'my sparring partner kept punching me after b c i said stop',
    'he hit me in sparring b c i told her to stop',
    'he kept hitting me in sparring o k i said stop',
    'he kept hitting me in sparring y e s i said stop',
  ])('the SHADOW sparring-intent override still reads it: %p', (sentence) => {
    expect(normalizeForSafetyScan(sentence)).toMatch(/\bi (?:said|told)\b/);
  });
});

describe('HF12b review 2: a staff word inside a spelled-out run is spaced back', () => {
  test.each([
    ['m y c o a c h h i t s m e', /\bcoach\b/],
    ['o u r c o a c h h u r t s m e', /\bcoach\b/],
    ['m y t r a i n e r h i t s m e', /\btrainer\b/],
  ])('%p keeps the staff word for SHADOW routing', (sentence, word) => {
    expect(normalizeForSafetyScan(sentence)).toMatch(word);
  });

  test('"scares me" inside a run is read', () => {
    expect(scanForSafetyLanguage('m y c o a c h s c a r e s m e').cues).toContain('fear');
  });
});

describe('HF12b review 2: being told to kill yourself, every spelling', () => {
  test.each([
    'k i l l y o u r s e l f',
    'coach told me kill urselfff',
    'he said kill yourselfff in sparring',
    'he said go hang yourself',
    'he told me to neck yourself',
    'they said shoot urself',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });
});

describe('HF12b review 2: video requests near a bed or without a shirt', () => {
  test.each([
    'he wants a vid of my jab in my bedroom',
    'he wants a video of my stance without a shirt',
    'he wants pics of the team without shirts',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 2: product and coaching talk about videos and snap', () => {
  test.each([
    'i want more videos',
    'we want more videos of the workouts',
    'we want more video content',
    'want more videos on defense',
    'i want videos showing the combos',
    'coach wants more snap on my jab',
    'i want more snap in my punches',
    'he wants more snap',
    'i want snap in my jab',
    'send me a snap of the schedule',
    'send me a video of the slip drill',
    'can you send me a vid of the 3 punch combo',
    'send me a video of the warm up routine',
    'send me a video of the workout',
    'send me a video of todays class',
    'i want a video of the session',
    'send me a video of how to do the drill',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });

  test.each([
    'he wants vids of me',
    'he wants me to send him a video',
    'coach keeps asking me for videos',
    'he wants a snap of me',
    'send me a video of your body doing drills',
  ])('a video request aimed at the child still files: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 2: the name Sa\'d is not read as sexually assaulted', () => {
  test.each(["Sa'ed was great today", "Sa'd did really well at pads", "coach Sa'ed is the best"])(
    'no grooming cue: %p',
    (sentence) => {
      expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
    },
  );
});

// Tests that only one guard or word list can satisfy, added for the mutation
// proof (review 2 on PR 2076). Invented phrases.
describe('HF12b review 2: single-guard tests', () => {
  test('"snap on" is boxing even without "more"', () => {
    expect(scanForSafetyLanguage('coach wants snap in my punches').cues).not.toContain('grooming_or_isolation');
  });

  test.each([
    'he wants a video of my stance in my sports bra',
    'he wants a vid of my footwork in my swimsuit',
    'he wants a video of my jab wearing nothing',
  ])('a technique video with a clothing word files: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });

  test('"sa\'d me" after a person not on the person list files', () => {
    expect(scanForSafetyLanguage("my uncle sa'd me").cues).toContain('grooming_or_isolation');
  });
});

// Review round 3 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review 3: spelled-out staff words with a trailing i or a digit', () => {
  test.each([
    ['s e n s e i hit me during sparring', /\bsensei\b/],
    ['s.e.n.s.e.i punched me at pads', /\bsensei\b/],
  ])('%p keeps the staff word', (sentence, word) => {
    expect(normalizeForSafetyScan(sentence)).toMatch(word);
  });

  // A run touching a digit is left as main left it, so SHADOW's own digit
  // fold still reads the staff word.
  test.each([
    ['c 0 a c h hit me in sparring', 'c 0 a c h hit me in sparring'],
    ['t r a 1 n e r hit me during sparring', 't r a 1 n e r hit me during sparring'],
    ['5 t a f f hit me at pads', '5 t a f f hit me at pads'],
  ])('%p is left unjoined', (sentence, normal) => {
    expect(normalizeForSafetyScan(sentence)).toBe(normal);
  });
});

describe('HF12b review 3: the video guard does not skip body words', () => {
  test.each([
    'he wants me to send him vids of my legs after workouts',
    'he asked me to send him a video of my abs during workouts',
    'he asked me for videos of my thighs during drills',
    'he asked me to send him videos of my stretching',
    'coach wants me to send him a video of my stretching routine',
    'he said send me vids of u doing ur warm up',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 3: pictures of someone changing', () => {
  test.each([
    'he took a video of me changing',
    'he took a vid of me changing after class',
    'he took photos of me while i was changing',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 3: a command is not pace advice', () => {
  test.each([
    'he told me go kill yourself in round one',
    'coach said kill yourself in the first round nobody wants you here',
    'he said kill urself in the opening round',
  ])('crisis: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('crisis');
  });

  test('pace advice after "no need to" stays out', () => {
    expect(scanForSafetyLanguage('no need to kill yourself in the first round').cues).not.toContain('crisis');
  });
});

describe('HF12b review 3: more phrases inside a spelled-out run', () => {
  test.each([
    ['i h a t e m y s e l f', 'crisis'],
    ['b e t t e r o f f d e a d', 'crisis'],
    ['i d o n t w a n t t o l i v e', 'crisis'],
    ['i w i s h i w a s d e a d', 'crisis_indirect'],
    ['h e s e x u a l l y a s s a u l t e d m e', 'grooming_or_isolation'],
    ['he said its a s e c r e t', 'secrecy'],
  ])('%p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });
});

describe('HF12b review 3: snapchat and video talk', () => {
  test.each(['he asked me to send him a snapchat', 'he wants me to send him snapchats'])(
    'grooming_or_isolation: %p',
    (sentence) => {
      expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
    },
  );

  test.each([
    'can coaches send videos in the app',
    'i want to send videos to my coach',
    'let me send videos to coach',
    'it would be cool to send videos',
    'send videos feature',
    'the app should let coaches send videos',
    'send video please',
    'coach asked me to send a video of my training',
    'coach asked me to send a video of my shadowboxing',
    'coach asked me to send a video of my punches',
    'coach asked me to send a video of my form',
    'coach asked me to send a video of my head movement',
    'coach asked me to send a video of my jump rope',
    'coach asked me to send a video of my roadwork',
    'he wants video of the pads',
    'send me a video of my defense',
    'send snaps of your hand wraps',
    'coach wants snap, speed and power',
    'he wanted snap behind it',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate: the name Sa'd before "my"
  // reads as the abbreviation, and dropping the object form would hide "he
  // sa'd me".
  test('accepted false alert: "hes Sa\'d, my sparring partner" files grooming_or_isolation', () => {
    expect(scanForSafetyLanguage("hes Sa'd, my sparring partner").cues).toContain('grooming_or_isolation');
  });
});

// Tests that only one guard can satisfy, added for the mutation proof (review
// 3 on PR 2076). Invented phrases.
describe('HF12b review 3: single-guard tests', () => {
  test('a technique video "on" footwork sent to the child stays out', () => {
    expect(scanForSafetyLanguage('send me a video on footwork').cues).not.toContain('grooming_or_isolation');
  });

  test('pace advice on the heavy bag without a negation stays out', () => {
    expect(scanForSafetyLanguage('coach said kill yourself on the heavy bag').cues).not.toContain('crisis');
  });

  test('after a negation, a non-round place still files', () => {
    expect(scanForSafetyLanguage('he said dont kill yourself in the locker room, do it at home').cues).toContain('crisis');
  });
});

// Review round 4 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review 4: video requests from a title, a persistent asker or a pressured send', () => {
  test.each([
    'mr dave wants vids',
    'sir wants vids of me',
    'trainer wants videos of me',
    'the volunteer wants videos',
    'a man at my gym keeps asking for videos',
    'someone at the gym keeps asking for videos',
    'dave keeps asking for vids of me',
    'dave from boxing keeps asking for snaps',
    'he made me send videos',
    'he gets me to send videos of myself',
    'he begged me for videos',
    'he begs me for pics',
    'he keeps begging for pics',
    'a man at my gym wants videos of me',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 4: filming verbs near a private place or undress', () => {
  test.each([
    'he was filming me in the shower',
    'he films me changing',
    'coach films us in the locker room',
    'he filmed us getting changed',
    'he recorded my sister in the shower',
    'he was recording me while i was changing',
    'he took a pic of me while changing',
    'he took a pic of me while i changed',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 4: crisis text-speak and misspellings', () => {
  test.each([
    ['i want 2 die', 'crisis'],
    ['i dont want 2 live anymore', 'crisis'],
    ['i want 2 be dead', 'crisis'],
    ['dont want 2 be alive', 'crisis_indirect'],
    ['i wish i was ded', 'crisis_indirect'],
    ['ima of myself', 'crisis'],
    ['i will of myself', 'crisis'],
    ['i was sexually assulted', 'grooming_or_isolation'],
    ['coach sexualy asaulted me', 'grooming_or_isolation'],
    ['i got r4ped', 'grooming_or_isolation'],
    ['i got raepd', 'grooming_or_isolation'],
  ])('%p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });
});

describe('HF12b review 4: technique homework, product talk and boxing words stay out', () => {
  test.each([
    'coach wants me to send a video of my homework',
    'send me a video of the homework',
    'coach asked me for a video of my combinations',
    'coach asked me for a video of my left hook',
    'coach asked me for a video of my cross',
    'coach asked me for a video of my guard',
    'coach asked me for a video of my slips',
    'coach asked me for a video of my one two',
    'coach asked me for a video of my 1 2',
    'coach asked me for a video of my conditioning',
    'coach asked me for a video of my sprints',
    'coach wants more videos',
    'they want more videos',
    'they want videos in the app',
    'they want a video library',
    'coach wants more videos on youtube',
    'my coach wants videos uploaded to the app',
    'she wants a video of the new building',
    'he wants videos of the gloves we sell',
    'they asked for a video tutorial',
    'the app asked me to send a video',
    'shadow asked me for a video',
    'video of me changing stance',
    'a pic of me changing my wraps',
    'the photo of me changing my gloves',
    'photos of me changing weight class',
    'can you post a video of me changing levels on the bag',
    'the video of him changing direction was sick',
    'coach wants snaps on every punch',
    'he wants snaps not pushes',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });
});

// Review round 5 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review 5: real messages the product and punch guards had swallowed', () => {
  test.each([
    'he dms me on the app, asks me for videos',
    'he messages me on the app. asks me for videos every night',
    'he texts me on the site asks me for videos',
    'coach is weird about it. asks me for vids all the time',
    'he asks me for snaps on snapchat',
    'he wants snaps on insta',
    'he asks for snaps behind my parents back',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 5: more askers and filming subjects', () => {
  test.each([
    'hes asking for videos',
    'shes wanting vids',
    'theyre asking for a video',
    'hes filming in the showers',
    'someone filmed in the bathroom',
    'someone was recording in the toilets',
    'my uncle asks for videos of me',
    'my stepdad wanted a video of me',
    'a boy in my class wants vids',
    'this older boy asked for a video',
    'there was a camera in the changing room',
    'he was filming the girls changing',
    'he films my sister changing',
    'pics of me whilst changing',
    'videos of me as i was changing',
    'he asked me to film myself changing',
    'he asks me for videos of my progress',
    'coach wants videos of our sessions together',
    'he wants videos of my training at his house',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 5: crisis and assault spellings', () => {
  test.each([
    ['dont want 2 be here anymore', 'crisis_indirect'],
    ['i want 2 b dead', 'crisis'],
    ['i wanna b dead', 'crisis'],
    ['i want to b dead', 'crisis'],
    ['i was sexually assalted', 'grooming_or_isolation'],
    ['he assulted me', 'someone_is_hurting_me'],
    ['he asaulted me', 'someone_is_hurting_me'],
    ['m r a p e d me', 'grooming_or_isolation'],
    ['k i l l i n g m y s e l f', 'crisis'],
    ['c u t t i n g m y s e l f', 'crisis'],
  ])('%p files %s', (sentence, cue) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain(cue);
  });

  test('a spelled-out staff title is still read after the two-pass re-spacing', () => {
    expect(normalizeForSafetyScan('m r d a v e hit me')).toMatch(/\bmr dave\b/);
  });
});

describe('HF12b review 5: product, school and gym talk stays out', () => {
  test.each([
    'the app keeps asking me for a video',
    'shadow keeps asking me for videos',
    'the app always asking for videos',
    'staff want videos for the website',
    'the staff asked for videos of the kids class for the newsletter',
    'the trainer wants videos of everyone hitting pads for instagram',
    'my teacher asked for a video for my school project',
    'the volunteer wanted a video of the open house',
    'the instructor wanted a video showing my stance',
    'coach asked for a video of my run',
    'coach wants a video of my lifts',
    'coach wants a video of my squat',
    'coach wants a video every week',
    'coach wants a video before friday',
    'recorded my pr then hit the shower',
    'broke my record then took a shower',
    'i recorded my run before my shower',
    'video of us changing partners',
    'a video of him changing pace',
    'a video of me changing corners',
    'video of me changing up my rhythm',
    'video of us changing the mats',
    'video of me while changing the timer',
    'coach does film study with us in the locker room',
    'he wants snaps not pushes',
    'coach wants snaps on every punch',
  ])('no grooming cue: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).not.toContain('grooming_or_isolation');
  });

  // Accepted, and pinned so a change is deliberate (this module errs toward a
  // human): each reads like a disclosure to a word match.
  test.each([
    'it keeps asking for a video',
    'coach asked me to send a video of my progress',
  ])('accepted false alert, files grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

// Review round 6 on PR 2076 (lane HF12b). Invented phrases.
describe('HF12b review 6: a lone text-speak letter does not swallow an obfuscated word', () => {
  test.each([
    'he followed me home n r*ped me',
    'he got me alone n r@ped me',
    'he got me alone n r ped me',
    'he w r*ped me',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 6: mixed separators inside a spelled-out staff word', () => {
  test.each([
    ['my c o.a.c.h hit me', /\bcoach\b/],
    ['my c.o.a c.h yells at me', /\bcoach\b/],
    ['my c-o-a-c h broke my nose', /\bcoach\b/],
    ['c o.a.c.h punched me in sparring', /\bcoach\b/],
  ])('%p keeps the staff word', (sentence, word) => {
    expect(normalizeForSafetyScan(sentence)).toMatch(word);
  });
});

describe('HF12b review 6: guards that swallowed a person asking for videos', () => {
  test.each([
    'some guy from the app keeps asking me for videos',
    'a man off the app asks me for vids',
    'a guy called shadow keeps asking me for videos',
    'a man at the gym wants videos of me every day',
    'the man from boxing wants videos of me every time',
    'he wants videos for the website of me in my shorts',
    'he wants me to send a video of my training at night when no one is around',
    'he asks for videos of my workouts in my room',
    'he wants a video of my squats in my room at night',
    'he wants a video of me before class',
  ])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});

describe('HF12b review 6: sa\'d with "im", "by" or a number', () => {
  test.each(["i'm sa'd by my coach", "coach sa'd 2 girls"])('grooming_or_isolation: %p', (sentence) => {
    expect(scanForSafetyLanguage(sentence).cues).toContain('grooming_or_isolation');
  });
});
