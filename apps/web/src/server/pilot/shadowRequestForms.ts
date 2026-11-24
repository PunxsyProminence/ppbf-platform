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
 * otherwise the first form that reads a high-risk topic; otherwise the typed form's. The high-risk
 * step keeps "what is ch[U+200B]est pain" on the high-risk path (the human-review probe and the
 * high-risk flags in app/api/pilot/shadow/chat/route.ts): its stripped form is a valid educational
 * question with highRisk true, and its typed form an ordinary one (Codex P1 on PR #2151). Reading the typed form too, rather than only the stripped one, keeps
 * "my[U+200B]shoulder hurts" withheld: stripped it is "myshoulder hurts", which no pattern reads
 * as personal, but the typed form still withholds it. A message with no invisible character has
 * one form, so its answer is validateShadowRequest's, unchanged.
 *
 * Why a separate entry and not an edit to the two functions: shadowChatSensitivity.test.ts proves
 * them statement for statement equal to main's but for the apostrophe fold, and that proof stays
 * whole when they are left as they are.
 */
/**
 * classifyHighRiskTopic's own order (shadowChat.ts): the first pattern that matches a message gives
 * its topic. shadowRequestForms.test.ts pins this list to the classifier, pair by pair. When two
 * readings find different topics ("what is ch[U+200B]est pain and surgery": as typed, surgery;
 * removed, chest pain), the high-risk step takes the topic the plain spelling would get, the one
 * ranked first (PR #2152 reviewer: the other could drop the review row from critical to high).
 */
export const HIGH_RISK_TOPIC_ORDER: readonly string[] = [
  'concussion', 'head_trauma', 'loss_of_consciousness', 'dizziness', 'dehydration', 'weight_cutting',
  'rapid_weight_loss', 'chest_pain', 'fainting', 'medication', 'prescription', 'surgery', 'injection',
  'return_to_play', 'medical_clearance', 'youth_safety', 'urgent_symptom',
];

const topicRank = (topic: string | undefined): number => {
  const rank = HIGH_RISK_TOPIC_ORDER.indexOf(topic ?? '');
  return rank < 0 ? HIGH_RISK_TOPIC_ORDER.length : rank;
};

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
    ?? results.filter((result) => result.highRisk === true).sort((a, b) => topicRank(a.topic) - topicRank(b.topic))[0]
    ?? results[0];
}
