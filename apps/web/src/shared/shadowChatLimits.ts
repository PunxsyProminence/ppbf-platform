// The size limit on one SHADOW chat question, shared by the route that
// enforces it and the composer that has to explain it.
//
// The route used to reject an over-long question inside the same check as an
// empty one, so a coach who pasted a long question was told "Enter a question
// for SHADOW." -- and the composer had already cleared the box, so the question
// survived only as a transcript bubble, not in the box where it could be
// shortened. One number, read by both sides, so the page can refuse before
// sending (and keep the text in the box) with the same limit the server applies.

/** Longest question the chat route accepts, measured as String.length. */
export const SHADOW_MESSAGE_MAX_LENGTH = 12_000;

/** What a coach is told when a question is over the limit. */
export const SHADOW_MESSAGE_TOO_LONG_RESPONSE = `That question is too long for SHADOW (limit ${
  new Intl.NumberFormat('en-US').format(SHADOW_MESSAGE_MAX_LENGTH)
} characters). Shorten it and send again.`;

export function isShadowMessageTooLong(message: string): boolean {
  return message.length > SHADOW_MESSAGE_MAX_LENGTH;
}
