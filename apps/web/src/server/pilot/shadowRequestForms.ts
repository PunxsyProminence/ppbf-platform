import { INVISIBLE_FORMAT, scanForms } from './feedbackSafetyScan';
import { type ShadowValidationResult, validateShadowRequest } from './shadowChat';

/**
 * The SHADOW chat request check, read in every form of the message (Overwatch Q14 A on PR #2151,
 * under the hard floor; PR #2151 reviewer A).
 *
 * An invisible character inside a word -- "I can't bre[U+200B]athe", "ch[U+200B]est pain",
 * "pa[U+00AD]ssed out" -- hid the word from every pattern in classifyHighRiskTopic and
 * validateShadowRequest, so the emergency answer was not given. scanForms (feedbackSafetyScan.ts)
 * gives the message as typed and, when it has invisible characters, with them removed, as the
 * safety scan reads it. validateShadowRequest -- and the classifyHighRiskTopic call inside it --
 * runs on each form.
 *
 * A third form reads each invisible character as a space, as the safety scan's own normal form does
 * (feedbackSafetyScan.ts): "I can't[U+200B]breathe" and "chest[U+200B]pain" use one IN PLACE of a
 * space, and removing it joins the two words, so neither of the other forms reads them (PR #2151
 * Q14 delta reviewer; same principle as Q14 A).
 *
 * The answer: the emergency one if any form has it; otherwise the first form that withholds;
 * otherwise the typed form's. Reading the typed form too, rather than only the stripped one, keeps
 * "my[U+200B]shoulder hurts" withheld: stripped it is "myshoulder hurts", which no pattern reads
 * as personal, but the typed form still withholds it. A message with no invisible character has
 * one form, so its answer is validateShadowRequest's, unchanged.
 *
 * Why a separate entry and not an edit to the two functions: shadowChatSensitivity.test.ts proves
 * them statement for statement equal to main's but for the apostrophe fold, and that proof stays
 * whole when they are left as they are.
 */
export function validateShadowRequestInEveryForm(
  message: string,
  userRole: string,
  organizationId: string,
): ShadowValidationResult {
  const forms = scanForms(message);
  const readings = forms.length > 1 ? [...forms, message.replace(INVISIBLE_FORMAT, ' ')] : forms;
  const results = readings.map((form) => validateShadowRequest(form, userRole, organizationId));
  return results.find((result) => result.classification === 'urgent_personal_symptom')
    ?? results.find((result) => !result.valid)
    ?? results[0];
}
