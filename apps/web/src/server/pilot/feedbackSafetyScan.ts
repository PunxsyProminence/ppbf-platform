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
  return body
    .toLowerCase()
    .replace(/[‘’ʼ'`]/g, '')
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
    .trim();
}

/**
 * Collapsing elongation to two letters keeps doubled-letter words intact, but
 * a single-letter word typed long ("sooooo" -> "soo") no longer matches its
 * own spelling. Both readings are scanned and their cues combined, so neither
 * elongation shape can hide a disclosure.
 */
function collapseFully(normalized: string): string {
  return normalized.replace(/(.)\1+/g, '$1');
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
      /\b(hurt me|hurts me|hurting me|hit me|hits me|hitting me|punched me|punches me|punching me|kicked me|kicks me|kicking me|grabbed me|grabs me|grabbing me|pushed me|pushes me|pushing me|shoved me|shoves me|shoving me|slapped me|slaps me|slapping me|tripped me|trips me|tripping me|choked|choking me|threw me|throwing me|dragged me|drags me|dragging me|held me down|pinned me down|hits us|hurts us)\b/,
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
    id: 'crisis',
    pattern:
      /\b(kill myself|killing myself|hurt myself|hurting myself|cut myself|cutting myself|want to die|wanna die|end it all|nobody cares|no one cares|hate myself)\b/,
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
    // sexualized contact, and threats tied to belonging.
    id: 'grooming_or_isolation',
    pattern:
      /\b(when nobody is looking|when no one is looking|when nobodys looking|when everyone leaves|after everyone leaves|keeps me after|keep me after|stay behind|stays behind|by myself with|alone in the office|in the office alone|took a picture of me|takes pictures of me|filmed me|recorded me|watches me get changed|watches me change|watched me change|take my shirt off|took my shirt off|get changed in front|our little secret|our little thing|our secret|special friend|dont show anyone|dont show anybody|not allowed to tell|cant tell my mom|cant tell my dad|cant tell anyone|off the team if i tell|if i tell anyone|texts me at night|texting me at night|messages me at night|asked me not to say)\b/,
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
  const normalized = normalizeForSafetyScan(body);
  const fullyCollapsed = collapseFully(normalized);
  const cues = SAFETY_CUES
    .filter((cue) => cue.pattern.test(normalized) || cue.pattern.test(fullyCollapsed))
    .map((cue) => cue.id);

  return { safeguarding: cues.length > 0, cues };
}
