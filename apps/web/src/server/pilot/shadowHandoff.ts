// shadowHandoff.ts — the human-handoff banner text, resolved from a response
// validation topic. Moved out of the chat route so the background job
// processor persists the same banner the synchronous path persists: before
// this module existed, resolveHandoff was private to the route and background
// Heavy Bag answers were appended with no handoff at all — a weight-cut
// answer generated in the background reached the athlete with no
// "talk to your medical team" line, on first display and on every restore.

// Human-handoff guidance for specific high-risk topics. Anything not listed
// here still gets a non-empty handoff via DEFAULT_HANDOFF_MESSAGE below --
// handoff must never be empty when a response requires human review.
const HANDOFF_MESSAGES: Record<string, string> = {
  concussion: 'Loop in your medical staff before any return-to-activity decision.',
  weight_cutting: 'Talk to your medical team and sports nutritionist before changing any weight-cut plan.',
  return_to_play: 'Return-to-play calls belong to a qualified medical professional -- bring this to them directly.',
  medical_clearance: 'Medical clearance is a licensed professional\'s call, not SHADOW\'s -- follow up with them directly.',
};
const DEFAULT_HANDOFF_MESSAGE = 'This needs a human coach, medical professional, or your organization admin to weigh in directly -- please follow up with them.';

export function resolveHandoff(input: { requiresHumanReview: boolean; topic: string | undefined }): string | undefined {
  if (!input.requiresHumanReview && !input.topic) {
    return undefined;
  }
  if (input.topic && HANDOFF_MESSAGES[input.topic]) {
    return HANDOFF_MESSAGES[input.topic];
  }
  return DEFAULT_HANDOFF_MESSAGE;
}
