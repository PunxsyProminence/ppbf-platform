import type { DbClient, ImportActor } from './actor';

// THE HISTORY LEDGER, pilot.reference_content_revisions (content-import
// migration (4)). R2 says a changed item gets a new version and the old one is
// kept. Disciplines and competence levels are foreign-key TARGETS by their
// natural key, and cohort definitions have no version columns, so their live
// row is updated in place and the ledger is where the versions live: one row
// per item per version, append-only by trigger.
//
// VERSION NUMBERING, and why "before" is sometimes written:
//   new item                  -> v(head + 1), which is v1 unless the key has
//                                history (a row once removed by hand)
//   changed item, no history  -> v1 = the database row BEFORE the change, then
//                                v2 = after. Every row loaded by the old
//                                loaders has no ledger rows; without v1 the
//                                first revision would erase the only record of
//                                what the row said.
//   changed item, history whose latest content equals the database row
//                             -> v(head + 1) = after
//   changed item, history whose latest content DIFFERS from the database row
//                             -> v(head + 1) = the row as it stands (it was
//                                edited outside the importer), then
//                                v(head + 2) = after. The ledger then never
//                                skips a state the row actually held.
//
// content is the canonical content record the plan compared (canonical.ts:
// content columns only, as text), and content_sha256 is the unit hash the plan
// compared, so a ledger row and a plan line agree by construction.

export interface LedgerHead {
  version: number;
  contentSha256: string;
}

export async function ledgerHeads(
  client: DbClient,
  organizationId: string,
  dataset: string,
  itemKeys: readonly string[],
): Promise<Map<string, LedgerHead>> {
  if (itemKeys.length === 0) return new Map();
  const { rows } = await client.query<{ item_key: string; version: number; content_sha256: string }>(
    `select distinct on (item_key) item_key, version, content_sha256
       from pilot.reference_content_revisions
      where organization_id = $1 and dataset = $2 and item_key = any($3::text[])
      order by item_key, version desc`,
    [organizationId, dataset, [...itemKeys]],
  );
  return new Map(rows.map((row) => [row.item_key, { version: row.version, contentSha256: row.content_sha256 }]));
}

export interface LedgerVersionPlan {
  /** The database content is (or becomes) recorded as this version; undefined for a new item. */
  fromVersion?: number;
  /** Written only when the database content has no ledger row equal to it yet. */
  recordBefore: boolean;
  /** The version this import records the file content as. */
  toVersion: number;
}

export function planLedgerVersions(head: LedgerHead | undefined, databaseSha: string | undefined): LedgerVersionPlan {
  if (databaseSha === undefined) {
    return { recordBefore: false, toVersion: (head?.version ?? 0) + 1 };
  }
  if (!head) return { fromVersion: 1, recordBefore: true, toVersion: 2 };
  if (head.contentSha256 === databaseSha) return { fromVersion: head.version, recordBefore: false, toVersion: head.version + 1 };
  return { fromVersion: head.version + 1, recordBefore: true, toVersion: head.version + 2 };
}

export interface LedgerEntry {
  organizationId: string;
  dataset: string;
  itemKey: string;
  version: number;
  content: Record<string, string>;
  contentSha256: string;
  importId: string;
  actor: ImportActor;
}

export async function appendLedgerRow(client: DbClient, entry: LedgerEntry): Promise<void> {
  await client.query(
    `insert into pilot.reference_content_revisions
       (organization_id, dataset, item_key, version, content, content_sha256, import_id,
        recorded_by_account_id, recorded_by_role)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      entry.organizationId,
      entry.dataset,
      entry.itemKey,
      entry.version,
      JSON.stringify(entry.content),
      entry.contentSha256,
      entry.importId,
      entry.actor.accountId,
      entry.actor.role,
    ],
  );
}
