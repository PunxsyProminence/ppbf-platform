import type { PilotRole } from './contracts';

export type ShadowSessionType =
  | 'quick_round'
  | 'heavy_bag'
  | 'film_study'
  | 'scout_report'
  | 'board_summary'
  | 'recovery_round';

export interface ShadowChatCapabilities {
  mode: 'master' | 'scoped';
  allowedSessionTypes: ShadowSessionType[];
  canUseManualTier: boolean;
  canViewEvidence: boolean;
  canManageSessions: boolean;
  canExportOwnData: boolean;
  canRequestDeletion: boolean;
  canReviewSafetyEvents: boolean;
}

const ALL_SESSIONS: ShadowSessionType[] = [
  'quick_round',
  'heavy_bag',
  'film_study',
  'scout_report',
  'board_summary',
  'recovery_round',
];

export function getShadowChatCapabilities(role: PilotRole): ShadowChatCapabilities {
  const admin = role === 'admin' || role === 'organization_admin' || role === 'platform_owner';
  const coach = role === 'coach';
  const canOverride = admin || coach;

  return {
    mode: admin ? 'master' : 'scoped',
    allowedSessionTypes: canOverride ? ALL_SESSIONS : ['quick_round', 'recovery_round'],
    canUseManualTier: canOverride,
    canViewEvidence: role !== 'volunteer',
    canManageSessions: true,
    canExportOwnData: true,
    canRequestDeletion: true,
    canReviewSafetyEvents: admin,
  };
}

export function canUseShadowSessionType(role: PilotRole, sessionType: string): sessionType is ShadowSessionType {
  return getShadowChatCapabilities(role).allowedSessionTypes.includes(sessionType as ShadowSessionType);
}
