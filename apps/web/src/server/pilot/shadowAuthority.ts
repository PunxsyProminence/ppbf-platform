import type { ActorIdentity } from './access';
import { query } from './db';

export type ShadowAutomationMode = 'automatic' | 'assisted' | 'manual';

/**
 * The closed vocabulary, as data rather than as a type.
 *
 * `ShadowAutomationMode` is erased at runtime, so every route that took
 * automation_mode off a request body and cast it to that type was asserting
 * something nothing checked. It matters here more than in most places because
 * every automation refusal in decideShadowAuthority below compares for EXACT
 * equality with 'automatic' -- so "Automatic", "AUTOMATIC" or "automatic "
 * skipped all of them and were recorded as a check that passed. Exported so
 * the callers validate against the same list the decider compares against,
 * rather than each writing their own copy and drifting from it.
 */
export const SHADOW_AUTOMATION_MODES: readonly ShadowAutomationMode[] = ['automatic', 'assisted', 'manual'];

export function isShadowAutomationMode(value: unknown): value is ShadowAutomationMode {
  return typeof value === 'string' && (SHADOW_AUTOMATION_MODES as readonly string[]).includes(value);
}

export type ShadowConfidenceTier =
  | 'SUFFICIENT_FOR_LOW_RISK_ACTION'
  | 'SUFFICIENT_FOR_REVIEW'
  | 'LIMITED'
  | 'CONFLICTED'
  | 'INSUFFICIENT'
  | 'NOT_APPLICABLE';

export interface ShadowAuthorityCheckInput {
  actor: ActorIdentity;
  organizationId: string;
  action: string;
  automationMode: ShadowAutomationMode;
  confidenceTier: ShadowConfidenceTier;
  sourceConfidenceTier?: ShadowConfidenceTier;
  sourceVerificationState?: 'verified' | 'partially_verified' | 'unverified' | 'unknown';
  lowRisk: boolean;
  reversible: boolean;
  withinApprovedOptions: boolean;
  restrictionConflict: boolean;
  metadata?: Record<string, unknown>;
}

interface ShadowAuthorityDecision {
  allowed: boolean;
  reason: string;
}

function isForbiddenAutomaticClearanceAction(action: string): boolean {
  const normalized = action.toLowerCase();
  return (
    normalized.includes('clear')
    || normalized.includes('concussion')
    || normalized.includes('sparring')
    || normalized.includes('weight_cut')
    || normalized.includes('medical_decision')
  );
}

function decideShadowAuthority(input: ShadowAuthorityCheckInput): ShadowAuthorityDecision {
  // Checked FIRST, and it fails closed.
  //
  // Every automation refusal below compares `automationMode === 'automatic'`.
  // A value outside the vocabulary therefore matched none of them and was read
  // as a non-automatic actor -- which is the opposite of what an unrecognised
  // mode means. Nobody has reasoned about a mode nobody named, so the only
  // safe reading of one is refusal.
  //
  // The callers validate their own input too, so this is a backstop rather
  // than the primary gate: it exists so the NEXT call site cannot reintroduce
  // the gap by forgetting to check, which is exactly how the two intake routes
  // acquired it.
  if (!isShadowAutomationMode(input.automationMode)) {
    return { allowed: false, reason: 'Automation mode is not a recognised value.' };
  }

  if (input.automationMode === 'automatic' && isForbiddenAutomaticClearanceAction(input.action)) {
    return { allowed: false, reason: 'Automatic clearance and medical authority actions are prohibited.' };
  }

  if (input.restrictionConflict) {
    return { allowed: false, reason: 'Restriction conflict detected.' };
  }

  if (!input.withinApprovedOptions) {
    return { allowed: false, reason: 'Action is outside approved options.' };
  }

  if (input.automationMode === 'automatic' && !input.lowRisk) {
    return { allowed: false, reason: 'Automatic action must be low risk.' };
  }

  if (input.automationMode === 'automatic' && !input.reversible) {
    return { allowed: false, reason: 'Automatic action must be reversible.' };
  }

  if (input.confidenceTier === 'INSUFFICIENT' || input.confidenceTier === 'CONFLICTED') {
    return { allowed: false, reason: 'Confidence tier is insufficient for requested action.' };
  }

  return { allowed: true, reason: 'Authority check passed.' };
}

export async function assertShadowAuthority(input: ShadowAuthorityCheckInput): Promise<void> {
  const decision = decideShadowAuthority(input);

  await query(
    `insert into pilot.shadow_authority_checks
     (organization_id, actor_account_id, actor_role, action, automation_mode, confidence_tier, source_confidence_tier, source_verification_state, allowed, reason, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      input.organizationId,
      input.actor.accountId,
      input.actor.role,
      input.action,
      input.automationMode,
      input.confidenceTier,
      input.sourceConfidenceTier ?? null,
      input.sourceVerificationState ?? null,
      decision.allowed,
      decision.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  if (!decision.allowed) {
    throw new Error(`SHADOW authority denied: ${decision.reason}`);
  }
}
