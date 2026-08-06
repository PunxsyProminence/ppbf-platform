/**
 * The one safety gate every gym starts with.
 *
 * Exists twice on purpose, mirroring complianceRuleSeeds.ts's reasoning
 * exactly: `infra/azure/pilot_slice_postgres_safety_gate_matrix_migration.sql`
 * seeds every organization that already exists when an operator runs the
 * migration; this module seeds an organization created after that, at the
 * moment it is created. A migration cannot do the second job -- it runs
 * when an operator runs it, not when a platform owner adds a gym.
 *
 * `safetyGateSeedsOwnership.test.ts` parses the migration and fails if the
 * two ever disagree, so a gate added to one and not the other is a red
 * build rather than a gym whose safety monitoring silently stays at one
 * gate forever.
 *
 * Gate ids are deterministic and match the migration's construction exactly
 * (`gate_<organizationId>_<gate_key>`), so the same gym seeded by either
 * path lands on the same row rather than a duplicate.
 */
import type { PoolClient } from 'pg';

import { withTransaction } from './db';

export type SafetyGateEnforcement = 'block' | 'flag';

export type SafetyGateSeed = {
  readonly gateKey: string;
  readonly name: string;
  readonly category: string;
  readonly enforcement: SafetyGateEnforcement;
  readonly requirementText: string;
};

export const DEFAULT_SAFETY_GATES: readonly SafetyGateSeed[] = [
  {
    gateKey: 'contact_medical_clearance',
    name: 'Contact Requires Medical Clearance',
    category: 'medical',
    enforcement: 'flag',
    requirementText:
      "This athlete needs an explicit 'cleared' medical administrative status on file before taking contact. "
      + "Set status to 'cleared' in the Medical Status panel once a clearance decision has been made; the "
      + 'observation is kept either way, and contact logged without a current clearance raises a near miss for '
      + 'coach/admin review.',
  },
] as const;

export function safetyGateSeedId(seed: SafetyGateSeed, organizationId: string): string {
  return `gate_${organizationId}_${seed.gateKey}`;
}

/**
 * Insert any of the defaults this organization does not already have.
 *
 * Idempotent by gate_key within the organization, matching the migration's
 * guard, so running it against a gym the migration already seeded is a
 * no-op rather than a duplicate or a conflict.
 *
 * Accepts an existing client so a caller can make seeding part of the same
 * transaction that creates the organization -- a gym should not be able to
 * exist with contact observations flowing in and no gate registered to
 * evaluate them against.
 */
export async function seedDefaultSafetyGates(
  organizationId: string,
  client?: PoolClient,
): Promise<void> {
  const run = async (execute: (text: string, values: unknown[]) => Promise<unknown>) => {
    for (const seed of DEFAULT_SAFETY_GATES) {
      await execute(
        `insert into pilot.safety_gates (
           organization_id, gate_id, gate_key, name, category, enforcement, requirement_text, active_flag
         )
         select $1, $2, $3, $4, $5, $6, $7, true
         where not exists (
           select 1 from pilot.safety_gates
           where organization_id = $1 and gate_key = $3
         )
         on conflict do nothing`,
        [
          organizationId,
          safetyGateSeedId(seed, organizationId),
          seed.gateKey,
          seed.name,
          seed.category,
          seed.enforcement,
          seed.requirementText,
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
