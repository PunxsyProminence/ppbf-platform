/**
 * Safety-language detection for the comment box.
 *
 * Some of the people typing into a free-text field on this platform are
 * children, which makes the field a disclosure channel whether or not it was
 * built as one. This module answers one question about one string: does it
 * contain language about fear, pain, injury, someone hurting or frightening the
 * writer, or not wanting to be somewhere. Nothing else. It does not know who
 * wrote it, it does not read the database, and it decides no routes -- see
 * decideFeedbackRoute in feedback.ts for the rule that uses this answer.
 *
 * IT ERRS TOWARD A HUMAN. A false positive costs an admin thirty seconds of
 * reading; a false negative costs a child the one time they worked up the nerve
 * to type it. So the cues are broad, single words count, and there is
 * deliberately no negation handling: "I am not scared of him anymore" is
 * exactly the sentence that should reach a person, and a clever "not"
 * suppressor would be the thing that dropped it.
 *
 * The words here are the words a twelve-year-old actually types -- no
 * apostrophes, phonetic misspellings, letters held down. Normalization does
 * that work up front so each cue can stay a plain phrase.
 */

export interface FeedbackSafetyScanResult {
  readonly safeguarding: boolean;
  /**
   * Which cues matched. Diagnostic for this module's own tests and nothing
   * else: it is never persisted, never returned by an API, and never shown to
   * the person who wrote the submission.
   */
  readonly cues: readonly string[];
}

interface SafetyCue {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Every character that stands in for an apostrophe on some keyboard, font or
 * paste: the straight and curly quotes and backtick, plus the look-alikes that
 * were splitting "don´t" into "don t" (HF1): acute accent U+00B4, modifier
 * primes and turned comma U+02B9 U+02BB U+02BC U+02BD U+02C8, prime U+2032,
 * reversed quote U+201B, full-width apostrophe U+FF07, saltillo U+A78C, and a
 * combining acute U+0301 (an accent typed on its own).
 */
const APOSTROPHE_LIKE = /[\u2018\u2019\u02bc'`\u00b4\u02b9\u02bb\u02bd\u02c8\u2032\u201b\uff07\ua78c\u0301]/g;

/**
 * Folds a typed sentence into the flat lowercase form the cues are written
 * against: apostrophes disappear entirely (so "don't" and "dont" are one
 * string), every other non-alphanumeric character becomes a space, and common
 * negated forms are expanded so "do not" and "dont" reach the same cue.
 *
 * A held-down key collapses to TWO letters, not one. Collapsing to one is what
 * a shouted word looks like -- but it also destroys every real word with a
 * doubled letter, and those are exactly the words a distressed child
 * elongates: "bulllllying" would become "bulying", "slapppped" would become
 * "slaped", "bleeeeeding" would become "bleding". None would match anything.
 */
export function normalizeForSafetyScan(body: string): string {
  return normalizeWith(body, false);
}

/**
 * "sa'd" / "sa-ed" is short for sexually assaulted. Stripping the apostrophe
 * would make it "sad", so it is spelled out first (HF12b). Only the form
 * with an apostrophe or hyphen: plain "sad" is sad.
 */
const SA_D = new RegExp(`\\bsa(?:${APOSTROPHE_LIKE.source}|-)e?d\\b`, 'g');

function normalizeWith(body: string, peelEdgeLetters: boolean): string {
  return joinSplitWords(joinSpelledOutWords(body
    .toLowerCase()
    .replace(SA_D, 'sexually assaulted')
    .replace(APOSTROPHE_LIKE, ''), peelEdgeLetters)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\bdo not\b/g, 'dont')
    .replace(/\bdoes not\b/g, 'doesnt')
    .replace(/\bdid not\b/g, 'didnt')
    .replace(/\bwill not\b/g, 'wont')
    .replace(/\b(can not|cannot)\b/g, 'cant')
    .replace(/\bis not\b/g, 'isnt')
    .replace(/\bwas not\b/g, 'wasnt')
    .replace(/\bhave not\b/g, 'havent')
    .replace(/\bwould not\b/g, 'wouldnt')
    .trim());
}

/**
 * A word spelled out letter by letter, the letters separated by one repeated
 * character ("s u i c i d e", "k.m.s", "k-i-l-l m-y-s-e-l-f"): the run is
 * joined back into the word (HF12b). Done in the normal form itself, so every
 * reader of it (the SHADOW disclosure's touch, staff and boxing-context
 * checks) sees the word too. Letters only: "5 k m s" keeps the 5 apart, so the
 * roadwork guard still reads it as a distance. Two letters are a run, so
 * "t o" reads "to" and "i m" reads "im"; "a.m." reads "am", which the kms
 * guard already treats as a time after a digit.
 *
 * A standalone "i" or "a" typed beside the run with the same single space is
 * swallowed into it ("i k m s" reads "ikms"). The second reading peels one
 * such letter off either end ("i kms", "suicide a"); it is a separate reading
 * because a real word can start or end with one ("abused", "inappropriate").
 */
const SPELLED_OUT_RUN = /(?<![a-z0-9])[a-z]([^a-z0-9])[a-z](?:\1[a-z])*(?![a-z0-9])/gu;

function joinSpelledOutWords(text: string, peelEdgeLetters: boolean): string {
  return text.replace(SPELLED_OUT_RUN, (run) => {
    let word = run.replace(/[^a-z]/g, '');
    if (!peelEdgeLetters) return word;
    let head = '';
    let tail = '';
    if (/^[ia]/.test(word) && word.length >= 4) {
      head = `${word[0]} `;
      word = word.slice(1);
    }
    if (/[ia]$/.test(word) && word.length >= 4) {
      tail = ` ${word[word.length - 1]}`;
      word = word.slice(0, -1);
    }
    return head + word + tail;
  });
}

/**
 * A word split in two by a phone keyboard or a habit: "kill my self", "un
 * alive". Joined so the cues match either spelling. Run on both elongation
 * readings, because a held key inside the split ("myyy self", "my selfff")
 * only collapses to the joinable form in the fully collapsed one.
 */
function joinSplitWords(text: string): string {
  return text
    .replace(/\bmy self\b/g, 'myself')
    .replace(/\bun alive\b/g, 'unalive')
    .replace(/\b(your|ur) self\b/g, '$1self');
}

/**
 * Collapsing elongation to two letters keeps doubled-letter words intact, but
 * a single-letter word typed long ("sooooo" -> "soo") no longer matches its
 * own spelling. Both readings are scanned and their cues combined, so neither
 * elongation shape can hide a disclosure.
 */
function collapseFully(normalized: string): string {
  return joinSplitWords(normalized.replace(/(.)\1+/g, '$1'));
}


// Every cue is matched against the normalized string, so each phrase is
// written apostrophe-free.
const SAFETY_CUES: readonly SafetyCue[] = [
  {
    id: 'fear',
    pattern:
      /\b(scared|scarred|scaird|scary|scares|scare|afraid|afriad|terrified|terrifies|frightened|frightens|frighten|freaked out|freaks me out|freaking out|creeped out|creepy|nervous to come|panic|panicking)\b/,
  },
  {
    id: 'pain_or_injury',
    pattern:
      /\b(hurt|hurts|hurting|hurted|pain|painful|sore|injured|injury|injuries|bruise|bruised|bruises|bleeding|blood|concussion|dizzy|swollen|sprained|cant breathe|hard to breathe|passed out|blacked out|throwing up|threw up)\b/,
  },
  {
    id: 'broken_bone',
    pattern:
      /\b(broke my|broken (rib|ribs|nose|arm|hand|wrist|finger|thumb|leg|foot|ankle|jaw|tooth|teeth)|cracked my)\b/,
  },
  {
    id: 'someone_is_hurting_me',
    pattern:
      /\b(hurt me|hurts me|hurting me|hit me|hits me|hitting me|punched me|punches me|punching me|kicked me|kicks me|kicking me|grabbed me|grabs me|grabbing me|pushed me|pushes me|pushing me|shoved me|shoves me|shoving me|slapped me|slaps me|slapping me|tripped me|trips me|tripping me|choked|choking me|threw me|throwing me|dragged me|drags me|dragging me|held me down|pinned me down|hits us|hurts us|abused me|abuses me|abusing me|was abused|got abused|been abused|being abused|is abusive|was abusive|assaulted me|assaults me|assaulting me)\b/,
  },
  {
    id: 'someone_is_frightening_me',
    pattern:
      /\b(yells at me|yelled at me|yelling at me|screams at me|screamed at me|screaming at me|calls me names|called me names|makes fun of me|make fun of me|making fun of me|laughs at me|laughed at me|picks on me|picked on me|picking on me|teases me|teasing me|bully|bullies|bullied|bullying|mean to me|threatened|threatens me|threatening me|wont leave me alone|wont stop|keeps bothering me|makes me cry|made me cry|touched me|touching me|touches me|inappropriate|uncomfortable)\b/,
  },
  {
    id: 'does_not_want_to_be_there',
    pattern:
      /\b(dont want to come|dont wanna come|dont want to go|dont wanna go|dont want to be here|dont want to be there|dont want to come back|never want to come back|dont want to spar|dont want to practice|dont want to be alone|scared to come|afraid to come|want to quit|wanna quit|going to quit|gonna quit|stop coming|not coming back|hide in the bathroom|hiding in the bathroom|pretend im sick)\b/,
  },
  {
    id: 'does_not_feel_safe',
    pattern: /\b(unsafe|not safe|dont feel safe|feel unsafe|didnt feel safe|nobody helped|no one helped|nobody listens|no one listens|nobody believes me|no one believes me)\b/,
  },
  {
    // HF1 (PR 2059) added the suicide and self-harm words a child actually
    // types, short forms included ("kms", "sewerslide", "unalive"). Crisis
    // files even in boxing context, so four guards keep gym talk out. Each
    // names only the gym phrase to EXCLUDE; four review rounds showed that a
    // guard listing what to KEEP drops real disclosures.
    //  - kms: not after a number or counting phrase (kilometres of roadwork).
    //    Numbers are spelled to survive the fully collapsed reading ("thre",
    //    "fiften"). Not "of", "the" or "some" ("thinking of kms"), not "any
    //    word ending in ten" ("so often kms"). An age before it ("im 14 kms",
    //    "im fourteen kms") files unless a distance phrase follows ("kms
    //    away", "kms to go", "kms from the gym"); "im 14 kms today" files.
    //    "am" after a digit is a time ("6 am 5 kms"), not "i am".
    //  - suicide: not "suicides" or a "suicide drill/sprint/shuttle" (the
    //    conditioning sprint; "dril+" and "shut+les" for the collapsed
    //    reading) or "suicide squad". Not "runs" or "lines" ("suicide runs in
    //    my family").
    //  - off myself: not after gear ("tape off myself") or after take, took,
    //    get, got, pull, pulled or cut followed by it or them ("took it off
    //    myself"); a bare "it" is not excluded ("end it, off myself").
    //  - "of myself" is "off myself" only straight after a word of intent
    //    ("gonna of myself"); "proud of myself" is ordinary (HF12b).
    //  - kys and kill yourself (HF12b): said TO a child, filed as crisis so
    //    they file in boxing context. Not coaching about pace: "in the
    //    first round", "in round one", "on the bag/pads/mitts/treadmill".
    // Pinned, accepted false alerts: "suicide runs after sparring", "only"
    // before digits or ten..nineteen and kms ("only 3 kms today"), "take the
    // pressure off myself", "i ran kms before school", "dont wanna live in
    // this town". Plain "take my life" is not a cue ("take
    // my life seriously"); "take my own life" is.
    id: 'crisis',
    pattern:
      /\b(kill myself|killing myself|hurt myself|hurting myself|cut myself|cutting myself|want to die|wanna die|end it all|nobody cares|no one cares|hate myself|suicidal|suicidel|sucidal|suicidial|suisidal|suicide(?! (?:dril+s?|sprints?|shut+les?|squad)\b)|suiside|sucide|suacide|suicde|commit sudoku|sewerslide|sewer slide|unalive|unalived|unaliving|kil myself|kill myslef|killmyself|(?<!\b(?:wraps?|tape|gloves?|shoes?|boots|shirt|headgear|headguard|mouthguard|pads|(?:take|took|get|got|pull|pulled|cut) (?:it|them)) )off myself|shoot myself|neck myself|end my life|end my own life|ending my life|take my own life|taking my own life|dont want to live|dont wanna live|want to be dead|wanna be dead|better off dead|slit my wrists?|hang myself|hanging myself|overdose|overdosed|overdoses|overdosing|self ?harm|self ?harms|self ?harmed|self ?harming|harm myself|harming myself|(?:gonna|gunna|going to|wanna|want to|imma|finna|about to|bout to) of myself|kys|kill (?:yourself|urself)(?! (?:in (?:the )?(?:first |1st |opening |early )?rounds?|in round (?:one|1)|on the (?:bag|pads|mitts|treadmill))\b))\b|(?<!\b(?:[0-9]+|a few|few|a couple|couple|many|how many|hundreds? of|thousands? of|hundred|two|thre+|four|five|six|seven|eight|nine|eleven|twelve|ten|thirte+n|fourte+n|fifte+n|sixte+n|sevente+n|eighte+n|ninete+n|twenty|thirty|forty|fifty) )\bkms\b|\b(?:im|i am|(?<![0-9] )am|only|age)(?: only)? (?:[0-9]+|ten|eleven|twelve|thirte+n|fourte+n|fifte+n|sixte+n|sevente+n|eighte+n|ninete+n)(?: yo| years old| and)? kms\b(?! (?:away|to go|from (?:the|my|home|here|school))\b)/,
  },
  {
    // Naming what was touched instead of who was touching. Every cue above
    // ends in "me", so a sentence whose object is a body part slips past.
    id: 'contact_with_body_part',
    pattern:
      /\b(grabbed|grabs|grabbing|twisted|twists|twisting|squeezed|squeezes|squeezing|touched|touches|touching|yanked|yanks|pulled|pulls|shoved|shoves|snapped|snaps|hit|hits|kicked|kicks|punched|punches|slapped|slaps|pinched|pinches|bent|bends) (my|his|her|their|the) (arm|arms|wrist|wrists|hand|hands|finger|fingers|neck|throat|head|hair|face|chest|leg|legs|knee|knees|ankle|back|shoulder|shoulders|stomach|ribs|nose|jaw|ear|ears|body|butt|bottom|privates|private parts)\b/,
  },
  {
    // A child reporting harm to someone else is still a disclosure.
    id: 'harm_to_someone_else',
    pattern:
      /\b(hits|hit|hurts|hurt|punches|punched|kicks|kicked|slaps|slapped|screams at|yells at|is mean to|was mean to|picks on|touches|touched) (the other|other|another|my|his|her|their) (little |big |baby |younger |older |best |twin )?(kid|kids|child|children|brother|sister|friend|friends|mom|mum|dad|teammate|teammates|athlete|athletes|girl|girls|boy|boys|cousin|us|them)\b|\b(hits us|hurts us|is mean to us|yells at us|screams at us)\b/,
  },
  {
    // The grooming register: isolation, secrecy dressed as closeness,
    // sexualized contact, and threats tied to belonging. Sexual abuse named as
    // such (HF1) sits here too, so it routes as touching does: critical,
    // admins only, and filed even in boxing context (Overwatch on PR 2059,
    // Q1 = A). Guards here name only the specific gym phrase to leave out
    // ("touch gloves", pictures "of my fight" or "from the tournament", "of
    // the scale"); a guard that listed what to keep dropped real disclosures
    // (safeguarding reviews, PR 2059). "weight", "weigh in", day names and
    // "show" are deliberately not excluded: they carry requests for body
    // pictures ("pics of my weight cut with no top on"). HF12b: "pix",
    // "vid(s)", "video(s)" and "snap(s)" are pictures too; a technique video
    // ("of the drill", "of your jab", "on footwork", "of how to slip") is
    // the gym phrase left out. A picture within six words of a changing room,
    // shower, bathroom, bed or undress files in either order, so a gym noun
    // after "of" ("pics of the team changing room") no longer hides it.
    id: 'grooming_or_isolation',
    pattern:
      /\b(when nobody is looking|when no one is looking|when nobodys looking|when everyone leaves|after everyone leaves|keeps me after|keep me after|stay behind|stays behind|by myself with|alone in the office|in the office alone|took a picture of me|takes pictures of me|filmed me|recorded me|watches me get changed|watches me change|watched me change|take my shirt off|took my shirt off|get changed in front|our little secret|our little thing|our secret|special friend|dont show anyone|dont show anybody|not allowed to tell|cant tell my mom|cant tell my dad|cant tell anyone|off the team if i tell|if i tell anyone|texts me at night|texting me at night|messages me at night|asked me not to say|molest|molests|molested|molesting|molester|molestation|rape|rapes|raped|raping|rapist|r ped|rap3d|sexual(?:ly)? (?:abus|assault)[a-z]*|sexualy (?:abus|assault)[a-z]*|sexually touched|grooming me|groomed me|grooms me|groped|gropes|groping|fondled|fondles|fondling|(?:made|makes|make|making) me touch(?! gloves\b)|sent me nudes|asked for nudes|asked me for nudes|wants nudes|send nudes|dick pic|dick pics|(?:(?:asking|asks|asked|ask|wants|want|wanted|wanting) (?:me )?(?:for |to see |to send (?:him |her |them )?)?|send (?:him |her |them |me )?)(?:a |an |more |some |private |another |any )?(?:pic|pics|pix|picture|pictures|photo|photos|selfie|selfies|vid|vids|video|videos|snap|snaps)\b(?! (?:(?:of|from|on) (?:(?:my|the|our|his|her|their|your|a) )?(?:fight|fights|bout|bouts|event|events|match|tournament|win|belt|medal|team|clas+|spar+ing|scale|dril+s?|combos?|jabs?|ho+ks?|up+ercuts?|fo+twork|stance|pad ?work|mit+ ?work|bag ?work|technique)|(?:of|on|about|showing) how to)\b)|pedo|pedophile|paedo|paedophile|had sex with me|have sex with me|(?:pic|pics|pix|picture|pictures|photo|photos|selfie|selfies|vid|vids|video|videos|snap|snaps)(?: [a-z0-9]+){0,6} (?:showers?|showering|changing rooms?|change rooms?|locker rooms?|get+ing changed|get changed|got changed|undres+ed|undres+ing|naked|nude|underwear|bathrooms?|toilets?|no shirt|no top|shirtles+|toples+|in bed|bedro+m)|(?:showers?|showering|changing rooms?|change rooms?|locker rooms?|get+ing changed|get changed|got changed|undres+ed|undres+ing|naked|nude|underwear|bathrooms?|toilets?|no shirt|no top|shirtles+|toples+|in bed|bedro+m)(?: [a-z0-9]+){0,6} (?:pic|pics|pix|picture|pictures|photo|photos|selfie|selfies|vid|vids|video|videos|snap|snaps))\b/,
  },
  {
    // Refusal phrased as a request or a question, which the "dont want to"
    // cues miss entirely.
    id: 'refusal_to_return',
    pattern:
      /\b(dont make me go|dont make me come|please dont make me|can i just not go|can i not go|do i have to go|i want to stop going|i want to stop coming|makes me not want to come|makes me not want to go|not go anymore|not going anymore|stop going|quit going)\b/,
  },
  {
    // Crisis phrasing that never says "kill" or "die".
    id: 'crisis_indirect',
    pattern:
      /\b(wish i was dead|wish i were dead|wish i wasnt alive|wish i wasnt here|dont want to be alive|dont want to be here anymore|do something bad to myself|hurt myself|run away|running away|ran away|disappear forever|better off without me|nobody would miss me|no one would miss me)\b/,
  },
  {
    // Distress reported as a body or a routine rather than a feeling.
    id: 'distress_signals',
    pattern:
      /\b(cry in the car|crying in the car|cry after practice|cry myself to sleep|cant sleep before|cant eat before|throw up before|sick before practice|stomach hurts before|nervous about|dread|dreading|shaking|shaky|hands shake|feel weird when|feels weird when|weird around|uncomfortable around)\b/,
  },
  {
    id: 'secrecy',
    pattern: /\b(dont tell|told me not to tell|not to tell anyone|keep it a secret|its a secret|alone with me|alone with him|alone with her)\b/,
  },
];

export function scanForSafetyLanguage(body: string): FeedbackSafetyScanResult {
  // Both elongation readings are scanned and their cues combined. Collapsing to
  // two keeps doubled-letter words ("bullying", "bleeding") intact; collapsing
  // fully catches a single-letter word typed long ("sooooo"). Neither reading
  // alone covers both, and a disclosure must not depend on which way a child
  // happened to hold the key.
  // A third and fourth reading peel a lone "i" or "a" off a spelled-out run
  // (joinSpelledOutWords); they differ from the first two only when there is
  // such a run.
  const normalized = normalizeForSafetyScan(body);
  const peeled = normalizeWith(body, true);
  const readings = [normalized, collapseFully(normalized), peeled, collapseFully(peeled)];
  const cues = SAFETY_CUES
    .filter((cue) => readings.some((reading) => cue.pattern.test(reading)))
    .map((cue) => cue.id);

  return { safeguarding: cues.length > 0, cues };
}
