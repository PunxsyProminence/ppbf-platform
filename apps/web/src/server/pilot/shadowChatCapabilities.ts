import type { PilotRole } from './contracts';
import type { ShadowConversationSessionType } from './shadowConversations';

/**
 * Chat capability tiers.
 *
 * 'omega' is deliberately its own mode rather than an alias for 'master'.
 * Per the authority model in shadowRoleSets.ts, platform_owner is BROADER IN
 * BREADTH but STRICTLY NARROWER IN DEPTH than an organization admin: it reads
 * operational signal across organizations and must never reach protected
 * health information or SafeSport content in any of them. Collapsing it into
 * 'master' left the chat layer unable to express that difference, so any
 * depth restriction had nowhere to live and read as an oversight to remove.
 */
export interface ShadowChatCapabilities {
  mode: 'omega' | 'master' | 'scoped';
  /**
   * True only for the cross-organization tier. Callers assembling retrieval
   * context must keep it to operational and aggregate signal, never
   * organization-private athlete records.
   */
  crossOrganizationRead: boolean;
  /**
   * Always false for Omega. PHI and clearance state are organization-private;
   * see SHADOW_PHI_ROLES, which excludes platform_owner and is asserted by
   * shadowRoleSets.test.ts.
   */
  canAccessProtectedHealthInformation: boolean;
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
  const omega = role === 'platform_owner';
  const organizationAdmin = role === 'admin' || role === 'organization_admin';
  // Retained for the affordances Omega and organization admins genuinely
  // share: tier control, session management, and history export.
  const master = organizationAdmin || omega;
  const canOverride = master || role === 'coach';

  return {
    mode: omega ? 'omega' : organizationAdmin ? 'master' : 'scoped',
    crossOrganizationRead: omega,
    canAccessProtectedHealthInformation: organizationAdmin,
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
