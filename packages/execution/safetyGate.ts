import { isFeatureEnabled } from '../governance/featureFlags';

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  requiresJasonApproval: boolean;
}

export function runSafetyGate(
  action: string,
  participantType: string,
  hasMedicalClearance: boolean = false,
  isSparring: boolean = false
): SafetyCheckResult {
  // Hard refusals (Layer 0 governance)
  if (action === 'medical_diagnosis' || action === 'return_to_training_without_clearance') {
    return { allowed: false, reason: 'Hard refusal - medical decisions require licensed professional', requiresJasonApproval: true };
  }

  if (participantType === 'Youth' && (action === 'sparring' || action === 'contact')) {
    return { allowed: false, reason: 'Youth contact/sparring blocked without explicit Jason approval', requiresJasonApproval: true };
  }

  if (isSparring && !hasMedicalClearance) {
    return { allowed: false, reason: 'Sparring requires medical clearance + Jason approval', requiresJasonApproval: true };
  }

  // Feature flag check
  if (!isFeatureEnabled(11)) {
    return { allowed: false, reason: 'Safety Gate Matrix not yet promoted to active', requiresJasonApproval: true };
  }

  return { allowed: true, requiresJasonApproval: false };
}
