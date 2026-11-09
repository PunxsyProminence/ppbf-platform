#!/usr/bin/env node

/**
 * Deletes the research-requirement rows that athlete intake uploads wrote
 * before PR #1122 (2026-10-03), and nothing else.
 *
 * WHY THIS EXISTS
 *
 * Until #1122 every /api/pilot/shadow/upload call also wrote one
 * pilot.shadow_research_requirements row whose text carried the uploaded
 * file's name -- often the child's name, as the admin saved the form -- and
 * that table is listed on /research to every organization role. #1122 stopped
 * new rows and touched none. Jason ruled:
 *   OD-2026-10-02-015 D4   athlete intake files stay out of research;
 *   OD-2026-10-03-002 s.1  "Delete them all": every such row is deleted, after
 *                          a read-only count, with his word for the run.
 *
 * WHICH ROWS, EXACTLY
 *
 * The tag the removed insert wrote, both columns, never a text match:
 *   source_event_name  = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED'
 *   source_entity_type = 'shadow_intake'
 * (git show 40df6e742 -- apps/web/app/api/pilot/shadow/upload/route.ts). No
 * other writer ever used that pair. Open AND resolved rows are deleted (the
 * ruling names no exception); the dry run reports the split so Jason can rule
 * otherwise before a run.
 *
 * Scope is an explicit argument, never a default:
 *   --organization <id>     that organization only (it must exist)
 *   --all-organizations     every organization
 * Neither, both, or anything else on the command line is refused.
 *
 * pilot.shadow_research_submissions references a requirement ON DELETE
 * CASCADE. A submission linked to a deleted row is deleted FIRST, by its own
 * statement, so its count is earned rather than cascaded uncounted -- the way
 * the retention cleanup deletes a purged child's research rows
 * (pilot-cleanup-deleted-data.mjs, F-079). The dry run lists them.
 *
 * WHAT IT PRINTS
 *
 * Ids, counts, organizations, statuses, the created_at range and the plan
 * fingerprint. NEVER research_requirement, knowledge_gap, metadata, subject_id
 * or a submission's provenance or note: they can hold a child's file name.
 * Not even selected: the SQL below reads no text column.
 *
 *   TARGET GUARD    PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE must match
 *                   AZURE_POSTGRES_CONNECTION_STRING
 *                   (scripts/lib/postgres-write-target.mjs), checked before a
 *                   client is created.
 *   READ-ONLY BY    A plain run opens `begin transaction read only`, prints the
 *   DEFAULT         plan and its plan_fingerprint, and rolls back.
 *   REVIEWED PLAN   Apply needs PPBF_INTAKE_RR_CLEANUP_APPLY=true, the phrase
 *   ONLY            in PPBF_INTAKE_RR_CLEANUP_CONFIRM, and
 *                   PPBF_INTAKE_RR_CLEANUP_EXPECT_FINGERPRINT set to the
 *                   plan_fingerprint of the dry run that was reviewed. The
 *                   fingerprint is sha256 over the scope, the tag, every
 *                   planned requirement (id, organization, status) and every
 *                   linked submission (organization, id, requirement id), all
 *                   sorted -- so a row added, removed, re-scoped or flipped
 *                   between open and resolved since the review refuses the
 *                   apply before its first delete.
 *   ONE TRANSACTION Plans with the rows locked (FOR UPDATE, lock_timeout),
 *                   checks the fingerprint, deletes, checks each DELETE removed
 *                   exactly the planned rows and the tag is empty in scope,
 *                   writes one pilot.audit_events row per organization, and
 *                   only then commits.
 *
 * AUDIT. event_type 'data_purged' -- the vocabulary value the retention
 * cleanup writes for a permanent delete; 'shadow_research_upload_requirement'
 * records a creation and has no writer since #1122. One row in each affected
 * organization (that is the trail its admins read), entity_type
 * 'intake_research_requirement_cleanup', details holding the fingerprint,
 * counts and ids only.
 *
 * It never reads a local env file: the connection string must come from the
 * environment, which in practice means the cleanup-intake-research-requirements
 * workflow.
 *
 * Usage (from the workflow):
 *   npm run pilot:cleanup-intake-research-requirements -- --all-organizations
 *   PPBF_INTAKE_RR_CLEANUP_APPLY=true \
 *     PPBF_INTAKE_RR_CLEANUP_CONFIRM='DELETE INTAKE RESEARCH REQUIREMENTS' \
 *     PPBF_INTAKE_RR_CLEANUP_EXPECT_FINGERPRINT='sha256:<from the dry run>' \
 *     npm run pilot:cleanup-intake-research-requirements -- --organization <id>
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const SOURCE_EVENT_NAME = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED';
export const SOURCE_ENTITY_TYPE = 'shadow_intake';
export const CONFIRM_PHRASE = 'DELETE INTAKE RESEARCH REQUIREMENTS';
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const AUDIT_EVENT_TYPE = 'data_purged';
export const AUDIT_ENTITY_TYPE = 'intake_research_requirement_cleanup';
const EVENT_PREFIX = 'research.intake_requirement_cleanup';
const RULINGS = 'OD-2026-10-02-015 D4 ("Athlete intake files stay out of research"); OD-2026-10-03-002 section 1 ("Delete them all")';

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `${EVENT_PREFIX}.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

const byBigInt = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure input checks. Returns null when the options are usable, otherwise
 * `{ reason }`. Runs before any database statement.
 */
export function validateCleanupOptions(options) {
  const { apply, confirm, expectFingerprint, organizationId, allOrganizations } = options ?? {};
  // Only real booleans decide the mode and the scope.
  if (apply !== undefined && typeof apply !== 'boolean') return { reason: 'INVALID_APPLY' };
  if (allOrganizations !== undefined && typeof allOrganizations !== 'boolean') return { reason: 'INVALID_ALL_ORGANIZATIONS' };
  const hasOrganization = organizationId !== undefined && organizationId !== null;
  if (hasOrganization && (typeof organizationId !== 'string' || organizationId.trim() === '' || organizationId !== organizationId.trim())) {
    return { reason: 'INVALID_ORGANIZATION' };
  }
  if (hasOrganization && allOrganizations === true) return { reason: 'ORGANIZATION_SCOPE_AMBIGUOUS' };
  if (!hasOrganization && allOrganizations !== true) return { reason: 'ORGANIZATION_SCOPE_REQUIRED' };
  if (apply === true && confirm !== CONFIRM_PHRASE) return { reason: 'APPLY_WITHOUT_CONFIRM_PHRASE' };
  if (apply === true && !expectFingerprint) return { reason: 'APPLY_WITHOUT_EXPECTED_FINGERPRINT' };
  if (apply === true && !FINGERPRINT_PATTERN.test(String(expectFingerprint))) {
    return { reason: 'INVALID_EXPECTED_FINGERPRINT' };
  }
  return null;
}

/**
 * Reads the scope from the command line and the mode from the
 * PPBF_INTAKE_RR_CLEANUP_* environment, then validates them.
 */
export function parseCleanupOptions(env = process.env, argv = process.argv.slice(2)) {
  let organizationId;
  let allOrganizations = false;
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--all-organizations') {
      if (allOrganizations) return { ok: false, refusal: { reason: 'ORGANIZATION_SCOPE_AMBIGUOUS' } };
      allOrganizations = true;
    } else if (arg === '--organization') {
      if (organizationId !== undefined) return { ok: false, refusal: { reason: 'ORGANIZATION_SCOPE_AMBIGUOUS' } };
      const value = args.shift();
      if (value === undefined || value.startsWith('--')) return { ok: false, refusal: { reason: 'INVALID_ORGANIZATION' } };
      organizationId = value;
    } else {
      // Not echoed: an argument is operator input, and the refusal is printed.
      return { ok: false, refusal: { reason: 'UNKNOWN_ARGUMENT' } };
    }
  }
  const options = {
    // Exactly 'true'. Anything else, including 'TRUE' or '1', is a dry run.
    apply: env.PPBF_INTAKE_RR_CLEANUP_APPLY === 'true',
    confirm: env.PPBF_INTAKE_RR_CLEANUP_CONFIRM ?? '',
    expectFingerprint: (env.PPBF_INTAKE_RR_CLEANUP_EXPECT_FINGERPRINT ?? '').trim(),
    organizationId,
    allOrganizations,
  };
  const refusal = validateCleanupOptions(options);
  return refusal ? { ok: false, refusal } : { ok: true, options };
}

function scopeOf(options) {
  return options.allOrganizations === true ? { all_organizations: true } : { organization_id: options.organizationId };
}

/**
 * The plan: every tagged row in scope and every submission linked to one.
 * Selects ids, organizations, statuses and timestamps only -- never a text
 * column. `lock` adds FOR UPDATE (apply only; a read-only transaction cannot
 * take row locks).
 */
export async function readCleanupPlan(client, options, { lock = false } = {}) {
  const forUpdate = lock ? ' for update' : '';
  const organizationId = options.allOrganizations === true ? null : options.organizationId;
  const requirements = (await client.query(
    `select research_requirement_id::text as research_requirement_id, organization_id, status,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from pilot.shadow_research_requirements
      where source_event_name = $1 and source_entity_type = $2
        and ($3::text is null or organization_id = $3)
      order by research_requirement_id${forUpdate}`,
    [SOURCE_EVENT_NAME, SOURCE_ENTITY_TYPE, organizationId],
  )).rows.sort((a, b) => byBigInt(a.research_requirement_id, b.research_requirement_id));
  const ids = requirements.map((row) => row.research_requirement_id);

  const hasSubmissions = (await client.query(
    "select to_regclass('pilot.shadow_research_submissions') is not null as present",
  )).rows[0]?.present === true;
  // Matched by requirement id alone, as the foreign key's cascade matches, so
  // none is removed uncounted.
  const submissions = !hasSubmissions || ids.length === 0 ? [] : (await client.query(
    `select organization_id, submission_id, research_requirement_id::text as research_requirement_id
       from pilot.shadow_research_submissions
      where research_requirement_id = any($1::bigint[])
      order by organization_id, submission_id${forUpdate}`,
    [ids],
  )).rows.sort((a, b) => byText(a.organization_id, b.organization_id) || byText(a.submission_id, b.submission_id));

  const tableTotal = Number((await client.query(
    'select count(*)::int as n from pilot.shadow_research_requirements',
  )).rows[0]?.n ?? 0);

  const byOrganization = new Map();
  for (const row of requirements) {
    const entry = byOrganization.get(row.organization_id) ?? { organization_id: row.organization_id, total: 0, open: 0, resolved: 0 };
    entry.total += 1;
    entry[row.status === 'resolved' ? 'resolved' : 'open'] += 1;
    byOrganization.set(row.organization_id, entry);
  }
  const created = requirements.map((row) => row.created_at).sort(byText);

  const fingerprintMaterial = JSON.stringify({
    tag: [SOURCE_EVENT_NAME, SOURCE_ENTITY_TYPE],
    scope: scopeOf(options),
    requirements: requirements.map((row) => [row.research_requirement_id, row.organization_id, row.status]),
    submissions: submissions.map((row) => [row.organization_id, row.submission_id, row.research_requirement_id]),
  });

  return {
    fingerprint: `sha256:${crypto.createHash('sha256').update(fingerprintMaterial).digest('hex')}`,
    requirements,
    requirementIds: ids,
    submissions,
    tableTotal,
    counts: {
      requirements: requirements.length,
      open: requirements.filter((row) => row.status !== 'resolved').length,
      resolved: requirements.filter((row) => row.status === 'resolved').length,
      linked_submissions: submissions.length,
    },
    byOrganization: [...byOrganization.values()].sort((a, b) => byText(a.organization_id, b.organization_id)),
    createdRange: created.length === 0 ? null : { earliest: created[0], latest: created[created.length - 1] },
  };
}

/**
 * The cleanup. `client` is anything with pg's `query(text, values)` shape; the
 * caller owns connecting and ending it.
 *
 * Returns one of:
 *   { status: 'refused', reason, ... }        nothing written
 *   { status: 'dry-run', ... }                nothing written
 *   { status: 'nothing-to-delete', ... }      apply found no tagged row; nothing written
 *   { status: 'applied', ... }                committed
 * and throws (after rolling back) on an unexpected database error.
 */
export async function cleanupIntakeResearchRequirements(client, options, { log = defaultLog } = {}) {
  const refusal = validateCleanupOptions(options);
  if (refusal) {
    log('refused', refusal);
    return { status: 'refused', ...refusal };
  }
  const apply = options.apply === true;
  const scope = scopeOf(options);
  let open = false;

  async function refuseInside(reason, detail = {}) {
    await client.query('rollback');
    open = false;
    log('refused', { reason, ...detail });
    return { status: 'refused', reason, ...detail };
  }

  try {
    await client.query(apply ? 'begin' : 'begin transaction read only');
    open = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");

    if (options.allOrganizations !== true) {
      const found = (await client.query(
        'select organization_id from pilot.organizations where organization_id = $1',
        [options.organizationId],
      )).rows;
      if (found.length !== 1) return await refuseInside('ORGANIZATION_NOT_FOUND');
    }

    const plan = await readCleanupPlan(client, options, { lock: apply });
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      scope,
      tag: { source_event_name: SOURCE_EVENT_NAME, source_entity_type: SOURCE_ENTITY_TYPE },
      plan_fingerprint: plan.fingerprint,
      counts: plan.counts,
      by_organization: plan.byOrganization,
      created_at_range: plan.createdRange,
      table_rows_total: plan.tableTotal,
      research_requirement_ids: plan.requirementIds,
      linked_submission_ids: plan.submissions.map((row) => ({
        organization_id: row.organization_id,
        submission_id: row.submission_id,
        research_requirement_id: row.research_requirement_id,
      })),
    };
    log('plan', report);

    if (!apply) {
      await client.query('rollback');
      open = false;
      log('dry-run', {
        plan_fingerprint: plan.fingerprint,
        counts: plan.counts,
        note: plan.counts.requirements === 0
          ? 'nothing to delete in this scope'
          : `apply needs mode=apply, the phrase ${CONFIRM_PHRASE}, the same scope, and expected_fingerprint set to this plan_fingerprint`,
      });
      return {
        status: 'dry-run',
        scope,
        plan_fingerprint: plan.fingerprint,
        counts: plan.counts,
        by_organization: plan.byOrganization,
        created_at_range: plan.createdRange,
        table_rows_total: plan.tableTotal,
        research_requirement_ids: plan.requirementIds,
      };
    }

    // The reviewed dry run is the plan Jason approved. Anything that changed
    // since then changes the fingerprint and stops here, before any delete.
    if (plan.fingerprint !== options.expectFingerprint) {
      return await refuseInside('PLAN_FINGERPRINT_MISMATCH', { expected: options.expectFingerprint, actual: plan.fingerprint });
    }
    if (plan.counts.requirements === 0) {
      await client.query('rollback');
      open = false;
      log('nothing-to-delete', { plan_fingerprint: plan.fingerprint, scope });
      return { status: 'nothing-to-delete', scope, plan_fingerprint: plan.fingerprint };
    }

    const submissionKeys = plan.submissions.map((row) => ({ organization_id: row.organization_id, submission_id: row.submission_id }));
    const submissionsDeleted = submissionKeys.length === 0 ? 0 : ((await client.query(
      `delete from pilot.shadow_research_submissions s
        using jsonb_to_recordset($1::jsonb) as x(organization_id text, submission_id text)
        where s.organization_id = x.organization_id and s.submission_id = x.submission_id
          and s.research_requirement_id = any($2::bigint[])`,
      [JSON.stringify(submissionKeys), plan.requirementIds],
    )).rowCount ?? 0);
    if (submissionsDeleted !== submissionKeys.length) {
      return await refuseInside('DELETE_COUNT_MISMATCH', { table: 'shadow_research_submissions', planned: submissionKeys.length, deleted: submissionsDeleted });
    }

    // The tag and the scope are restated on the delete itself, so a planned id
    // that somehow no longer carries the tag is not removed -- and the count
    // check catches it.
    const requirementsDeleted = (await client.query(
      `delete from pilot.shadow_research_requirements
        where research_requirement_id = any($1::bigint[])
          and source_event_name = $2 and source_entity_type = $3
          and ($4::text is null or organization_id = $4)`,
      [plan.requirementIds, SOURCE_EVENT_NAME, SOURCE_ENTITY_TYPE, options.allOrganizations === true ? null : options.organizationId],
    )).rowCount ?? 0;
    if (requirementsDeleted !== plan.requirementIds.length) {
      return await refuseInside('DELETE_COUNT_MISMATCH', { table: 'shadow_research_requirements', planned: plan.requirementIds.length, deleted: requirementsDeleted });
    }

    // End state, on the planned rows only: the app may write untagged rows
    // while this runs, so the whole-table count is reported, not checked.
    const after = await readCleanupPlan(client, options, { lock: false });
    const plannedLeft = Number((await client.query(
      'select count(*)::int as n from pilot.shadow_research_requirements where research_requirement_id = any($1::bigint[])',
      [plan.requirementIds],
    )).rows[0]?.n ?? 0);
    const mismatches = [];
    if (plannedLeft !== 0) mismatches.push(`planned_rows_left=${plannedLeft}`);
    if (after.counts.requirements !== 0) mismatches.push(`tagged_rows_left=${after.counts.requirements}`);
    if (mismatches.length > 0) return await refuseInside('END_STATE_MISMATCH', { mismatches });

    // Every organization that lost a row gets the record in its own trail,
    // including one whose submission was linked to another organization's
    // tagged row (nothing in the schema stops that link).
    const auditOrganizations = [...new Set([
      ...plan.byOrganization.map((entry) => entry.organization_id),
      ...plan.submissions.map((row) => row.organization_id),
    ])].sort(byText);
    for (const organizationId of auditOrganizations) {
      const organization = plan.byOrganization.find((entry) => entry.organization_id === organizationId)
        ?? { organization_id: organizationId, total: 0, open: 0, resolved: 0 };
      await client.query(
        `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
         values ($1, $2, $3, $2, $4::jsonb)`,
        [AUDIT_EVENT_TYPE, organization.organization_id, AUDIT_ENTITY_TYPE, JSON.stringify({
          plan_fingerprint: plan.fingerprint,
          scope,
          tag: { source_event_name: SOURCE_EVENT_NAME, source_entity_type: SOURCE_ENTITY_TYPE },
          requirements_deleted: organization.total,
          open_deleted: organization.open,
          resolved_deleted: organization.resolved,
          submissions_deleted: plan.submissions.filter((row) => row.organization_id === organization.organization_id).length,
          research_requirement_ids: plan.requirements
            .filter((row) => row.organization_id === organization.organization_id)
            .map((row) => row.research_requirement_id),
          submission_ids: plan.submissions
            .filter((row) => row.organization_id === organization.organization_id)
            .map((row) => row.submission_id),
          rulings: RULINGS,
        })],
      );
    }

    await client.query('commit');
    open = false;

    const result = {
      status: 'applied',
      scope,
      plan_fingerprint: plan.fingerprint,
      requirements_deleted: requirementsDeleted,
      submissions_deleted: submissionsDeleted,
      by_organization: plan.byOrganization,
      before: { table_rows_total: plan.tableTotal, tagged_in_scope: plan.counts.requirements },
      after: { table_rows_total: after.tableTotal, tagged_in_scope: after.counts.requirements },
    };
    log('completed', result);
    return result;
  } catch (error) {
    if (open) await client.query('rollback').catch(() => {});
    throw error;
  }
}

function defaultCreateClient(connectionString) {
  return new pg.Client({ connectionString });
}

/**
 * Command-line entry. Every refusal that can be decided without the database
 * -- options, scope, connection target -- is decided before a client is
 * created.
 */
export async function run(env = process.env, argv = process.argv.slice(2), { createClient = defaultCreateClient, log = defaultLog } = {}) {
  const parsed = parseCleanupOptions(env, argv);
  if (!parsed.ok) {
    log('refused', parsed.refusal);
    return { status: 'refused', ...parsed.refusal };
  }

  const connectionString = env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) {
    log('refused', { reason: 'MISSING_CONNECTION_STRING' });
    return { status: 'refused', reason: 'MISSING_CONNECTION_STRING' };
  }
  try {
    assertDeclaredWriteTargetFromEnv(connectionString, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_TARGET_ERROR';
    log('refused', { reason });
    return { status: 'refused', reason };
  }

  const client = createClient(connectionString);
  // An idle connection dropping emits 'error'; unhandled, Node prints the
  // whole error object. The failure is reported by the catch below instead.
  client.on?.('error', () => {});
  try {
    await client.connect();
    return await cleanupIntakeResearchRequirements(client, parsed.options, { log });
  } catch (error) {
    // Name, code and constraint only: a database error's message or detail
    // can quote a row's values.
    const failure = {
      reason: error instanceof Error ? error.name : 'UnknownError',
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
      constraint: error && typeof error === 'object' && 'constraint' in error ? String(error.constraint) : undefined,
    };
    log('failed', failure);
    return { status: 'failed', ...failure };
  } finally {
    await client.end();
  }
}

/** Exit status: 0 for a dry run, a committed apply, or an apply with nothing to delete; 1 otherwise. */
export function exitCodeFor(result) {
  return ['dry-run', 'applied', 'nothing-to-delete'].includes(result.status) ? 0 : 1;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const result = await run();
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.name : 'UnknownError' });
    process.exitCode = 1;
  }
}
