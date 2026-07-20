export type ShadowFailureCode =
  | 'INVALID_REQUEST'
  | 'AUTHORIZATION_DENIED'
  | 'CONVERSATION_NOT_FOUND'
  | 'EVIDENCE_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'UNSAFE_OUTPUT_BLOCKED'
  | 'QUEUE_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'RESEARCH_REQUIRED';

const USER_MESSAGES: Record<ShadowFailureCode, string> = {
  INVALID_REQUEST: 'The request could not be processed. Check the message and try again.',
  AUTHORIZATION_DENIED: 'You do not have access to that SHADOW context.',
  CONVERSATION_NOT_FOUND: 'That conversation is unavailable or belongs to another account.',
  EVIDENCE_UNAVAILABLE: 'Verified evidence is temporarily unavailable. SHADOW will not invent a sourced answer.',
  MODEL_UNAVAILABLE: 'SHADOW is temporarily unavailable. Your request was not answered by the model.',
  UNSAFE_OUTPUT_BLOCKED: 'SHADOW withheld this response because it did not meet safety and authority requirements.',
  QUEUE_UNAVAILABLE: 'The deeper-analysis queue is temporarily unavailable. Try Quick Round or retry later.',
  DATABASE_UNAVAILABLE: 'SHADOW could not safely access the required records. Please try again later.',
  RESEARCH_REQUIRED: 'Verified evidence is not sufficient yet. A research requirement may be created.',
};

export function shadowFailure(code: ShadowFailureCode, correlationId: string, detail?: string) {
  return {
    success: false as const,
    code,
    response: USER_MESSAGES[code],
    correlationId,
    retryable: ['MODEL_UNAVAILABLE', 'QUEUE_UNAVAILABLE', 'DATABASE_UNAVAILABLE', 'EVIDENCE_UNAVAILABLE'].includes(code),
    detail: process.env.NODE_ENV === 'production' ? undefined : detail,
  };
}