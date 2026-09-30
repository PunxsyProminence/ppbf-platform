import { randomUUID } from 'node:crypto';

import { assertImportActor } from './actor';
import { type ContentImportAuditRecord, insertContentImportAuditRow } from './auditRow';
import { DATASET_ENGINES, datasetEngine, type DatasetWriteResult } from './datasets';
import { type ImportPlan, type ImportRequest, packageInputs, planWithState } from './plan';
import { ContentImportRefusal } from './refusal';
import type { DatasetName } from './types';
import { parsePackage } from './validate';

// STAGE 4 OF THE CONTENT-IMPORT CORE: APPLY, INSIDE THE CALLER'S TRANSACTION.
//
// The caller opens the transaction, calls this, and COMMITs only if it
// returned -- on any throw it ROLLs BACK. That is the whole atomicity story,
// and it is the caller's on purpose: the seed CLI commits (or, for --dry-run,
// rolls back), the later upload route runs this inside withTransaction
// (db.ts:173-192). The old loaders put COMMIT in a `finally`, so a JavaScript
// error after the first insert committed that insert
// (seed-competence-cohorts.mjs:246-290 explains the regression that proved
// it; seed-disciplines.mjs:208-213 still has the shape).
//
// NOT IN A TRANSACTION IS REFUSED. The first statement is a SAVEPOINT, which
// Postgres refuses outside a transaction block (SQLSTATE 25P01). Without this,
// a caller that forgot BEGIN would autocommit every statement and a failure
// half-way through would leave half a load behind -- the exact failure above.
//
// THE ORDER, and why:
//   1. the actor is checked again, inside the transaction
//   2. a transaction-scoped advisory lock per organization, so two imports
//      into one gym run one after the other (the ledger's version numbers and
//      "does this key exist yet" both depend on nobody else writing)
//   3. SELECT ... FOR UPDATE on every existing row the package names, so an
//      edit from the app cannot land between the re-plan and the write
//   4. PLAN AGAIN against what is now committed and held, and refuse if the
//      plan hash differs from the one the person approved (STALE_PLAN) or if
//      anything blocks (PLAN_BLOCKED)
//   5. write, dataset by dataset in dependency order
//   6. one pilot.audit_events row, on the same client (auditRow.ts)
// A plan with nothing to write writes NOTHING -- no ledger row, no audit row:
// R2 "unchanged -> skipped" means a re-import of the same files leaves the
// database exactly as it was.

const SAVEPOINT = 'content_import_apply';

export interface ApplyRequest extends ImportRequest {
  /** The plan_hash of the plan the person was shown. */
  expectedPlanHash: string;
}

export interface ApplyResult {
  /** The plan as re-made under lock; its planHash equals expectedPlanHash. */
  plan: ImportPlan;
  /** null when the plan had nothing to write. */
  importId: string | null;
  auditId: string | null;
  /** What the audit row recorded; pass it to emitContentImportAuditMirror after COMMIT. */
  audit: ContentImportAuditRecord | null;
  written: Partial<Record<DatasetName, DatasetWriteResult>>;
  ledgerRows: number;
}

async function openSavepoint(request: ApplyRequest): Promise<void> {
  try {
    await request.client.query(`savepoint ${SAVEPOINT}`);
  } catch (error) {
    if ((error as { code?: string }).code === '25P01') {
      throw new ContentImportRefusal(
        'NOT_IN_TRANSACTION',
        'apply must run inside the caller\'s open transaction (BEGIN first, COMMIT only if apply returns)',
      );
    }
    throw error;
  }
}

export async function applyImport(request: ApplyRequest): Promise<ApplyResult> {
  const { client, organizationId } = request;
  await openSavepoint(request);

  const actor = await assertImportActor(client, organizationId, request.actorAccountId);
  const context = { client, organizationId, actor };

  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`ppbf.content-import:${organizationId}`]);

  // A child file names its item through its parent column, and counts: a
  // package carrying only a drill's cues still revises that drill, copying its
  // other child rows from a read. Holding the head FOR UPDATE makes a child
  // insert onto it from elsewhere (its foreign-key check takes FOR KEY SHARE)
  // either finish before the re-plan, which then sees it, or wait for COMMIT.
  const { parsed } = parsePackage(packageInputs(request.files));
  for (const engine of DATASET_ENGINES) {
    // A child row names its item by its parent column: a package of template
    // items alone still writes a new version of the template they name
    // (datasets/templateScriptVersions.ts, "ONE UNIT"), so that row is held too.
    const keys = parsed.files
      .filter((file) => file.spec.dataset === engine.spec.name)
      .flatMap((file) => file.rows.map((row) => row.values[file.spec.parent?.column ?? file.spec.key[0]]));
    if (keys.length > 0) await engine.lockKeys(context, keys);
  }

  const { plan, datasetPlans } = await planWithState(request, actor);
  if (plan.blocking.length > 0) {
    throw new ContentImportRefusal(
      'PLAN_BLOCKED',
      `${plan.blocking.length} blocking finding(s); nothing was written. First: [${plan.blocking[0].code}] ${plan.blocking[0].file}: ${plan.blocking[0].message}`,
    );
  }
  if (plan.planHash !== request.expectedPlanHash) {
    throw new ContentImportRefusal(
      'STALE_PLAN',
      `the database changed after the plan was made (plan ${request.expectedPlanHash.slice(0, 12)}, now ${plan.planHash.slice(0, 12)}); nothing was written. Plan again and review the new plan.`,
    );
  }

  const written: Partial<Record<DatasetName, DatasetWriteResult>> = {};
  if (plan.changes === 0) {
    await client.query(`release savepoint ${SAVEPOINT}`);
    return { plan, importId: null, auditId: null, audit: null, written, ledgerRows: 0 };
  }

  const importId = `imp_${randomUUID()}`;
  let ledgerRows = 0;
  for (const datasetPlan of datasetPlans) {
    const engine = datasetEngine(datasetPlan.dataset);
    if (!engine) throw new Error(`content-import: no engine for ${datasetPlan.dataset}`);
    const result = await engine.apply(context, datasetPlan, { importId });
    written[datasetPlan.dataset] = result;
    ledgerRows += result.ledgerRows;
  }

  const audit: ContentImportAuditRecord = {
    importId,
    organizationId,
    actor,
    details: {
      import_id: importId,
      plan_hash: plan.planHash,
      datasets: plan.datasets,
      counts: plan.counts,
      inserted: Object.fromEntries(Object.entries(written).map(([name, result]) => [name, result?.inserted ?? []])),
      updated: Object.fromEntries(Object.entries(written).map(([name, result]) => [name, result?.updated ?? []])),
      ledger_rows: ledgerRows,
    },
  };
  const auditId = await insertContentImportAuditRow(client, audit);

  await client.query(`release savepoint ${SAVEPOINT}`);
  return { plan, importId, auditId, audit, written, ledgerRows };
}
