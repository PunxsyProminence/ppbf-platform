import type { PilotRole } from './contracts';
import type { ShadowConversationSessionType } from './shadowConversations';
import { SHADOW_PHI_ROLES } from './shadowRoleSets';

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
   * Mirrors SHADOW_PHI_ROLES; it does NOT enforce anything.
   *
   * Enforcement lives at the routes that touch clinical state -- see
   * medical-status/route.ts, which calls requireRole(principal,
   * [...SHADOW_PHI_ROLES]). This field exists so a chat surface can describe
   * its own scope without restating that list, and is derived from it rather
   * than recomputed, so the two cannot drift. Do not treat a true value here
   * as authorization: check the role set at the point of access.
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
  /**
   * SHADOW's own chat-safety telemetry: filtered-response counts, refusal
   * rates, job safety_status. Operational signal about how the assistant is
   * behaving, carrying no clinical or youth-protection content.
   *
   * Renamed from canReviewSafetyEvents, which read as though it also covered
   * SafeSport and incident reporting. It never did -- no incident,
   * concussion, or return-to-play table exists in the schema -- but the name
   * invited a future youth-protection surface to reuse a flag that is true
   * for the cross-organization tier.
   *
   * WHEN INCIDENT OR SAFESPORT CONTENT IS BUILT (capability L26), IT MUST NOT
   * REUSE THIS FLAG. shadowRoleSets.ts is explicit that Omega must never
   * reach SafeSport content in any organization, so that surface needs its
   * own capability, denied to platform_owner, in the way
   * canAccessProtectedHealthInformation already denies clinical state.
   */
  canReviewChatSafetyTelemetry: boolean;
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
    canAccessProtectedHealthInformation: SHADOW_PHI_ROLES.includes(role),
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
    canReviewChatSafetyTelemetry: master,
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
