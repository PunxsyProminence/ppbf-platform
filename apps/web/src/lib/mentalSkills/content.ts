/**
 * Athlete mental skills: the words on screen. EVERY STRING HERE IS OWNER-
 * APPROVED, verbatim. Jason approved each one in-session on 2026-10-04 ("Approve
 * as written"). Do not rewrite, extend or "improve" them in code; a wording
 * change is a new question to Jason.
 *
 * Keys stay the research terms (instructional / motivational, Hatzigeorgiadis
 * et al. 2011, evidence registry A4-025); the screen shows both names, so it
 * matches the research and the words Jason chose between.
 */

/** Mirrors SELF_TALK_CUE_KINDS in the server module; content.test.ts holds them equal. */
export type SelfTalkCueKind = 'instructional' | 'motivational';

export const CUE_KIND_LABELS: Readonly<Record<SelfTalkCueKind, string>> = {
  instructional: 'Technique (instructional)',
  motivational: 'Effort (motivational)',
};

/** Under the cue box. Source: Hatzigeorgiadis et al. 2011, registry A4-025. */
export const SELF_TALK_EXPLAINER =
  "Technique (instructional): a short reminder of how to do it, like 'hands home'. "
  + "Effort (motivational): a short push to keep going, like 'keep working'. "
  + 'Research reviews find technique cues help most with skill work and effort cues with hard, tiring work.';

/**
 * The solo imagery session, adapted from the drill "Imagery Rehearsal"
 * (SK-REV-02, seed drill library), which is written coach-led and marked
 * "literature-grounded draft, requires floor validation".
 */
export const IMAGERY_SOURCE = {
  contentKey: 'imagery-rehearsal',
  drillName: 'Imagery Rehearsal',
  skillId: 'SK-REV-02',
} as const;

export const IMAGERY_STEPS: readonly string[] = [
  'Pick ONE technique and say its name out loud (e.g. "jab").',
  'Stand still, hands up in your guard. No footwork, no punches.',
  'Close your eyes and picture yourself throwing that one technique, clean.',
  'Open your eyes and say the name again.',
  'Throw it once for real at working pace. Nothing else.',
];

export const IMAGERY_AFTER = 'Then log how many minutes.';
