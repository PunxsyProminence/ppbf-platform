export interface BrandAsset {
  id: string;
  type: 'crest' | 'mascot' | 'seal' | 'template';
  name: string;
  approved: boolean;
  consentTracking: boolean;
}

export const brandAssets: BrandAsset[] = [
  { id: 'crest-001', type: 'crest', name: 'PPBF Official Crest', approved: true, consentTracking: true },
  { id: 'mascot-001', type: 'mascot', name: 'Punchy the Protector', approved: true, consentTracking: true },
  { id: 'seal-001', type: 'seal', name: 'Governance Seal', approved: true, consentTracking: false },
];

export function getApprovedAssets() {
  return brandAssets.filter(a => a.approved);
}

export function trackPhotoConsent(participantId: string, assetId: string) {
  return {
    participantId,
    assetId,
    consentGiven: true,
    timestamp: new Date().toISOString(),
    loggedInContinuityLedger: true,
  };
}