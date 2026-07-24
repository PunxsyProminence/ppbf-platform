import type { PilotRole } from './contracts';
import type { ShadowConversationSessionType } from './shadowConversations';

export interface ShadowChatCapabilities {
  mode: 'master' | 'scoped';
  allowedSessionTypes: ShadowConversationSessionType[];
  canUseManualTier: boolean;
  canViewEvidence: boolean;
  canManageSessions: boolean;
  canExportConversationHistory: boolean;
  canExportOwnData: boolean;
  canRequestDeletion: boolean;
  deletionFulfillment: 'manual_review_required';
  canReviewSafetyEvents: boolean;
}

export function getShadowChatCapabilities(role: PilotRole): ShadowChatCapabilities {
  const organizationAdmin = role === 'admin' || role === 'organization_admin';
  const master = organizationAdmin || role === 'platform_owner';
  const canOverride = master || role === 'coach';

  return {
    mode: master ? 'master' : 'scoped',
    allowedSessionTypes: canOverride
      ? ['quick_round', 'heavy_bag']
      : ['quick_round'],
    canUseManualTier: canOverride,
    // Verified Library/formula retrieval is not wired into the live chat yet.
    canViewEvidence: false,
    canManageSessions: true,
    canExportConversationHistory: true,
    canExportOwnData: false,
    canRequestDeletion: true,
    deletionFulfillment: 'manual_review_required',
    canReviewSafetyEvents: master,
  };
}

export function canUseShadowSessionType(
  role: PilotRole,
  sessionType: string,
): sessionType is ShadowConversationSessionType {
  return getShadowChatCapabilities(role).allowedSessionTypes.includes(
    sessionType as ShadowConversationSessionType,
  );
}
