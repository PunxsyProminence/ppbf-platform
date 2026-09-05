/**
 * The four default staff-credential clearance types every gym starts with.
 *
 * Exists twice on purpose, mirroring complianceRuleSeeds.ts's and
 * safetyGateSeeds.ts's reasoning exactly:
 * `infra/azure/pilot_slice_postgres_clearance_type_seeds_migration.sql`
 * seeds every organization that already exists when an operator runs the
 * migration; this module seeds an organization created after that, at the
 * moment it is created. A migration cannot do the second job -- it runs
 * when an operator runs it, not when a platform owner adds a gym.
 *
 * `clearanceTypeSeedsOwnership.test.ts` parses the migration and fails if
 * the two ever disagree, so a type added to one and not the other is a red
 * build rather than a gym whose staff-credentials register silently starts
 * with nothing to register a document against.
 *
 * clearance_type_id is deterministic and matches the migration's
 * construction exactly (`<idPrefix><organizationId>`), so the same gym
 * seeded by either path lands on the same row rather than a duplicate.
 */
import type { PoolClient } from 'pg';

import type { ClearanceAuthorityKind } from './clearanceRegister';
import { withTransaction } from './db';

export type ClearanceTypeSeed = {
  readonly idPrefix: string;
  readonly name: string;
  readonly issuingAuthority: string;
  readonly authorityKind: ClearanceAuthorityKind;
  readonly validityMonths: number;
  readonly renewalGraceDays: number;
};

export const DEFAULT_CLEARANCE_TYPES: readonly ClearanceTypeSeed[] = [
  {
    idPrefix: 'ct_safesport_',
    name: 'SafeSport Training',
    issuingAuthority: 'U.S. Center for SafeSport',
    authorityKind: 'governing_body',
    validityMonths: 12,
    renewalGraceDays: 30,
  },
  {
    idPrefix: 'ct_usaboxing_coach_',
    name: 'USA Boxing Coach Certification',
    issuingAuthority: 'USA Boxing',
    authorityKind: 'governing_body',
    validityMonths: 12,
    renewalGraceDays: 30,
  },
  {
    idPrefix: 'ct_background_check_',
    name: 'Background Check',
    issuingAuthority: 'PA Dept of Human Services',
    authorityKind: 'state_statutory',
    validityMonths: 60,
    renewalGraceDays: 60,
  },
  {
    idPrefix: 'ct_cpr_first_aid_',
    name: 'CPR/First Aid',
    issuingAuthority: 'American Red Cross',
    authorityKind: 'governing_body',
    validityMonths: 24,
    renewalGraceDays: 30,
  },
] as const;

export function clearanceTypeSeedId(seed: ClearanceTypeSeed, organizationId: string): string {
  return `${seed.idPrefix}${organizationId}`;
}

/**
 * Insert any of the four defaults this organization does not already have.
 *
 * Idempotent by name within the organization, matching the migration's
 * guard, so running it against a gym the migration already seeded is a
 * no-op rather than a duplicate or a conflict.
 *
 * Accepts an existing client so a caller can make seeding part of the same
 * transaction that creates the organization -- a gym should not be able to
 * exist with a staff-credentials register that has nothing in it to
 * register a document against.
 */
export async function seedDefaultClearanceTypes(
  organizationId: string,
  client?: PoolClient,
): Promise<void> {
  const run = async (execute: (text: string, values: unknown[]) => Promise<unknown>) => {
    for (const seed of DEFAULT_CLEARANCE_TYPES) {
      await execute(
        `insert into pilot.clearance_types (
           organization_id, clearance_type_id, name, issuing_authority, authority_kind,
           validity_months, renewal_grace_days, active
         )
         select $1, $2, $3, $4, $5, $6, $7, true
         where not exists (
           select 1 from pilot.clearance_types
           where organization_id = $1 and name = $3
         )
         on conflict do nothing`,
        [
          organizationId,
          clearanceTypeSeedId(seed, organizationId),
          seed.name,
          seed.issuingAuthority,
          seed.authorityKind,
          seed.validityMonths,
          seed.renewalGraceDays,
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
