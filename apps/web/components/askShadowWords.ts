/**
 * What the Ask SHADOW tab tells an athlete about who sees what they send.
 *
 * Ask SHADOW posts to /api/pilot/athlete/chat, which forwards to the SHADOW
 * chat route. There, detectShadowDisclosure (src/server/pilot/shadowDisclosure.ts)
 * files a safety alert when a message sounds like someone may not be safe: to
 * the athlete's coach of record, any covering coach and the admins, or to the
 * admins only when the message names gym staff, carries a grooming, secrecy
 * or touch cue, or comes in a conversation that already filed admin-only. An
 * account with no athlete record files nothing.
 *
 * Otherwise no coach reads the words (CODE_READ, PR 2059): a conversation is
 * read only by its owner; the SHADOW reviews queue is admin-only; and a
 * question SHADOW could not answer is filed for research with the words
 * stored, but a coach receives it as a fixed sentence without them (F-054,
 * OD-2026-10-13-018; researchFamilyView.ts researchRequirementsForReader).
 *
 * So every line here says an alert CAN reach a coach or the gym office, and
 * that otherwise no coach sees it. The earlier lines ("No coach is notified",
 * "it does not reach a coach") were false whenever an alert was filed (HF2).
 *
 * The wording is the owner's ruling, relayed by Overwatch on PR 2059: Q3 = A,
 * "A for both". Kept in one file so a change of words is one edit;
 * askShadowWords.test.ts pins the exact words and what any wording must say.
 */

/** Shown after an Ask SHADOW message is saved. */
export const ASK_SHADOW_SENT_LINE =
  'Saved to your SHADOW conversation. SHADOW answers there -- open SHADOW Chat to read it. '
  + 'If what you wrote sounds like someone may not be safe, your coach or the gym office can get an alert. '
  + 'Otherwise no coach sees it.';

/** The Ask SHADOW help panel's description. */
export const ASK_SHADOW_HELP_LINE =
  'Write a question. It is recorded in your own SHADOW conversation and answered by SHADOW. '
  + 'No coach sees it, unless it sounds like someone may not be safe: '
  + 'then your coach or the gym office can get an alert.';

/** The SafeSport box on the Ask SHADOW tab, after its "SafeSport:" label. */
export const ASK_SHADOW_SAFESPORT_LINE =
  'what you send here is kept, and your parent is not automatically copied. '
  + 'If it sounds like someone may not be safe, your coach or the gym office can get an alert; '
  + 'otherwise no coach sees it. Tell a coach or a trusted adult in person about anything urgent or unsafe.';
