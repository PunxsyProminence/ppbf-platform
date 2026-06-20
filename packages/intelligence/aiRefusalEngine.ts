export type AIRequestType =
  | 'route_suggestion'
  | 'safety_flag'
  | 'progress_prediction'
  | 'medical_diagnosis'
  | 'return_to_training_clearance'
  | 'youth_sparring_recommendation'
  | 'contact_recommendation';

export interface AIRequest {
  type: AIRequestType;
  participantType: string;
  input: any;
}

export function runAIWithRefusal(request: AIRequest) {
  // Strict refusal protocol (Layer 0)
  const restrictedTypes = ['medical_diagnosis', 'return_to_training_clearance', 'youth_sparring_recommendation'];

  if (restrictedTypes.some(t => request.type.includes(t))) {
    return {
      allowed: false,
      reason: 'Hard refusal: This decision requires licensed professional + Jason approval',
      suggestion: null,
    };
  }

  if (request.participantType === 'Youth' && request.type.includes('contact')) {
    return {
      allowed: false,
      reason: 'Youth contact recommendations blocked without explicit Jason approval',
      suggestion: null,
    };
  }

  // Safe suggestions only
  return {
    allowed: true,
    suggestion: `AI suggestion for ${request.type} (requires coach review)`,
    confidence: 0.85,
    loggedToContinuityLedger: true,
  };
}
