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
 * Invisible characters that change no word a reader sees: every Unicode format character
 * (category Cf -- zero-width space U+200B, zero-width non-joiner and joiner U+200C/D, word
 * joiner U+2060, soft hyphen U+00AD, byte-order mark U+FEFF, direction marks and isolates, tag
 * characters) and every default-ignorable code point (which adds the variation selectors, the
 * combining grapheme joiner U+034F, and the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0 --
 * U+3164 is the "invisible name" character children use in games; PR #2151 reviewer A) -- and
 * U+2800, the Braille blank, which draws as an empty cell and is used the same way, and the
 * near-invisible thin, hair and narrow no-break spaces U+2009, U+200A and U+202F (PR #2152 and
 * #2154 reviewers: none is a format character, and no pattern's whitespace class matched them).
 */
export const INVISIBLE_FORMAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u2009\u200A\u202F]/gu;

/** One run of invisible characters, kept by the split so a run can be put back as typed. */
const INVISIBLE_RUN_KEPT = new RegExp(`(${INVISIBLE_FORMAT.source}+)`, 'u');

/**
 * A run can join or split a word only between two letters or apostrophes (every look-alike the
 * normal form folds). A run that touches a digit, a space, punctuation or an emoji does not count:
 * "5:00[U+202F]PM", "1[U+202F]000", a heart's variation selector (PR #2154 reviewers: each of
 * these used up the combinations and switched them off).
 */
const WORD_CHARACTER = new RegExp(`\\p{L}|${APOSTROPHE_LIKE.source}`, 'u');

/**
 * The most counted runs read in every combination: 6 give 64 readings. A run that does not count
 * is read as typed in every combination (and removed in the all-removed form).
 */
export const MAX_COMBINED_INVISIBLE_RUNS = 6;

/**
 * The combinations times the message length stay under this many characters, so a long message
 * gets fewer combined runs: 5 up to 2,000 characters, 2 at 12,000 (the SHADOW chat limit). PR #2154
 * reviewers measured about 0.2 s per call near a 128,000 budget (and 0.6 s with no budget); this
 * halves it. Over the cap a message is read as typed, with every run removed, and with every
 * counted run a space.
 */
const COMBINATION_BUDGET = 64_000;

/**
 * The text as the scanners should read it, once or twice (Codex P1 on #2138; Claude Science F4;
 * the reopened PAIN-NOTES lane, 2026-11-24).
 *
 * The normal form turns every character that is not a letter or digit into a space, so one
 * invisible character inside a word split it: "co[U+200B]ach" read as "co ach", and a note
 * naming a coach was not held for admins (OD-2026-11-23-003, "A: Keep strict"); "se[U+200B]cret"
 * and "hu[U+200D]rts" lost their cues altogether, in every channel. Stripping alone would break
 * the opposite case -- "my[U+200B]coach" relies on the character reading as a space -- so both
 * forms are read: the text as typed (each invisible character a space, as before) and the text
 * with them removed. A cue or a staff word found in either counts; the second form only ever adds
 * a match. Nothing is rewritten in what is stored: this is the scan's reading, not the record.
 */
export function scanForms(body: string): readonly string[] {
  // Each run of invisible characters may sit inside a word ("bre[U+200B]athe": remove it) or in
  // place of a space ("can't[U+200B]breathe": read it as one), and one message can hold both:
  // "can't[U+200B]bre[U+200B]athe" read only all-removed or all-space hid the emergency (PR #2152
  // reviewer). So each run is read both ways, in every combination up to the cap. The first form
  // is the text as typed and the second the text with every run removed, as before; the rest
  // only ever add a reading.
  // split with a capture group: text, run, text, run, ... text.
  const parts = body.split(new RegExp(INVISIBLE_RUN_KEPT.source, 'gu'));
  if (parts.length === 1) return [body];
  const segments = parts.filter((_, index) => index % 2 === 0);
  const runText = parts.filter((_, index) => index % 2 === 1);
  // The runs that sit between two letters or apostrophes, by run index; only these may be read as spaces.
  const wordRuns = runText.flatMap((_, run) => {
    const before = [...segments[run]].pop() ?? '';
    const after = [...segments[run + 1]][0] ?? '';
    return WORD_CHARACTER.test(before) && WORD_CHARACTER.test(after) ? [run] : [];
  });
  const counted = new Set(wordRuns);
  // A counted run is removed or a space; a run that does not count stays as typed.
  const joined = (spaced: ReadonlySet<number>) => segments.reduce((text, segment, index) => {
    if (index === 0) return segment;
    const run = index - 1;
    const between = counted.has(run) ? (spaced.has(run) ? ' ' : '') : runText[run];
    return text + between + segment;
  }, '');
  let cap = MAX_COMBINED_INVISIBLE_RUNS;
  while (cap > 0 && 2 ** cap * Math.max(body.length, 1) > COMBINATION_BUDGET) cap -= 1;
  const forms = new Set<string>([segments.join('')]);
  if (wordRuns.length <= cap) {
    for (let mask = 0; mask < 2 ** wordRuns.length; mask += 1) {
      forms.add(joined(new Set(wordRuns.filter((_, bit) => ((mask >> bit) & 1) === 1))));
    }
  } else {
    forms.add(joined(counted));
  }
  forms.delete(body);
  return [body, ...forms];
}

/**
 * The same normal form with HF12b's rewrites (spelled-out words joined, the
 * sexual-assault abbreviation spelled out, "ur self"): an extra reading,
 * never a replacement. The cues read both, and the SHADOW
 * disclosure's staff, person, touch and intent checks read both, so a
 * spelled-out word only ever adds evidence to what main's normal form already
 * gave (safeguarding review round 7 on PR 2076).
 */
export function spelledOutReading(body: string): string {
  return normalizeWith(body, true);
}

function normalizeWith(body: string, extraReading: boolean): string {
  const lowered = (extraReading ? spellOutSexualAssault(body) : body).toLowerCase().replace(APOSTROPHE_LIKE, '');
  return joinSplitWords((extraReading ? joinSpelledOutWords(lowered) : lowered)
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
    .trim(), extraReading);
}

/**
 * "sa'd" / "sa-ed" (also "s.a'd") is short for sexually assaulted. Stripping
 * the apostrophe would make it "sad", so it is spelled out first (HF12b).
 * Plain "sad" is sad, and the given name Sa'd / Sa'ed is left as a name.
 */
const SA_D = new RegExp(String.raw`(?<![A-Za-z0-9])[sS]\.?[aA]\.?(?:${APOSTROPHE_LIKE.source}|-)[eE]?[dD](?![A-Za-z0-9])`, 'g');

function spellOutSexualAssault(body: string): string {
  return body.replace(SA_D, (match: string, offset: number) => {
    const before = body.slice(0, offset);
    const after = body.slice(offset + match.length);
    const isGivenName = /^Sa/.test(match)
      && !/^\s+(?:me|him|her|us|them|my)\b/i.test(after)
      && !/\b(?:got|get|gets|getting|was|were|been|being|be|is|am|im|i['\u2019]?m|he|she|they|someone|somebody|who)[^A-Za-z0-9]+$/i.test(before)
      && (/\b(?:called|named|friend|with|and|to|from|for|hes|shes|meet|met|sparring|partner)[^A-Za-z0-9]+$/i.test(before)
        || /^(?:,|['\u2019]s\b|\s+(?:is|was|did|does|has|had|and|will|can|said|says|won|wins|went)\b)/i.test(after));
    return isGivenName ? match : 'sexually assaulted';
  });
}

/**
 * A word spelled out letter by letter ("s u i c i d e", "k.m.s"): the run is
 * joined back into the word, in the spelled-out reading only (HF12b).
 */
const SPELLED_OUT_RUN = /(?<![a-z0-9])[a-z](?:[^a-z0-9][a-z])+(?![a-z0-9])/gu;

/**
 * A run typed with one space between every letter swallows the gaps between
 * words too ("h u r t m y s e l f" joins to one block), and a lone "i" or "a"
 * beside it ("i k m s"). These phrases are spaced back out inside a joined
 * run, longest first, so the cues and the SHADOW touch and staff checks read
 * them. Each is a phrase some cue already holds, or a staff word; a run is
 * rare in ordinary text, so a phrase found inside an unrelated spelled-out
 * word costs at most a reading.
 */
const SPACED_BACK_PHRASES: readonly string[] = [
  'kill myself', 'hurt myself', 'cut myself', 'harm myself', 'hang myself', 'shoot myself', 'off myself',
  'want to die', 'wanna die', 'end my life', 'end it all', 'self harm', 'suicidal', 'suicide', 'unalive',
  'kms', 'kys', 'our little secret', 'our secret', 'dont tell', 'raped', 'rapist', 'molested', 'molest',
  'nudes', 'groped', 'touched me', 'touches me', 'touching me', 'touched', 'touches', 'touching',
  'hitting me', 'hits me', 'hit me', 'hurts me', 'hurt me', 'abused me', 'abused', 'scared', 'afraid',
  'terrified', 'not safe', 'unsafe', 'kill yourself', 'kill urself', 'hang yourself', 'scares me', 'scared me',
  'killing myself', 'cutting myself', 'hurting myself', 'harming myself',
  'hate myself', 'better off dead', 'dont want to live', 'nobody cares', 'no one cares', 'want to be dead',
  'slit my wrists', 'slit my wrist', 'wish i was dead', 'sexually assaulted', 'its a secret', 'a secret',
  'on purpose',
];

// Staff words, so SHADOW's staff check still sees who is named (review 2 on
// PR 2076): a false match here only narrows an alert to admins. Spaced back
// after the phrases, so a short title never splits a cue word.
const SPACED_BACK_STAFF = /coaches|coach|trainer|instructor|staff|volunteer|sensei|mister|mrs|mr|sir/g;

const SPACED_BACK = new RegExp(
  [...SPACED_BACK_PHRASES]
    .sort((x, y) => y.replace(/ /g, '').length - x.replace(/ /g, '').length)
    .map((phrase) => phrase.replace(/ /g, ''))
    .join('|'),
  'g',
);

const SPACED_BACK_FORM: ReadonlyMap<string, string> = new Map(
  SPACED_BACK_PHRASES.map((phrase) => [phrase.replace(/ /g, ''), phrase]),
);

function joinSpelledOutWords(text: string): string {
  return text.replace(SPELLED_OUT_RUN, (run) => {
    const spaced = run.replace(/[^a-z]/g, '')
      .replace(SPACED_BACK, (compact) => ` ${SPACED_BACK_FORM.get(compact) ?? compact} `)
      .split(' ')
      .map((part) => part.replace(SPACED_BACK_STAFF, (title) => ` ${title} `))
      .join(' ')
      .replace(/ +/g, ' ')
      .trim();
    return ` ${spaced} `;
  });
}

/**
 * A word split in two by a phone keyboard or a habit: "kill my self", "un
 * alive". Joined so the cues match either spelling. Run on both elongation
 * readings, because a held key inside the split ("myyy self", "my selfff")
 * only collapses to the joinable form in the fully collapsed one.
 */
function joinSplitWords(text: string, extraReading = false): string {
  const joined = text
    .replace(/\bmy self\b/g, 'myself')
    .replace(/\bun alive\b/g, 'unalive');
  // HF12b's own join lives in the extra reading only, so main's normal form
  // (and every cue it gave) is unchanged. A split "i m" is joined there by
  // the spelled-out run join.
  return extraReading
    ? joined.replace(/\b(your|ur) self\b/g, '$1self')
    : joined;
}

/**
 * Collapsing elongation to two letters keeps doubled-letter words intact, but
 * a single-letter word typed long ("sooooo" -> "soo") no longer matches its
 * own spelling. Both readings are scanned and their cues combined, so neither
 * elongation shape can hide a disclosure.
 */
function collapseFully(normalized: string, extraReading = false): string {
  return joinSplitWords(normalized.replace(/(.)\1+/g, '$1'), extraReading);
}


// The grooming cue's picture and video parts, built from named pieces so each
// guard is stated once (HF12b; review rounds on PR 2076).
// A gym, technique or product phrase is left out only when it ends what was
// asked, so that anything after it still files.
const TECHNIQUE_END = String.raw`(?: (?:please|pls|plz|thanks|thank you|thx|ty|asap|again|today|lol))?$`;
const PICTURE_NOUNS = String.raw`(?:pic|pics|pix|picture|pictures|photo|photos|selfie|selfies)`;
// "snap" is also boxing for a sharp punch ("more snap on my jab", "snaps on
// every punch"): the punch sense is left out.
const VIDEO_NOUNS = String.raw`(?:vid|vids|videos?(?! consents?\b)|snaps(?! (?:on (?:my|the|every|each|his|your) (?:jabs?|punch(?:es)?|bag|pads|cros+|hooks?)|not push(?:es)?|behind (?:the|my|your|his) (?:jabs?|punch(?:es)?|cros+))${TECHNIQUE_END})|snapchats?|(?<=\b(?:a|another) )snap)`;
const ANY_PICTURE = String.raw`(?:pic|pics|pix|picture|pictures|photo|photos|selfie|selfies|vid|vids|video|videos|snap|snaps|snapchats?|cameras?|films|filmed|filming|record (?:button|setting|mode)|(?:hit|hits|press|pressed|presses) record|records(?! (?:my|his|her) (?:pr|pb|score|best|time)${TECHNIQUE_END})|recorded(?! (?:my|his|her) (?:pr|pb|score|best(?: time| score)?|time)${TECHNIQUE_END})|recording)`;
const WORD = String.raw`(?: [a-z0-9]+)`;
const PICTURE_COUNT = String.raw`(?:a |an |more |some |private |another |any )?`;
const GYM_EVENT_NOUNS = String.raw`fight|fights|bout|bouts|event|events|match|tournament|win|belt|medal|team|clas+|spar+ing|scale`;
// Main's picture guard, unchanged: pictures of or from a fight, an event, the
// team, a class, sparring or the scale.
const PICTURE_GUARD = String.raw`(?! (?:of|from) (?:(?:my|the|our|his|her|their) )?(?:${GYM_EVENT_NOUNS})\b)`;
// Technique, session and homework videos, for video words only, named as
// gym phrases ("of the 3 punch combo", "of my left hook"). Undress, shower
// and changing-room words are a separate alternative below, so this guard
// cannot hide them.
const TECHNIQUE_NOUNS = String.raw`(?:${GYM_EVENT_NOUNS}|dril+s?|combos?|jabs?|ho+ks?|up+ercuts?|fo+twork|stance|pad ?work|mit+ ?work|bag ?work|technique|warm ?ups?|workouts?|ses+ions?|routines?|circuits?|schedule|timetable|calendar|training|shadow ?boxing|punch(?:es)?|defen[cs]e|head movement|form|pads|roadwork|skip+ing|jump rope|(?:hand )?wraps|homework|combinations?|cros+(?:es)?|guard|slips|rol+s|conditioning|sprints|one two|1 2|runs?|lifts?|squats?|deadlifts?|bench|miles?)`;
const TECHNIQUE_FILLER = String.raw`(?:the|my|your|ur|his|her|our|their|a|an|that|this|todays|[0-9]+|one|two|three|four|punch|slip|jab|pad|bag|mit+|shadow|new|basic|first|last|next|left|right|lead|rear)`;
const VIDEO_GUARD = String.raw`(?! (?:(?:of|from|on|showing) (?:${TECHNIQUE_FILLER} ){0,3}${TECHNIQUE_NOUNS}(?: ${TECHNIQUE_NOUNS})?${TECHNIQUE_END}|(?:of|on|about|showing) how to (?:do )?(?:the |a |that |this )?(?:slip|jab|throw|block|parry|duck|rol+|pivot|wrap|punch|hook|uppercut|skip|hold the pads|${TECHNIQUE_NOUNS})(?: (?:${TECHNIQUE_FILLER} ){0,3}${TECHNIQUE_NOUNS})?${TECHNIQUE_END}))`;
const ASK = String.raw`(?:asking|asks|asked|ask|wants|want|wanted|wanting|begs|begged|begging|beg)`;
// Main's picture request, with "pix" and begging added.
const PICTURE_REQUEST = String.raw`(?:${ASK} (?:me )?(?:for |to see |to send (?:him |her |them )?)?|send (?:him |her |them |me )?)${PICTURE_COUNT}${PICTURE_NOUNS}\b${PICTURE_GUARD}`;
// A video request aimed at the child: a send to someone, "asks me for", being
// made to send, someone who keeps asking, or a third person or staff title
// wanting one. Feature requests and product talk stay out.
const VIDEO_ASKER = String.raw`(?:he|she|they|hes|shes|theyre|coach|someone|somebody|guy|man|mr|mrs|ms|miss|sir|trainer|instructor|volunteer|staff|teacher|uncle|aunt|dad|daddy|stepdad|step dad|stepbrother|brother|cousin|grandpa|boyfriend|girlfriend|neighbou?r|boys?|girls?|kid|men|guys)`;
const VIDEO_PRODUCT_GUARD = String.raw`(?!(?: of (?:the |our |a )?(?:kids |adult |youth |new )?(?:clas+|team|gym|event|fight|tournament|open house|everyone[a-z ]{0,30}))? for (?:the |my |our |a )?(?:website|newslet+er|instagram|insta|socials?|social media|promo|scho+l(?: project)?|project|tour)${TECHNIQUE_END})(?! (?:in the ap+|library|tutorials?|content|consent|uploaded(?: to (?:the )?(?:ap+|site|website))?|of the (?:new )?(?:building|gym|gear)|of the (?:gloves|gear|merch) we sel+|of the open house|of the kids clas+)${TECHNIQUE_END})`;
// The product asking for a video ("the app asks me", "shadow keeps asking")
// is not a person; a message sent "on the app" is.
const PRODUCT_SUBJECT = String.raw`(?<!(?<!\b(?:on|in|through|via|from|off|of|at) )\bthe (?:ap+|site|page|form|screen) (?:(?:ke+ps|ke+pt|ke+p|always|wont stop) )?)(?<!(?:^|\bthe )shadow (?:(?:ke+ps|ke+pt|ke+p|always|wont stop) )?)`;
const PLURAL_ASKER = String.raw`(?:people|kids|older kids|grown ups|adults|men|guys)`;
const VIDEO_REQUEST = [
  String.raw`\b${PLURAL_ASKER}(?: [a-z]+){0,4}? ${ASK} (?:me )?(?:for |to see )?${PICTURE_COUNT}${VIDEO_NOUNS}${VIDEO_GUARD}(?! of (?:my |the |our )?(?:knockouts?|kos?|wins|highlights?)${TECHNIQUE_END}) of (?:me|us|u|you|my|myself)\b`,
  String.raw`(?:send (?:him |her |them |me )|${PRODUCT_SUBJECT}${ASK} me (?:for |to see |to send (?:him |her |them )?|to make (?:him |her |them )?)?|(?:made|makes|make|making|gets|got|get) me (?:to )?send (?:him |her |them )?|${PRODUCT_SUBJECT}(?:keeps|kept|keep|always|wont stop) (?:asking|begging|bugging) (?:me )?for )${PICTURE_COUNT}${VIDEO_NOUNS}\b${VIDEO_GUARD}`,
  // The product asking is excused only when that ends what was asked.
  String.raw`(?:${ASK} me (?:for |to see |to send (?:him |her |them )?|to make (?:him |her |them )?)?|(?:keeps|kept|keep|always|wont stop) (?:asking|begging|bugging) (?:me )?for )${PICTURE_COUNT}${VIDEO_NOUNS}\b${VIDEO_GUARD}(?!${TECHNIQUE_END})`,
  String.raw`\b${VIDEO_ASKER}(?: [a-z]+){0,4}? ${ASK} (?:me )?(?:for |to see )?(?:a |an |some |private |another |any )?${VIDEO_NOUNS}\b${VIDEO_GUARD}${VIDEO_PRODUCT_GUARD}`,
].join('|');
const UNDRESS_WORDS = String.raw`(?:shower|showering|changing rooms?|change rooms?|get+ing changed|get changed|got changed|undres+|undres+ed|undres+ing|naked|nude|no clothes|underwear|no shirt|no top|shirt off|top off|shirtles+|toples+|without (?:a |any |your |my |his |her )?(?:shirts?|tops?|clothes)|bra|sports bra|swimsuit|swimming costume|bikini|wearing nothing|wear nothing|pyjamas|pajamas|pjs|(?:wearing )?only (?:in )?(?:my |his |her )?(?:shorts|boxers|underwear))`;
const PRIVATE_PLACE_WORDS = String.raw`(?:showers|in the bath|bathtub|locker rooms?|bathrooms?|toilets?|in bed|bedro+m|on (?:my|the|your|his|her) bed)`;
const PERSON_OR_REQUEST = String.raw`(?:he|she|they|hes|shes|theyre|someone|somebody|him|her|his|me|us|asked|asks|wants|wanted|send|sent|took|takes|taking|filmed|filming)`;
// A picture near undress files in either order; near a private place it
// files when a person or request word is near too.
// A request for a private or secret picture, and a stranger online asking for
// one, file whatever gym words follow (reviews 10 and 11 on PR 2076).
const STRANGER_ONE = String.raw`(?:stranger|(?:man|guy|someone|somebody|person|men|guys|(?<=\b(?:from|in|on|of|at|with|for)(?: (?:the|my|our))? )adult|(?<=\b(?:man|guy|someone|somebody|person|coach|lady|woman|dude|girl|boy|men|guys)\b(?: [a-z]+){0,4} )adult|adult(?! (?:boxing )?(?:clas+|clas+es|program|programs|ses+ions?|schedule|section|team)(?: (?:schedule|page|account|channel|group|chat))? (?:online|on (?:insta|instagram|snapchat|snap|tiktok|discord|roblox|fortnite))\b))(?: [a-z]+){0,2} (?:online|i dont know|i didnt know|i never met|on (?:insta|instagram|snapchat|snap|tiktok|discord|roblox|fortnite)))`;
const STRANGER = String.raw`(?:${STRANGER_ONE}|people(?: [a-z]+){0,2} (?:online|i dont know|i didnt know|i never met|on (?:insta|instagram|snapchat|snap|tiktok|discord|roblox|fortnite)))`;
// Everyday stranger, private-video and secret-video talk is excused only as
// a whole message in one of these forms; anything else near a picture files.
// Doubled letters are matched as one or more, as the collapsed reading spells
// them.
const tolerant = (pattern: string) => pattern.replace(/([a-z])\1/g, '$1+');
const GYM_THING = String.raw`(?:${TECHNIQUE_NOUNS}|boxing|shoulder rolls?|moves?)`;
const STRANGER_PLAIN = STRANGER_ONE.replace('(?: [a-z]+){0,2}', String.raw`(?: (?!(?:me|my|us)\b)[a-z]+){0,2}`);
const EVERYDAY_PICTURE = String.raw`(?:videos?|vids?|pics?|photos?|pictures?)`;
const STRANGER_EVERYDAY = tolerant(String.raw`(?:i copied (?:a |an |some |this |that |the )?${STRANGER_PLAIN} and (?:recorded|filmed) (?:my ${GYM_THING}|it)|(?:(?:i )?(?:saw|watched|found) )?(?:a |an |some |this |that |the )?${STRANGER_PLAIN}(?: (?:liked|likes|commented on|reviewed|keeps messaging me about) (?:my|our|the|a) (?:${GYM_THING} )+${EVERYDAY_PICTURE}| (?:just |always |also )?(?:has|had|have|posted|posts|post|made|makes|shared|uploaded|with)(?: (?:a|an|some)| the(?= (?:great|good|best|new|cool)\b))?(?: (?:great|good|best|new|cool))*(?: ${GYM_THING})+ ${EVERYDAY_PICTURE}| (?:just |always |also )?(?:has|had|have|posted|posts|post|made|makes|shared|uploaded|with|sent me|sends me)(?: (?:a|an|the|some|great|good|best|new|cool))* ${EVERYDAY_PICTURE} (?:of|on|about|from) (?:the |a )?${GYM_THING}(?: ${GYM_THING})?| breaks? down the ${GYM_THING} in (?:a|the) ${EVERYDAY_PICTURE})(?: (?:we did|all the time|today|again|lol))?|(?=.*\bat the (?:tournament|event|show)\b)(?:a |an |some |the )?${STRANGER_PLAIN}(?: at the (?:tournament|event|show))? (?:filmed|recorded|took (?:a |some )?(?:photos?|pictures?|pics?) of) (?:my |the |our )?(?:fight|fights|bout|match|team|everyone|everybody)(?: at the (?:tournament|event|show))?)`);
const PRIVATE_EVERYDAY = tolerant(String.raw`(?:can i (?:book|get) (?:a )?private video (?:lessons?|sessions?)(?: with coach)?|do you (?:do|have|offer) private video (?:lessons?|sessions?)|(?:can the app have|the app should have) (?:a )?private (?:videos?|photos?)(?: options?)?|is there a private video option|i made it a private video so only coach can see it|i sent coach a private video of my ${GYM_THING}|i (?:have|had) my private video (?:lessons?|sessions?) (?:tomorrow|today)|i shared the private video (?:lessons?|sessions?) with my (?:mom|dad|parents)|i uploaded a private video to youtube so coach can check my ${GYM_THING})`);
const SECRET_EVERYDAY = tolerant(String.raw`(?:can i (?:get|see)|show me) (?:a |the |some )?secret (?:videos?|vids?) of (?:the|a) (?:new )?${GYM_THING}`);
const PICTURE_NEAR_PLACE = [
  // A private or secret picture files with any verb unless the whole message
  // is everyday lesson, product or technique talk.
  String.raw`^(?!${PRIVATE_EVERYDAY}$).*\bprivate ${ANY_PICTURE}\b`,
  String.raw`^(?!${SECRET_EVERYDAY}$).*\bsecret ${ANY_PICTURE}\b`,
  // A stranger online asking for a picture files whatever gym words follow;
  // any other stranger near a picture files unless the whole message is
  // everyday tutorial or tournament talk; a picture sent to a stranger
  // files.
  String.raw`${STRANGER}${WORD}{0,4}? (?:${ASK}|keeps? asking|keeps? begging|askin|keeps? askin|beggin|keeps? beggin)${WORD}{0,4} ${ANY_PICTURE}`,
  String.raw`^(?!${STRANGER_EVERYDAY}$).*${STRANGER_ONE}${WORD}{0,14}? ${ANY_PICTURE}\b`,
  String.raw`\b(?:sent|send|sending|gave|give|showed|show)${WORD}{0,3} ${ANY_PICTURE}\b(?: (?:to|with))? (?:a |an |some |this |that |the )?${STRANGER_ONE}`,
  String.raw`${ANY_PICTURE}${WORD}{0,6} ${UNDRESS_WORDS}`,
  String.raw`${UNDRESS_WORDS}${WORD}{0,6} ${ANY_PICTURE}`,
  String.raw`(?:${ANY_PICTURE}|film|record)(?: of)? (?:me|her|him|us|them|myself|herself|himself|the (?:girls|boys|kids)|my (?:sister|brother|friends?|teammates?))(?: (?:while|whilst|when|as)(?: (?:i was|im|i am|i|she was|he was|we were|they were))?)? (?:changing|changed)(?! (?:up )?(?:my |his |her |the |our )?(?:stance|direction|levels?|angles?|gloves|wraps|weight(?: clas+)?|guard|feet|grip|partners?|pace|corners?|sides|rhythm|hands|mats|ropes|timer)(?: (?:on|in|at) (?:the |my )?(?:bag|pads|ring|mats?))?${TECHNIQUE_END})`,
  String.raw`${PERSON_OR_REQUEST}${WORD}{0,4} ${ANY_PICTURE}${WORD}{0,6} ${PRIVATE_PLACE_WORDS}`,
  String.raw`${ANY_PICTURE}${WORD}{0,4} ${PERSON_OR_REQUEST}${WORD}{0,4} ${PRIVATE_PLACE_WORDS}`,
  String.raw`${PRIVATE_PLACE_WORDS}${WORD}{0,4} ${PERSON_OR_REQUEST}${WORD}{0,4} ${ANY_PICTURE}`,
].join('|');

const GROOMING_PATTERN = new RegExp(
  String.raw`\b(when nobody is looking|when no one is looking|when nobodys looking|when everyone leaves|after everyone leaves|keeps me after|keep me after|stay behind|stays behind|by myself with|alone in the office|in the office alone|took a picture of me|takes pictures of me|filmed me|recorded me|watches me get changed|watches me change|watched me change|take my shirt off|took my shirt off|get changed in front|our little secret|our little thing|our secret|special friend|dont show anyone|dont show anybody|not allowed to tell|cant tell my mom|cant tell my dad|cant tell anyone|off the team if i tell|if i tell anyone|texts me at night|texting me at night|messages me at night|asked me not to say|molest|molests|molested|molesting|molester|molestation|rape|rapes|raped|raping|rapist|r ped|rap3d|r4ped|r4pe|raepd|sexual(?:ly)? (?:abus|as+a?u?l+t)[a-z]*|sexualy (?:abus|as+a?u?l+t)[a-z]*|sexually touched|grooming me|groomed me|grooms me|groped|gropes|groping|fondled|fondles|fondling|(?:made|makes|make|making) me touch(?! gloves\b)|sent me nudes|asked for nudes|asked me for nudes|asks me for nudes|asks for nudes|wants nudes|send nudes|dick pic|dick pics|${PICTURE_REQUEST}|${VIDEO_REQUEST}|pedo|pedophile|paedo|paedophile|had sex with me|have sex with me|${PICTURE_NEAR_PLACE})\b`,
);

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
      /\b(hurt me|hurts me|hurting me|hit me|hits me|hitting me|punched me|punches me|punching me|kicked me|kicks me|kicking me|grabbed me|grabs me|grabbing me|pushed me|pushes me|pushing me|shoved me|shoves me|shoving me|slapped me|slaps me|slapping me|tripped me|trips me|tripping me|choked|choking me|threw me|throwing me|dragged me|drags me|dragging me|held me down|pinned me down|hits us|hurts us|abused me|abuses me|abusing me|was abused|got abused|been abused|being abused|is abusive|was abusive|assaulted me|assaults me|assaulting me|as+a?u?l+ted me)\b/,
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
    //    they file in boxing context. Not coaching about pace: "on the
    //    (heavy) bag/pads/mitts/treadmill", and "in the first round" / "in
    //    round one" only after "dont", "not", "never" or "need/have to" (a
    //    command in a round still files).
    // Pinned, accepted false alerts: "suicide runs after sparring", "only"
    // before digits or ten..nineteen and kms ("only 3 kms today"), "take the
    // pressure off myself", "i ran kms before school", "dont wanna live in
    // this town". Plain "take my life" is not a cue ("take
    // my life seriously"); "take my own life" is.
    id: 'crisis',
    pattern:
      /\b(kill myself|killing myself|hurt myself|hurting myself|cut myself|cutting myself|want to die|wanna die|end it all|nobody cares|no one cares|hate myself|suicidal|suicidel|sucidal|suicidial|suisidal|suicide(?! (?:dril+s?|sprints?|shut+les?|squad)\b)|suiside|sucide|suacide|suicde|commit sudoku|sewerslide|sewer slide|unalive|unalived|unaliving|kil myself|kill myslef|killmyself|(?<!\b(?:wraps?|tape|gloves?|shoes?|boots|shirt|headgear|headguard|mouthguard|pads|(?:take|took|get|got|pull|pulled|cut) (?:it|them)) )off myself|shoot myself|neck myself|want 2 die|want 2 be dead|want (?:to|2) b dead|wanna b dead|dont want 2 live|end my life|end my own life|ending my life|take my own life|taking my own life|dont want to live|dont wanna live|want to be dead|wanna be dead|better off dead|slit my wrists?|hang myself|hanging myself|overdose|overdosed|overdoses|overdosing|self ?harm|self ?harms|self ?harmed|self ?harming|harm myself|harming myself|(?:gonna|gunna|going to|wanna|want to|imma|ima|finna|about to|bout to|i will) of myself|kys|(?:hang|neck|shoot) (?:yourself|urself)|(?<=\b(?:dont|not|never|ne+d to|have to) )kil+ (?:yourself|urself)(?! (?:in (?:the )?(?:first |1st |opening |early )?rounds?|in round (?:one|1)|on the (?:heavy )?(?:bag|pads|mit+s|tre+dmil+))(?: (?:please|pls|plz|thanks|lol))?$)|(?<!\b(?:dont|not|never|ne+d to|have to) )kil+ (?:yourself|urself)(?! on the (?:heavy )?(?:bag|pads|mit+s|tre+dmil+)(?: (?:please|pls|plz|thanks|lol))?$))\b|(?<!\b(?:[0-9]+|a few|few|a couple|couple|many|how many|hundreds? of|thousands? of|hundred|two|thre+|four|five|six|seven|eight|nine|eleven|twelve|ten|thirte+n|fourte+n|fifte+n|sixte+n|sevente+n|eighte+n|ninete+n|twenty|thirty|forty|fifty) )\bkms\b|\b(?:im|i am|(?<![0-9] )am|only|age)(?: only)? (?:[0-9]+|ten|eleven|twelve|thirte+n|fourte+n|fifte+n|sixte+n|sevente+n|eighte+n|ninete+n)(?: yo| years old| and)? kms\b(?! (?:away|to go|from (?:the|my|home|here|school))\b)/,
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
    // the gym phrase left out, for video words only; pictures keep the guard
    // they had. See the named pieces above GROOMING_PATTERN.
    id: 'grooming_or_isolation',
    pattern:
      GROOMING_PATTERN,
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
      /\b(wish i was dead|wish i were dead|wish i was ded|wish i were ded|dont want 2 be alive|dont want 2 be here anymore|wish i wasnt alive|wish i wasnt here|dont want to be alive|dont want to be here anymore|do something bad to myself|hurt myself|run away|running away|ran away|disappear forever|better off without me|nobody would miss me|no one would miss me)\b/,
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
  // The spelled-out reading is added, never substituted, so every cue main's
  // normal form gave is still given.
  // Each form of the text (scanForms: as typed, and with invisible characters removed) gives
  // its four readings.
  const readings = [...new Set(scanForms(body).flatMap((form) => {
    const normalized = normalizeForSafetyScan(form);
    const spelled = spelledOutReading(form);
    return [normalized, collapseFully(normalized), spelled, collapseFully(spelled, true)];
  }))];
  const cues = SAFETY_CUES
    .filter((cue) => readings.some((reading) => cue.pattern.test(reading)))
    .map((cue) => cue.id);

  return { safeguarding: cues.length > 0, cues };
}
