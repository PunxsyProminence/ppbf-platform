export interface ConsentRecord {
  participantId: string;
  consentType: string;
  given: boolean;
  timestamp: string;
  version: string;
}

export function recordConsent(participantId: string, consentType: string, given: boolean) {
  return {
    participantId,
    consentType,
    given,
    timestamp: new Date().toISOString(),
    version: '1.0',
    loggedToLedger: true,
  };
}
