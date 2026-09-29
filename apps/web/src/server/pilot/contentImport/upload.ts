import { PilotError, ValidationError } from '../errors';
import { readCsv } from './csv';
import type { ImportPlan } from './plan';
import { packageInputs } from './plan';
import { FILE_SPECS } from './specs';
import type { DatasetName, Finding, Warning } from './types';
import { parsePackage } from './validate';

// THE UPLOAD ROUTE'S HALF OF THE CORE (IMP-12; R1 "for future work it will be
// 2"). app/api/pilot/admin/content-import/route.ts is the caller. Everything
// here runs BEFORE the core is handed the package: how much of a request body
// is read, what shape it must have, the caps, and the refusal of research. It
// reads no environment, no disk and no database, like the rest of the core
// (plan.ts, THE SEAM), so the route test drives it without either.
//
// It lives here rather than in route.ts because a Next route module is for
// handlers, and the tests import the caps. The page never imports it (it
// would pull csv-parse into the browser); it shows the route's refusals.

/**
 * THE CAPS, AND WHY EACH IS THE SIZE IT IS. Each refusal names its number
 * (the roster route's rule, roster-import/route.ts:41-47: a silent truncation
 * is material that vanished with nothing to say it was ever sent).
 *
 *   files         the contract knows FILE_SPECS.length files (16 today), each
 *                 once (validate.ts 'duplicate_file'), so a whole package fits
 *                 with room for a stray README the core then ignores.
 *   rows          data rows across every CSV. Everything committed today is
 *                 1,765 rows (the 119-drill library is 1,409 of them, stop
 *                 rules alone 674), so this is about five times that.
 *   packageBytes  UTF-8 bytes of every file's text. The 119-drill package is
 *                 587,228 bytes (library 240,053 + scale levels 173,600 + stop
 *                 rules 110,215 + cues 63,279 + secondary skills 81); all of
 *                 seed-data outside research is under 700 KB.
 *   bodyBytes     the request body as sent. JSON writes a quote or a line
 *                 break inside a CSV as two characters, so twice the package
 *                 plus room for the envelope. It is enforced WHILE the body is
 *                 read (readUploadBody), so an oversized body is refused
 *                 without first being held in memory whole.
 *
 * NOT VERIFIED: whether Azure Container Apps ingress admits a body this size.
 * The route's own reading is measured in contentImportUpload.pg.test.ts; the
 * ingress is only shown by a POST to staging.
 */
export const UPLOAD_LIMITS = {
  files: 20,
  rows: 10_000,
  packageBytes: 3_000_000,
  bodyBytes: 6_500_000,
} as const;

export interface UploadFile {
  name: string;
  text: string;
}

export interface UploadRequest {
  /** name -> text, the shape the core takes (plan.ts ImportRequest.files). */
  files: Record<string, string>;
  commit: boolean;
  /** Present exactly when commit is true. */
  planHash: string | null;
}

class UploadTooLarge extends PilotError {
  constructor(message: string, code: string) {
    super(413, message, code);
  }
}

/* A number in a refusal, with thousands separators. Intl, not toLocaleString:
   gymTimeDrift.test.ts bans every toLocale*String call outside gymTime.ts, and
   the locale is pinned either way. */
const NUMBER = new Intl.NumberFormat('en-US');

const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_NAME_LENGTH = 200;

/**
 * Reads the body as JSON, refusing past `limitBytes` as it streams in. A
 * Content-Length over the limit is refused before a byte is read; a body with
 * no length (chunked) is counted as it arrives and cancelled at the limit.
 */
export async function readUploadBody(request: Request, limitBytes: number = UPLOAD_LIMITS.bodyBytes): Promise<unknown> {
  const tooLarge = () =>
    new UploadTooLarge(
      `Unsupported upload: the request is larger than ${NUMBER.format(limitBytes)} bytes. `
      + 'Send fewer files at a time.',
      'UPLOAD_BODY_TOO_LARGE',
    );
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limitBytes) throw tooLarge();
  if (!request.body) throw new ValidationError('Missing request body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError('Unsupported upload: the request is not UTF-8 text');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('Unsupported upload: the request is not JSON');
  }
}

// ---------------------------------------------------------------------------
// Research is refused here.
//
// The flagged default Jason was told of: "research is NOT accepted by the
// upload screen". Where research lands and who loads it is still his open
// question (the intake plan's decisions 14-16), so this screen claims no
// answer to it; it only keeps research out. The core has no research spec,
// so a research CSV would reach it as 'unknown_file' (validate.ts:197) --
// blocked, but reading as a typo'd file name, which hides the real reason.
// So it is refused up front, by name, as research.
//
// THE PATTERNS ARE THE RESEARCH PACKAGES' OWN FILE NAMES, checked against
// every file under seed-data/shadow-research and seed-data/research-evidence
// by app/api/pilot/admin/content-import/route.test.ts -- and against every
// contract file, none of which may match -- so a pattern that drifts from the
// packages fails a test rather than letting a registry through.

const RESEARCH_FOLDER = /(^|\/)(shadow-research|research-evidence|research)\//i;
const RESEARCH_NAME = /research|evidence|shadow_library|conflict_ledger|test_battery|^sources\.csv$/i;

export function isResearchFile(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  return RESEARCH_FOLDER.test(normalized) || RESEARCH_NAME.test(base);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * The request body, checked. Throws a 400 (ValidationError) for a malformed
 * request and a 413 (UploadTooLarge) for one over a cap, each naming what to
 * change. The organization is not read from the body at all: the route takes
 * it from the session, so a body naming one has nothing to say.
 */
export function checkUploadRequest(body: unknown): UploadRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Unsupported upload: send a JSON object with a files list');
  }
  const record = body as Record<string, unknown>;

  const commitValue = record.commit;
  if (commitValue !== undefined && typeof commitValue !== 'boolean') {
    throw new ValidationError('Unsupported commit: must be true or false');
  }
  const commit = commitValue === true;

  let planHash: string | null = null;
  if (commit) {
    const value = record.plan_hash;
    if (typeof value !== 'string' || !PLAN_HASH_PATTERN.test(value)) {
      // Apply only what the person was shown: without the hash of that plan,
      // apply.ts could not tell whether it is still the plan (STALE_PLAN).
      throw new ValidationError('Missing plan_hash: check the files first, then apply the plan you were shown');
    }
    planHash = value;
  }

  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new ValidationError('Missing files: choose at least one CSV file');
  }
  if (record.files.length > UPLOAD_LIMITS.files) {
    throw new UploadTooLarge(
      `Unsupported upload: ${record.files.length} files, and this accepts ${UPLOAD_LIMITS.files} at a time. `
      + 'A content package is at most one of each contract file.',
      'UPLOAD_TOO_MANY_FILES',
    );
  }

  const files: Record<string, string> = {};
  const research: string[] = [];
  let bytes = 0;
  for (const entry of record.files as unknown[]) {
    const file = entry as Partial<UploadFile> | null;
    if (typeof file !== 'object' || file === null || typeof file.name !== 'string' || typeof file.text !== 'string') {
      throw new ValidationError('Unsupported upload: every file needs a name and its text');
    }
    const name = file.name.trim().replace(/\\/g, '/');
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(`Unsupported file name: 1 to ${MAX_NAME_LENGTH} characters`);
    }
    if (name in files) {
      throw new ValidationError(`Unsupported upload: ${name} was sent twice; send each file once`);
    }
    if (isResearchFile(name)) research.push(name);
    files[name] = file.text;
    bytes += Buffer.byteLength(file.text, 'utf8');
  }

  // Research first: a registry is refused as research, whatever its size.
  if (research.length > 0) {
    throw new ValidationError(
      `Unsupported upload: ${research.join(', ')} ${research.length === 1 ? 'is' : 'are'} research. `
      + 'Research is not loaded from this screen; it is loaded separately. Remove it and check the rest.',
      'UPLOAD_RESEARCH_REFUSED',
    );
  }
  if (bytes > UPLOAD_LIMITS.packageBytes) {
    throw new UploadTooLarge(
      `Unsupported upload: the files hold ${NUMBER.format(bytes)} bytes, and this accepts `
      + `${NUMBER.format(UPLOAD_LIMITS.packageBytes)} at a time. Send the material types separately.`,
      'UPLOAD_TOO_MANY_BYTES',
    );
  }
  // Rows are counted by the core's own reader, so a quoted line break inside
  // a cell is one row here exactly as it is at plan. Only a CSV has rows the
  // core reads; any other file is refused or ignored by its name
  // (validate.ts:180-203) and its text is never parsed.
  let rows = 0;
  for (const [name, text] of Object.entries(files)) {
    if (extensionOf(name) === '.csv' && text.trim() !== '') rows += readCsv(text).records.length;
  }
  if (rows > UPLOAD_LIMITS.rows) {
    throw new UploadTooLarge(
      `Unsupported upload: the files hold ${NUMBER.format(rows)} rows, and this accepts `
      + `${NUMBER.format(UPLOAD_LIMITS.rows)} at a time. Send the material types separately rather than `
      + 'letting part of a file through.',
      'UPLOAD_TOO_MANY_ROWS',
    );
  }

  return { files, commit, planHash };
}

// ---------------------------------------------------------------------------
// What the page is sent.

export interface PlanUnitView {
  dataset: DatasetName;
  key: string;
  package_key?: string;
  outcome: ImportPlan['units'][number]['outcome'];
  /** The item's name from the files, when a file row names it (absent items are not in the files). */
  label?: string;
  from_version?: number;
  to_version?: number;
  reasons?: string[];
}

export interface PlanView {
  organization_id: string;
  actor: { account_id: string; role: string };
  datasets: DatasetName[];
  counts: ImportPlan['counts'];
  totals: ImportPlan['totals'];
  changes: number;
  plan_hash: string;
  units: PlanUnitView[];
  blocking: Finding[];
  warnings: Warning[];
}

/** The columns an item's name is in, whichever dataset it is (drills, templates, scripts: name; registries: display_name; cohorts: cohort_name; universal rules: condition_text). */
const LABEL_COLUMNS = ['name', 'display_name', 'cohort_name', 'condition_text'] as const;
const MAX_LABEL = 120;

/**
 * An item's key in a plan is a drl_/wtp_/coh_ id, which tells a person
 * nothing. The files name each item they carry, so the name goes beside it.
 * Only the root file of a dataset names items (a child row carries its
 * parent's key); a new:<short-name> item is found by the key as written.
 */
function labelsFrom(files: Readonly<Record<string, string>>): Map<string, string> {
  const labels = new Map<string, string>();
  const { parsed } = parsePackage(packageInputs(files));
  for (const file of parsed.files) {
    if (file.spec.parent) continue;
    for (const row of file.rows) {
      const key = row.values[file.spec.key[0]];
      const label = LABEL_COLUMNS.map((column) => row.values[column] ?? row.raw[column] ?? '').find((value) => value.trim() !== '');
      if (key && label) labels.set(`${file.spec.dataset}\u0000${key}`, label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label);
    }
  }
  return labels;
}

export function planView(plan: ImportPlan, files: Readonly<Record<string, string>>): PlanView {
  const labels = labelsFrom(files);
  return {
    organization_id: plan.organizationId,
    actor: { account_id: plan.actor.accountId, role: plan.actor.role },
    datasets: plan.datasets,
    counts: plan.counts,
    totals: plan.totals,
    changes: plan.changes,
    plan_hash: plan.planHash,
    units: plan.units.map((unit) => {
      const label = labels.get(`${unit.dataset}\u0000${unit.packageKey ?? unit.key}`);
      return {
        dataset: unit.dataset,
        key: unit.key,
        ...(unit.packageKey ? { package_key: unit.packageKey } : {}),
        outcome: unit.outcome,
        ...(label ? { label } : {}),
        ...(unit.fromVersion !== undefined ? { from_version: unit.fromVersion } : {}),
        ...(unit.toVersion !== undefined ? { to_version: unit.toVersion } : {}),
        ...(unit.reasons?.length ? { reasons: unit.reasons } : {}),
      };
    }),
    blocking: plan.blocking,
    warnings: plan.warnings,
  };
}

/** Every file the contract knows, for the page's hint and the test that no contract file reads as research. */
export const CONTRACT_FILE_NAMES: readonly string[] = FILE_SPECS.map((spec) => spec.file);
