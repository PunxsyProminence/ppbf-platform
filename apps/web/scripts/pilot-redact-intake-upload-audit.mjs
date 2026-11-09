#!/usr/bin/env node

/**
 * Redacts the intake file names held in the audit rows athlete intake uploads
 * wrote before PR #1122 (2026-10-03). The rows stay; their text goes.
 *
 * WHY THIS EXISTS
 *
 * Until #1122 every /api/pilot/shadow/upload call wrote one pilot.audit_events
 * row of event_type 'shadow_research_upload_requirement' whose details copied
 * the research-requirement text -- "Review <type> (<file name>) and validate
 * routing to <queue>." -- and the file name is often a child's. #1897 deletes
 * the research rows themselves; these audit rows were left. Jason ruled
 * 2026-11-09, "Redact the names": keep the rows, remove the file-name text
 * (behind it, OD-2026-10-02-015 D4 and OD-2026-10-03-002 section 1).
 *
 * WHAT CHANGES, EXACTLY
 *
 * In each selected row, details.research_requirement becomes REDACTION_MARKER,
 * and two keys are added: redacted_at (ISO UTC) and redacted_fields
 * (['research_requirement'], or [] for a row without that key). The merge is
 * done by the database (`details || jsonb_build_object(...)`); the client never
 * sends a whole details object. Every other key is left byte for byte, and the
 * apply checks that inside its transaction before committing. research_requirement
 * is the only key that carried the name: the removed writer (`git show
 * 40df6e742^`, shadow.ts buildUploadResearchFields) built it as "Review <type>
 * (<file name>) and validate routing to <queue>."; knowledge_gap was a fixed
 * sentence per classification and stays (Overwatch, applying the ruling,
 * 2026-11-09).
 *
 * WHICH ROWS, EXACTLY
 *
 *   event_type = 'shadow_research_upload_requirement'
 *   details->>'source_event_name'  = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED'
 *   details->>'source_entity_type' = 'shadow_intake'
 *   details has no 'redacted_at' key
 * in the organization named (--organization <id>, which must exist) or in all
 * organizations (--all-organizations, which also takes a row with no
 * organization). Never a text match on a file name. No other event_type: the
 * upload's other audit rows (shadow_classification, shadow_routing) never held
 * the name (git show 40df6e742^, route.ts). The name also sits outside
 * pilot.audit_events -- the intake tables, pilot.shadow_events payloads,
 * pilot.shadow_authority_checks metadata -- which this ruling does not cover.
 *
 * WHAT IT PRINTS
 *
 * audit_ids, counts, organizations, the event_type, the created_at range and
 * the plan fingerprint. NEVER a details value: the SQL that plans selects no
 * details text at all, only whether research_requirement is present.
 *
 *   TARGET GUARD    PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE must match
 *                   AZURE_POSTGRES_CONNECTION_STRING, before a client exists.
 *   READ-ONLY BY    A plain run opens `begin transaction read only`, prints the
 *   DEFAULT         plan and its plan_fingerprint, and rolls back.
 *   REVIEWED PLAN   Apply needs PPBF_INTAKE_AUDIT_REDACT_APPLY=true, the phrase
 *   ONLY            in PPBF_INTAKE_AUDIT_REDACT_CONFIRM and
 *                   PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT = the reviewed
 *                   dry run's plan_fingerprint: sha256 over the scope, the
 *                   selection, the marker and every planned row (audit_id,
 *                   organization, whether it has research_requirement), sorted.
 *   ONE TRANSACTION Re-plans with the rows locked, checks the fingerprint,
 *                   updates, checks the count, the end state and the untouched
 *                   keys, writes one 'update' audit row per organization,
 *                   commits.
 *
 * Usage (from the redact-intake-upload-audit workflow):
 *   npm run pilot:redact-intake-upload-audit -- --all-organizations
 *   PPBF_INTAKE_AUDIT_REDACT_APPLY=true \
 *     PPBF_INTAKE_AUDIT_REDACT_CONFIRM='REDACT INTAKE UPLOAD AUDIT ROWS' \
 *     PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT='sha256:<from the dry run>' \
 *     npm run pilot:redact-intake-upload-audit -- --organization <id>
 */

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

export const TARGET_EVENT_TYPE = 'shadow_research_upload_requirement';
export const SOURCE_EVENT_NAME = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED';
export const SOURCE_ENTITY_TYPE = 'shadow_intake';
export const REDACTED_KEYS = ['research_requirement'];
export const REDACTION_MARKER = "[redacted 2026-11-09: intake file name; Jason 2026-11-09 'Redact the names']";
export const CONFIRM_PHRASE = 'REDACT INTAKE UPLOAD AUDIT ROWS';
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const AUDIT_EVENT_TYPE = 'update';
export const AUDIT_ENTITY_TYPE = 'audit_details_redaction';
/** entity_id of the record for rows that carry no organization (all-organizations scope only). */
export const NO_ORGANIZATION = 'no-organization';
const EVENT_PREFIX = 'audit.intake_upload_redaction';
const RULING = "Jason 2026-11-09, 'Redact the names': the pre-#1122 shadow_research_upload_requirement audit rows are kept and lose the file-name text (OD-2026-10-02-015 D4; OD-2026-10-03-002 section 1)";
const SELECTION = {
  event_type: TARGET_EVENT_TYPE,
  source_event_name: SOURCE_EVENT_NAME,
  source_entity_type: SOURCE_ENTITY_TYPE,
  without_key: 'redacted_at',
};

// $1 event type, $2 source_event_name, $3 source_entity_type, $4 organization (null = all).
const IN_SCOPE = `event_type = $1
        and details->>'source_event_name' = $2 and details->>'source_entity_type' = $3
        and not (details ? 'redacted_at')
        and ($4::text is null or organization_id = $4)`;

function defaultLog(event, payload) {
  const line = JSON.stringify({ event: `${EVENT_PREFIX}.${event}`, ...payload }, null, event === 'plan' ? 2 : 0);
  if (event === 'refused' || event === 'failed') console.error(line);
  else console.log(line);
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byBigInt = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/** Pure input checks, before any statement. null when usable, otherwise `{ reason }`. */
export function validateRedactOptions(options) {
  const { apply, confirm, expectFingerprint, organizationId, allOrganizations } = options ?? {};
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
  if (apply === true && !FINGERPRINT_PATTERN.test(String(expectFingerprint))) return { reason: 'INVALID_EXPECTED_FINGERPRINT' };
  return null;
}

/** Scope from the command line, mode from PPBF_INTAKE_AUDIT_REDACT_*, then validated. */
export function parseRedactOptions(env = process.env, argv = process.argv.slice(2)) {
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
    apply: env.PPBF_INTAKE_AUDIT_REDACT_APPLY === 'true',
    confirm: env.PPBF_INTAKE_AUDIT_REDACT_CONFIRM ?? '',
    expectFingerprint: (env.PPBF_INTAKE_AUDIT_REDACT_EXPECT_FINGERPRINT ?? '').trim(),
    organizationId,
    allOrganizations,
  };
  const refusal = validateRedactOptions(options);
  return refusal ? { ok: false, refusal } : { ok: true, options };
}

const scopeOf = (options) => (options.allOrganizations === true ? { all_organizations: true } : { organization_id: options.organizationId });
const scopeParams = (options) => [TARGET_EVENT_TYPE, SOURCE_EVENT_NAME, SOURCE_ENTITY_TYPE, options.allOrganizations === true ? null : options.organizationId];

/**
 * The plan. Selects audit_id, organization, created_at and one boolean --
 * never a details value. `lock` adds FOR UPDATE (apply only).
 */
export async function readRedactPlan(client, options, { lock = false } = {}) {
  const rows = (await client.query(
    `select audit_id::text as audit_id, organization_id,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            details ? 'research_requirement' as has_research_requirement
       from pilot.audit_events
      where ${IN_SCOPE}
      order by audit_id${lock ? ' for update' : ''}`,
    scopeParams(options),
  )).rows.sort((a, b) => byBigInt(a.audit_id, b.audit_id));

  const totals = (await client.query(
    `select count(*)::int as event_type_total,
            count(*) filter (where details->>'source_event_name' = $2 and details->>'source_entity_type' = $3
                               and details ? 'redacted_at' and ($4::text is null or organization_id = $4))::int as already_redacted_in_scope
       from pilot.audit_events where event_type = $1`,
    scopeParams(options),
  )).rows[0];

  const byOrganization = new Map();
  for (const row of rows) {
    const key = row.organization_id ?? null;
    const entry = byOrganization.get(key) ?? { organization_id: key, rows: 0 };
    entry.rows += 1;
    byOrganization.set(key, entry);
  }
  const created = rows.map((row) => row.created_at).sort(byText);
  const material = JSON.stringify({
    selection: SELECTION,
    marker: REDACTION_MARKER,
    scope: scopeOf(options),
    rows: rows.map((row) => [row.audit_id, row.organization_id ?? null, row.has_research_requirement]),
  });

  return {
    fingerprint: `sha256:${crypto.createHash('sha256').update(material).digest('hex')}`,
    rows,
    auditIds: rows.map((row) => row.audit_id),
    counts: {
      in_scope_unredacted: rows.length,
      already_redacted_in_scope: Number(totals?.already_redacted_in_scope ?? 0),
      event_type_total: Number(totals?.event_type_total ?? 0),
    },
    byOrganization: [...byOrganization.values()].sort((a, b) => byText(a.organization_id ?? '', b.organization_id ?? '')),
    createdRange: created.length === 0 ? null : { earliest: created[0], latest: created[created.length - 1] },
  };
}

// Every key but research_requirement, hashed inside the database (the text never
// leaves it): before the update without it, after it without the two added keys
// as well. Any other key changed -- knowledge_gap included, or a pre-existing
// redacted_fields overwritten -- makes the two differ.
const KEPT_BEFORE = "md5((details - 'research_requirement')::text)";
const KEPT_AFTER = "md5((a.details - 'research_requirement' - 'redacted_at' - 'redacted_fields')::text)";

/**
 * The redaction. `client` has pg's `query(text, values)` shape; the caller owns
 * connecting and ending it. Returns { status: 'refused' | 'dry-run' |
 * 'nothing-to-redact' | 'applied', ... }; throws (after rolling back) on an
 * unexpected database error.
 */
export async function redactIntakeUploadAudit(client, options, { log = defaultLog } = {}) {
  const refusal = validateRedactOptions(options);
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
      const found = (await client.query('select 1 from pilot.organizations where organization_id = $1', [options.organizationId])).rows;
      if (found.length !== 1) return await refuseInside('ORGANIZATION_NOT_FOUND');
    }

    const plan = await readRedactPlan(client, options, { lock: apply });
    const summary = {
      plan_fingerprint: plan.fingerprint,
      counts: plan.counts,
      by_organization: plan.byOrganization,
      created_at_range: plan.createdRange,
      audit_ids: plan.auditIds,
    };
    log('plan', { mode: apply ? 'apply' : 'dry-run', scope, selection: SELECTION, redacted_keys: REDACTED_KEYS, ...summary });

    if (!apply) {
      await client.query('rollback');
      open = false;
      log('dry-run', {
        plan_fingerprint: plan.fingerprint,
        counts: plan.counts,
        note: plan.auditIds.length === 0
          ? 'nothing to redact in this scope'
          : `apply needs mode=apply, the phrase ${CONFIRM_PHRASE}, the same scope, and expected_fingerprint set to this plan_fingerprint`,
      });
      return { status: 'dry-run', scope, ...summary };
    }

    // The reviewed dry run is the plan Jason approved; anything changed since
    // changes the fingerprint and stops here, before any write.
    if (plan.fingerprint !== options.expectFingerprint) {
      return await refuseInside('PLAN_FINGERPRINT_MISMATCH', { expected: options.expectFingerprint, actual: plan.fingerprint });
    }
    if (plan.auditIds.length === 0) {
      await client.query('rollback');
      open = false;
      log('nothing-to-redact', { plan_fingerprint: plan.fingerprint, scope });
      return { status: 'nothing-to-redact', scope, plan_fingerprint: plan.fingerprint };
    }

    const keptBefore = (await client.query(
      `select audit_id::text as audit_id, ${KEPT_BEFORE} as h from pilot.audit_events where audit_id = any($1::bigint[])`,
      [plan.auditIds],
    )).rows;
    const redactedAt = (await client.query(
      `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
    )).rows[0].at;

    // The selection is restated on the update itself, so a planned id that no
    // longer matches is not touched -- and the count check catches it.
    const updated = (await client.query(
      `update pilot.audit_events
          set details = details
            || case when details ? 'research_requirement' then jsonb_build_object('research_requirement', $6::text) else '{}'::jsonb end
            || jsonb_build_object(
                 'redacted_at', $7::text,
                 'redacted_fields', case when details ? 'research_requirement'
                                         then '["research_requirement"]'::jsonb else '[]'::jsonb end)
        where audit_id = any($5::bigint[]) and ${IN_SCOPE}`,
      [...scopeParams(options), plan.auditIds, REDACTION_MARKER, redactedAt],
    )).rowCount ?? 0;
    if (updated !== plan.auditIds.length) {
      return await refuseInside('UPDATE_COUNT_MISMATCH', { planned: plan.auditIds.length, updated });
    }

    // End state, on the planned rows: each carries this run's redacted_at, the
    // marker and the matching redacted_fields, and every other key hashes as before.
    const check = (await client.query(
      `with b as (select * from jsonb_to_recordset($2::jsonb) as x(audit_id text, h text))
       select count(*) filter (where a.details->>'redacted_at' is distinct from $3)::int as wrong_stamp,
              count(*) filter (where a.details ? 'research_requirement'
                                 and a.details->>'research_requirement' is distinct from $4)::int as text_left,
              count(*) filter (where a.details->'redacted_fields' is distinct from
                                 case when a.details ? 'research_requirement' then '["research_requirement"]'::jsonb
                                      else '[]'::jsonb end)::int as wrong_fields,
              count(*) filter (where b.h is distinct from ${KEPT_AFTER})::int as other_keys_changed
         from pilot.audit_events a left join b on b.audit_id = a.audit_id::text
        where a.audit_id = any($1::bigint[])`,
      [plan.auditIds, JSON.stringify(keptBefore), redactedAt, REDACTION_MARKER],
    )).rows[0];
    const after = await readRedactPlan(client, options, { lock: false });
    const mismatches = [];
    if (check.wrong_stamp !== 0) mismatches.push(`rows_without_this_stamp=${check.wrong_stamp}`);
    if (check.text_left !== 0) mismatches.push(`rows_with_text_left=${check.text_left}`);
    if (check.wrong_fields !== 0) mismatches.push(`rows_with_wrong_redacted_fields=${check.wrong_fields}`);
    if (check.other_keys_changed !== 0) mismatches.push(`rows_with_other_keys_changed=${check.other_keys_changed}`);
    if (after.auditIds.length !== 0) mismatches.push(`unredacted_left_in_scope=${after.auditIds.length}`);
    if (mismatches.length > 0) return await refuseInside('END_STATE_MISMATCH', { mismatches });

    // One record in each affected organization's own trail.
    for (const group of plan.byOrganization) {
      const groupIds = plan.rows.filter((row) => (row.organization_id ?? null) === group.organization_id).map((row) => row.audit_id);
      await client.query(
        `insert into pilot.audit_events (event_type, organization_id, entity_type, entity_id, details)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [AUDIT_EVENT_TYPE, group.organization_id, AUDIT_ENTITY_TYPE, group.organization_id ?? NO_ORGANIZATION, JSON.stringify({
          plan_fingerprint: plan.fingerprint,
          scope,
          selection: SELECTION,
          redacted_keys: REDACTED_KEYS,
          redacted_at: redactedAt,
          rows_redacted: groupIds.length,
          redacted_audit_ids: groupIds,
          ruling: RULING,
        })],
      );
    }

    await client.query('commit');
    open = false;
    const result = {
      status: 'applied',
      scope,
      plan_fingerprint: plan.fingerprint,
      rows_redacted: updated,
      redacted_at: redactedAt,
      by_organization: plan.byOrganization,
      before: plan.counts,
      after: after.counts,
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

/** Command-line entry. Option, scope and target refusals happen before a client is created. */
export async function run(env = process.env, argv = process.argv.slice(2), { createClient = defaultCreateClient, log = defaultLog } = {}) {
  const parsed = parseRedactOptions(env, argv);
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
  // An idle connection dropping emits 'error'; reported by the catch below instead.
  client.on?.('error', () => {});
  try {
    await client.connect();
    return await redactIntakeUploadAudit(client, parsed.options, { log });
  } catch (error) {
    // Name, code and constraint only: a database error's message or detail can quote a row's values.
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

/** Exit status: 0 for a dry run, a committed apply, or an apply with nothing to redact; 1 otherwise. */
export function exitCodeFor(result) {
  return ['dry-run', 'applied', 'nothing-to-redact'].includes(result.status) ? 0 : 1;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    process.exitCode = exitCodeFor(await run());
  } catch (error) {
    defaultLog('failed', { reason: error instanceof Error ? error.name : 'UnknownError' });
    process.exitCode = 1;
  }
}
