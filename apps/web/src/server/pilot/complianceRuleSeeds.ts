/**
 * The five compliance rules every gym starts with.
 *
 * These exist twice on purpose, and the duplication is guarded rather than
 * tolerated. `infra/azure/pilot_slice_postgres_compliance_rule_seeds_migration.sql`
 * seeds every organization that already exists when an operator runs the
 * migration; this module seeds an organization created after that, at the moment
 * it is created. A migration cannot do the second job -- it runs when an operator
 * runs it, not when a platform owner adds a gym -- and application code should not
 * be the only source of schema-time seeds for environments rebuilt from scratch.
 *
 * `complianceRuleSeedsOwnership.test.ts` parses the migration and fails if the two
 * ever disagree, so a rule added to one and not the other is a red build rather
 * than a gym whose compliance monitoring quietly watches for four things.
 *
 * Rule ids are deterministic and match the migration's construction exactly
 * (`rule_<prefix>_<organizationId>_<suffix>`), so the same gym seeded by either
 * path lands on the same row rather than a duplicate.
 */
import type { PoolClient } from 'pg';

import { withTransaction } from './db';

export type ComplianceRuleSeed = {
  readonly idPrefix: string;
  readonly idSuffix: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly detectionLogic: string;
  readonly severity: string;
  readonly escalationLevel: string;
};

export const DEFAULT_COMPLIANCE_RULES: readonly ComplianceRuleSeed[] = [
  {
    idPrefix: 'rule_safety_',
    idSuffix: '_physical_injury',
    name: 'Physical Injury Prevention',
    category: 'safety',
    description: 'Prevents unsafe techniques and movements that could result in physical injury',
    detectionLogic: 'Monitor for high-impact movements, improper form, equipment misuse',
    severity: 'critical',
    escalationLevel: 'admin',
  },
  {
    idPrefix: 'rule_technique_',
    idSuffix: '_form_standards',
    name: 'Proper Technique & Form',
    category: 'technique',
    description: 'Ensures athletes maintain proper form and technique during training',
    detectionLogic: 'Verify stance, grip, positioning, and movement patterns match standards',
    severity: 'high',
    escalationLevel: 'coach',
  },
  {
    idPrefix: 'rule_protocol_',
    idSuffix: '_attendance',
    name: 'Training Protocol Compliance',
    category: 'protocol',
    description: 'Enforces attendance requirements, equipment readiness, and training protocols',
    detectionLogic: 'Track attendance, equipment checks, session prep completion',
    severity: 'high',
    escalationLevel: 'coach',
  },
  {
    idPrefix: 'rule_medical_',
    idSuffix: '_clearance',
    name: 'Medical Clearance Status',
    category: 'medical',
    description: 'Ensures athletes have current medical clearance and health documentation',
    detectionLogic: 'Verify medical forms signed, physician clearance current, emergency contacts on file',
    severity: 'critical',
    escalationLevel: 'admin',
  },
  {
    idPrefix: 'rule_behavioral_',
    idSuffix: '_conduct',
    name: 'Code of Conduct',
    category: 'behavioral',
    description: 'Maintains organizational standards for athlete conduct and respect',
    detectionLogic: 'Monitor respect to coaches/teammates, sportsmanship, team values adherence',
    severity: 'medium',
    escalationLevel: 'coach',
  },
] as const;

export function complianceRuleSeedId(seed: ComplianceRuleSeed, organizationId: string): string {
  return `${seed.idPrefix}${organizationId}${seed.idSuffix}`;
}

/**
 * Insert any of the five defaults this organization does not already have.
 *
 * Idempotent by rule_name within the organization, matching the migration's
 * guard, so running it against a gym the migration already seeded is a no-op
 * rather than a duplicate or a conflict.
 *
 * Accepts an existing client so a caller can make seeding part of the same
 * transaction that creates the organization -- a gym should not be able to exist
 * with compliance monitoring that references nothing.
 */
export async function seedDefaultComplianceRules(
  organizationId: string,
  client?: PoolClient,
): Promise<void> {
  const run = async (execute: (text: string, values: unknown[]) => Promise<unknown>) => {
    for (const seed of DEFAULT_COMPLIANCE_RULES) {
      await execute(
        `insert into pilot.compliance_rules (
           rule_id, organization_id, rule_name, rule_category,
           description, detection_logic, severity, escalation_level, active_flag
         )
         select $1, $2, $3, $4, $5, $6, $7, $8, true
         where not exists (
           select 1 from pilot.compliance_rules
           where organization_id = $2 and rule_name = $3
         )
         on conflict do nothing`,
        [
          complianceRuleSeedId(seed, organizationId),
          organizationId,
          seed.name,
          seed.category,
          seed.description,
          seed.detectionLogic,
          seed.severity,
          seed.escalationLevel,
        ],
      );
    }
  };

  if (client) {
    await run((text, values) => client.query(text, values));
    return;
  }

  await withTransaction(async (transactionClient) => {
    await run((text, values) => transactionClient.query(text, values));
  });
}
