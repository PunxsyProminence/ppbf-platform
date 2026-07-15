import type { ActorIdentity } from './access';
import { query } from './db';

export type ShadowAutomationMode = 'automatic' | 'assisted' | 'manual';

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

let ensured = false;

async function ensureShadowAuthorityTable(): Promise<void> {
  if (ensured) {
    return;
  }

  await query(
    `create table if not exists pilot.shadow_authority_checks (
      authority_check_id bigserial primary key,
      organization_id text not null,
      actor_account_id text null,
      actor_role text null,
      action text not null,
      automation_mode text not null,
      confidence_tier text not null,
      allowed boolean not null,
      reason text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )`,
  );

  await query(
    `create index if not exists idx_shadow_authority_checks_org_created
     on pilot.shadow_authority_checks(organization_id, created_at desc)`,
  );

  ensured = true;
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

  await ensureShadowAuthorityTable();
  await query(
    `insert into pilot.shadow_authority_checks
     (organization_id, actor_account_id, actor_role, action, automation_mode, confidence_tier, allowed, reason, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      input.organizationId,
      input.actor.accountId,
      input.actor.role,
      input.action,
      input.automationMode,
      input.confidenceTier,
      decision.allowed,
      decision.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  if (!decision.allowed) {
    throw new Error(`SHADOW authority denied: ${decision.reason}`);
  }
}
