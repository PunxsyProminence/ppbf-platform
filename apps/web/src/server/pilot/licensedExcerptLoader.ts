/**
 * Licensed-excerpt loader: the operator path of OD-2026-10-03-002 section 2
 * ("Screen, plus an operator workflow reading a private location"), with the
 * private location an Azure private blob container (OD-2026-10-05-009) and an
 * excerpt's location any locator -- page, section or timestamp
 * (OD-2026-10-05-010).
 *
 * The workflow (load-licensed-excerpts.yml) downloads the container into a
 * runner folder; everything here reads that folder, so the code a test runs
 * against a local folder is the code a production run executes.
 *
 * ONE FILE = ONE DOCUMENT. Each `*.json` file names an existing source in the
 * target organization and carries a citation and its excerpts. The loader
 * registers one document per file through createShadowLibraryDocument and one
 * chunk per excerpt through createShadowLibraryChunk -- the same functions the
 * screen's routes call, so the database's rights rule (#1238) and the
 * document's reset to pending review apply exactly as they do on the screen.
 * Every chunk carries a locator, so every chunk is stored as text_kind
 * 'excerpt'; this loader never writes full text.
 *
 * IDEMPOTENT BY CONTENT. The document's content_sha256 is the hash of the
 * file's canonical content, and (organization_id, content_sha256) is unique.
 * A rerun finds the document and skips it when complete, or adds the missing
 * ordinals when a previous apply stopped part way. A document whose stored
 * chunks disagree with the file is a conflict and refuses the apply, and so is
 * a file whose name an earlier loaded document carries with other content (an
 * edited file): it is never loaded as a quiet second copy.
 *
 * REVIEWED PLAN ONLY. A dry run prints the plan and its fingerprint. Apply
 * needs that fingerprint, re-plans, and refuses before its first write unless
 * the fresh plan has the same one.
 *
 * NO TEXT IN LOGS. Excerpts are licensed text: the plan prints file names,
 * hashes, lengths, citations and locators, never excerpt text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { assertImportActor, type ImportActor } from './contentImport/actor';
import { query, withPoolClient } from './db';
import { createShadowLibraryChunk, createShadowLibraryDocument } from './shadowLibrary';

export const EXCERPT_FILE_FORMAT = 'ppbf-licensed-excerpts/1';
export const CONFIRM_PHRASE = 'LOAD EXCERPTS';

// Text and locator bounds are the chunks route's (app/api/pilot/shadow/library/
// chunks/route.ts MAX_CHUNK_LENGTH, MAX_LOCATOR_LENGTH), so a file the loader
// accepts is one the screen would accept part by part.
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_LOCATOR_LENGTH = 200;
export const MAX_CITATION_LENGTH = 1_000;
export const MAX_DOCUMENT_NAME_LENGTH = 300;
export const MAX_EXCERPTS_PER_FILE = 500;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 1_000;

const FILE_KEYS = new Set(['format', 'source_id', 'document_name', 'citation', 'excerpts']);
const EXCERPT_KEYS = new Set(['locator', 'text']);

export interface ExcerptFileContent {
  format: typeof EXCERPT_FILE_FORMAT;
  source_id: string;
  document_name: string;
  citation: string;
  excerpts: Array<{ locator: string; text: string }>;
}

export interface ParsedExcerptFile {
  name: string;
  content: ExcerptFileContent;
  contentSha256: string;
}

export interface InvalidExcerptFile {
  name: string;
  problems: string[];
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Postgres refuses U+0000 in text and jsonb. Caught here, so a dry run shows
// it rather than an apply failing part way at that excerpt on every rerun.
function hasNul(value: unknown): boolean {
  return typeof value === 'string' && value.includes('\u0000');
}

/**
 * The hash a file is known by. Built from the validated, trimmed fields in a
 * fixed order, so whitespace or key order in the file does not change it, and
 * any change to the text, a locator, the citation, the name or the source does.
 */
export function canonicalContentSha256(content: ExcerptFileContent): string {
  return sha256(JSON.stringify([
    content.format,
    content.source_id,
    content.document_name,
    content.citation,
    content.excerpts.map((excerpt) => [excerpt.locator, excerpt.text]),
  ]));
}

/** Validates one file's bytes. Never echoes text back in a problem. */
export function parseExcerptFile(name: string, raw: Buffer): ParsedExcerptFile | InvalidExcerptFile {
  const problems: string[] = [];
  if (raw.length > MAX_FILE_BYTES) {
    return { name, problems: [`file is ${raw.length} bytes; the limit is ${MAX_FILE_BYTES}`] };
  }

  let data: unknown;
  try {
    // A byte-order mark, which Windows editors add, is not JSON; drop it.
    data = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { name, problems: ['not valid JSON'] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { name, problems: ['top level must be a JSON object'] };
  }
  const record = data as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!FILE_KEYS.has(key)) problems.push(`unexpected field '${key}'`);
  }
  if (record.format !== EXCERPT_FILE_FORMAT) problems.push(`format must be '${EXCERPT_FILE_FORMAT}'`);
  if (!nonBlank(record.source_id)) problems.push('source_id is required');
  if (!nonBlank(record.document_name)) problems.push('document_name is required');
  else if (record.document_name.trim().length > MAX_DOCUMENT_NAME_LENGTH) {
    problems.push(`document_name is longer than ${MAX_DOCUMENT_NAME_LENGTH} characters`);
  }
  if (!nonBlank(record.citation)) problems.push('citation is required');
  else if (record.citation.trim().length > MAX_CITATION_LENGTH) {
    problems.push(`citation is longer than ${MAX_CITATION_LENGTH} characters`);
  }

  const excerpts: Array<{ locator: string; text: string }> = [];
  if (!Array.isArray(record.excerpts) || record.excerpts.length === 0) {
    problems.push('excerpts must be a non-empty array');
  } else if (record.excerpts.length > MAX_EXCERPTS_PER_FILE) {
    problems.push(`excerpts has ${record.excerpts.length} entries; the limit is ${MAX_EXCERPTS_PER_FILE}`);
  } else {
    record.excerpts.forEach((entry: unknown, index: number) => {
      const at = `excerpts[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        problems.push(`${at} must be an object`);
        return;
      }
      const excerpt = entry as Record<string, unknown>;
      for (const key of Object.keys(excerpt)) {
        if (!EXCERPT_KEYS.has(key)) problems.push(`${at} has unexpected field '${key}'`);
      }
      // A blank locator says nothing about where the text is (the chunks
      // route's rule); without one the chunk would be full text.
      if (!nonBlank(excerpt.locator)) problems.push(`${at}.locator is required (a page, section or timestamp)`);
      else if (excerpt.locator.trim().length > MAX_LOCATOR_LENGTH) {
        problems.push(`${at}.locator is longer than ${MAX_LOCATOR_LENGTH} characters`);
      }
      if (!nonBlank(excerpt.text)) problems.push(`${at}.text is required`);
      else if (excerpt.text.trim().length > MAX_TEXT_LENGTH) {
        problems.push(`${at}.text is ${excerpt.text.trim().length} characters; the limit is ${MAX_TEXT_LENGTH}`);
      }
      if (nonBlank(excerpt.locator) && nonBlank(excerpt.text)) {
        excerpts.push({ locator: excerpt.locator.trim(), text: excerpt.text.trim() });
      }
    });
  }

  const strings = [record.source_id, record.document_name, record.citation,
    ...(Array.isArray(record.excerpts) ? record.excerpts.flatMap((entry: unknown) =>
      (typeof entry === 'object' && entry !== null ? Object.values(entry as Record<string, unknown>) : [])) : [])];
  if (strings.some(hasNul)) problems.push('contains a NUL character (U+0000), which the database refuses');

  if (problems.length > 0) return { name, problems };

  const content: ExcerptFileContent = {
    format: EXCERPT_FILE_FORMAT,
    source_id: (record.source_id as string).trim(),
    document_name: (record.document_name as string).trim(),
    citation: (record.citation as string).trim(),
    excerpts,
  };
  return { name, content, contentSha256: canonicalContentSha256(content) };
}

export function isInvalid(file: ParsedExcerptFile | InvalidExcerptFile): file is InvalidExcerptFile {
  return 'problems' in file;
}

/**
 * Every regular file under `dir`, by its path relative to `dir` with forward
 * slashes (the blob name). A file that is not `.json` is reported, not
 * skipped: the container holds excerpt files and nothing else, so anything
 * else is a mistake an operator should see.
 */
export async function readExcerptFolder(dir: string): Promise<Array<ParsedExcerptFile | InvalidExcerptFile>> {
  const names: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) names.push(path.relative(dir, full).split(path.sep).join('/'));
      else names.push(`${path.relative(dir, full).split(path.sep).join('/')} (not a regular file)`);
    }
  }
  await walk(dir);
  names.sort();

  if (names.length > MAX_FILES) {
    throw new Error(`EXCERPT_FOLDER_TOO_LARGE: ${names.length} files; the limit per run is ${MAX_FILES}`);
  }

  const files: Array<ParsedExcerptFile | InvalidExcerptFile> = [];
  for (const name of names) {
    if (name.endsWith('(not a regular file)')) {
      files.push({ name, problems: ['not a regular file'] });
    } else if (!name.toLowerCase().endsWith('.json')) {
      files.push({ name, problems: ['not a .json excerpt file'] });
    } else {
      files.push(parseExcerptFile(name, await fs.readFile(path.join(dir, ...name.split('/')))));
    }
  }
  return files;
}

export type FilePlanStatus = 'new' | 'resume' | 'complete' | 'conflict' | 'invalid';

export interface FilePlan {
  name: string;
  status: FilePlanStatus;
  contentSha256: string | null;
  sourceId: string | null;
  sourceRights: string | null;
  documentId: string | null;
  excerptCount: number;
  /** Ordinals this run would write. */
  createOrdinals: number[];
  problems: string[];
  citation: string | null;
  excerpts: Array<{ ordinal: number; locator: string; textLength: number; textSha256: string }>;
}

export interface LoadPlan {
  /** hostname/database the plan was made against, so a staging plan cannot authorize production. */
  target: string;
  organizationId: string;
  actorAccountId: string;
  files: FilePlan[];
  blocked: boolean;
  fingerprint: string;
}

interface ExistingDocument {
  document_id: string;
  source_id: string;
}

interface ExistingChunk {
  ordinal: number;
  text_sha256: string;
  excerpt_locator: string | null;
  text_kind: string;
}

/**
 * The fingerprint names exactly what an apply would do: the organization, the
 * actor, and for every file its name, status, content hash, source, document
 * and the ordinals it would write. Problems are text for people and are left
 * out; a blocked plan cannot be applied anyway.
 */
export function planFingerprint(plan: Omit<LoadPlan, 'fingerprint'>): string {
  return `sha256:${sha256(JSON.stringify([
    plan.target,
    plan.organizationId,
    plan.actorAccountId,
    plan.files.map((file) => [
      file.name,
      file.status,
      file.contentSha256,
      file.sourceId,
      file.documentId,
      file.createOrdinals,
    ]),
  ]))}`;
}

export async function buildLoadPlan(input: {
  target: string;
  organizationId: string;
  actorAccountId: string;
  files: Array<ParsedExcerptFile | InvalidExcerptFile>;
}): Promise<LoadPlan> {
  const seenHashes = new Map<string, string>();
  const files: FilePlan[] = [];

  for (const file of input.files) {
    if (isInvalid(file)) {
      files.push({
        name: file.name,
        status: 'invalid',
        contentSha256: null,
        sourceId: null,
        sourceRights: null,
        documentId: null,
        excerptCount: 0,
        createOrdinals: [],
        problems: file.problems,
        citation: null,
        excerpts: [],
      });
      continue;
    }

    const excerpts = file.content.excerpts.map((excerpt, ordinal) => ({
      ordinal,
      locator: excerpt.locator,
      textLength: excerpt.text.length,
      textSha256: sha256(excerpt.text),
    }));
    const plan: FilePlan = {
      name: file.name,
      status: 'new',
      contentSha256: file.contentSha256,
      sourceId: file.content.source_id,
      sourceRights: null,
      documentId: null,
      excerptCount: excerpts.length,
      createOrdinals: [],
      problems: [],
      citation: file.content.citation,
      excerpts,
    };
    files.push(plan);

    const duplicateOf = seenHashes.get(file.contentSha256);
    if (duplicateOf) {
      plan.status = 'invalid';
      plan.problems.push(`same content as ${duplicateOf}`);
      continue;
    }
    seenHashes.set(file.contentSha256, file.name);

    const [source] = await query<{ source_id: string; rights_status: string }>(
      `select source_id, rights_status
         from pilot.shadow_library_sources
        where source_id = $1 and organization_id = $2`,
      [file.content.source_id, input.organizationId],
    );
    if (!source) {
      plan.status = 'invalid';
      plan.problems.push(`source_id '${file.content.source_id}' does not exist in organization '${input.organizationId}'`);
      continue;
    }
    plan.sourceRights = source.rights_status;

    const [document] = await query<ExistingDocument>(
      `select document_id, source_id
         from pilot.shadow_library_documents
        where organization_id = $1 and content_sha256 = $2`,
      [input.organizationId, file.contentSha256],
    );
    if (!document) {
      // Same file name, different content: the file was edited after it was
      // loaded. Loading it would leave two documents, the old one unflagged,
      // so it is a conflict. The way through is in the runbook: retract the
      // old document on the screen and load the edited file under a new name.
      const [earlier] = await query<{ document_id: string }>(
        `select document_id
           from pilot.shadow_library_documents
          where organization_id = $1
            and metadata->>'intake_method' = 'licensed_excerpt_loader'
            and metadata->>'blob_name' = $2
          order by created_at
          limit 1`,
        [input.organizationId, file.name],
      );
      if (earlier) {
        plan.status = 'conflict';
        plan.documentId = earlier.document_id;
        plan.problems.push(
          `document ${earlier.document_id} was loaded from this file name with different content; `
          + 'retract it on the screen and load the edited file under a new name',
        );
        continue;
      }
      plan.createOrdinals = excerpts.map((excerpt) => excerpt.ordinal);
      continue;
    }

    plan.documentId = document.document_id;
    if (document.source_id !== file.content.source_id) {
      plan.status = 'conflict';
      plan.problems.push(`document ${document.document_id} has this content but sits under source ${document.source_id}`);
      continue;
    }

    const stored = await query<ExistingChunk>(
      `select ordinal, encode(sha256(convert_to(text_content, 'UTF8')), 'hex') as text_sha256,
              excerpt_locator, text_kind
         from pilot.shadow_library_chunks
        where document_id = $1 and organization_id = $2
        order by ordinal`,
      [document.document_id, input.organizationId],
    );
    const planned = new Map(excerpts.map((excerpt) => [excerpt.ordinal, excerpt]));
    for (const chunk of stored) {
      const expected = planned.get(chunk.ordinal);
      if (!expected) {
        plan.problems.push(`stored ordinal ${chunk.ordinal} is not in the file`);
      } else if (
        chunk.text_sha256 !== expected.textSha256
        || chunk.excerpt_locator !== expected.locator
        || chunk.text_kind !== 'excerpt'
      ) {
        plan.problems.push(`stored ordinal ${chunk.ordinal} differs from the file`);
      }
    }
    if (plan.problems.length > 0) {
      plan.status = 'conflict';
      continue;
    }
    const storedOrdinals = new Set(stored.map((chunk) => chunk.ordinal));
    plan.createOrdinals = excerpts.map((excerpt) => excerpt.ordinal).filter((ordinal) => !storedOrdinals.has(ordinal));
    plan.status = plan.createOrdinals.length === 0 ? 'complete' : 'resume';
  }

  const blocked = files.some((file) => file.status === 'invalid' || file.status === 'conflict');
  const withoutFingerprint = {
    target: input.target,
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    files,
    blocked,
  };
  return { ...withoutFingerprint, fingerprint: planFingerprint(withoutFingerprint) };
}

/** The plan as log lines. Never contains excerpt text. */
export function describePlan(plan: LoadPlan): string[] {
  const lines: string[] = [];
  const count = (status: FilePlanStatus) => plan.files.filter((file) => file.status === status).length;
  lines.push(`target: ${plan.target}`);
  lines.push(`organization_id: ${plan.organizationId}`);
  lines.push(`actor_account_id: ${plan.actorAccountId}`);
  lines.push(
    `files: ${plan.files.length} (new ${count('new')}, resume ${count('resume')}, complete ${count('complete')}, `
    + `conflict ${count('conflict')}, invalid ${count('invalid')})`,
  );
  lines.push(`chunks_to_write: ${plan.files.reduce((total, file) => total + file.createOrdinals.length, 0)}`);
  for (const file of plan.files) {
    lines.push(`- ${file.name}: ${file.status}`);
    if (file.contentSha256) lines.push(`    content_sha256: ${file.contentSha256}`);
    if (file.sourceId) lines.push(`    source_id: ${file.sourceId} (rights ${file.sourceRights ?? 'n/a'})`);
    if (file.documentId) lines.push(`    document_id: ${file.documentId}`);
    if (file.citation) lines.push(`    citation: ${JSON.stringify(file.citation)}`);
    for (const excerpt of file.excerpts) {
      const action = file.createOrdinals.includes(excerpt.ordinal) ? 'write' : 'stored';
      lines.push(
        `    [${excerpt.ordinal}] ${action} locator=${JSON.stringify(excerpt.locator)} `
        + `chars=${excerpt.textLength} sha256=${excerpt.textSha256.slice(0, 16)}`,
      );
    }
    for (const problem of file.problems) lines.push(`    PROBLEM: ${problem}`);
  }
  lines.push(`blocked: ${plan.blocked}`);
  lines.push(`plan_fingerprint: ${plan.fingerprint}`);
  return lines;
}

export async function resolveActor(organizationId: string, accountId: string): Promise<ImportActor> {
  return withPoolClient((client) => assertImportActor(client, organizationId, accountId));
}

export class ExcerptLoadRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ExcerptLoadRefusal';
  }
}

export interface LoadOptions {
  /** hostname/database of the declared write target; part of the fingerprint. */
  target: string;
  organizationId: string;
  actorAccountId: string;
  dir: string;
  apply: boolean;
  confirm?: string;
  expectedFingerprint?: string;
  log: (line: string) => void;
}

export interface LoadResult {
  plan: LoadPlan;
  documentsCreated: number;
  chunksWritten: number;
}

/**
 * Plan, and with `apply` load. Apply refuses before its first write unless the
 * confirm phrase is exact, the plan is unblocked, and its fingerprint equals
 * the one the operator reviewed. After writing it re-plans and requires every
 * file to read `complete`.
 */
export async function runExcerptLoad(options: LoadOptions): Promise<LoadResult> {
  const organizationId = options.organizationId.trim();
  const actorAccountId = options.actorAccountId.trim();
  if (!organizationId) throw new ExcerptLoadRefusal('MISSING_ORGANIZATION_ID', 'organization_id is required');
  if (!actorAccountId) throw new ExcerptLoadRefusal('MISSING_ACTOR_ACCOUNT_ID', 'actor account_id is required');
  if (options.apply) {
    if (options.confirm !== CONFIRM_PHRASE) {
      throw new ExcerptLoadRefusal('CONFIRM_PHRASE_MISMATCH', `apply needs the confirm phrase ${CONFIRM_PHRASE} exactly`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(options.expectedFingerprint ?? '')) {
      throw new ExcerptLoadRefusal('MISSING_EXPECTED_FINGERPRINT', 'apply needs the plan_fingerprint printed by the dry run you reviewed');
    }
  }

  // Throws ContentImportRefusal for an unknown organization or an actor who
  // may not load it (platform owner for __platform__, a gym admin member for a gym).
  const actor = await resolveActor(organizationId, actorAccountId);
  options.log(`actor_role: ${actor.role}`);

  const files = await readExcerptFolder(options.dir);
  const plan = await buildLoadPlan({ target: options.target, organizationId, actorAccountId, files });
  for (const line of describePlan(plan)) options.log(line);

  if (!options.apply) {
    options.log('mode: dry-run (nothing written)');
    return { plan, documentsCreated: 0, chunksWritten: 0 };
  }
  if (plan.blocked) {
    throw new ExcerptLoadRefusal('PLAN_BLOCKED', 'the plan has invalid or conflicting files; fix them and dry-run again');
  }
  if (plan.fingerprint !== options.expectedFingerprint) {
    throw new ExcerptLoadRefusal(
      'PLAN_FINGERPRINT_MISMATCH',
      `this run's plan is ${plan.fingerprint}, not the reviewed ${options.expectedFingerprint}; dry-run again and review`,
    );
  }

  const byName = new Map(files.filter((file): file is ParsedExcerptFile => !isInvalid(file)).map((file) => [file.name, file]));
  let documentsCreated = 0;
  let chunksWritten = 0;
  for (const filePlan of plan.files) {
    if (filePlan.createOrdinals.length === 0) continue;
    const file = byName.get(filePlan.name)!;
    let documentId = filePlan.documentId;
    if (!documentId) {
      const document = await createShadowLibraryDocument({
        organizationId,
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        sourceId: file.content.source_id,
        documentName: file.content.document_name,
        contentSha256: file.contentSha256,
        metadata: {
          intake_method: 'licensed_excerpt_loader',
          blob_name: file.name,
          citation: file.content.citation,
          excerpt_count: file.content.excerpts.length,
        },
      });
      documentId = document.document_id;
      documentsCreated += 1;
    }
    for (const ordinal of filePlan.createOrdinals) {
      const excerpt = file.content.excerpts[ordinal];
      await createShadowLibraryChunk({
        organizationId,
        actorAccountId: actor.accountId,
        actorRole: actor.role,
        documentId,
        ordinal,
        textContent: excerpt.text,
        excerptLocator: excerpt.locator,
        metadata: { citation: file.content.citation, blob_name: file.name },
      });
      chunksWritten += 1;
    }
    options.log(`loaded ${filePlan.name}: document ${documentId}, ${filePlan.createOrdinals.length} chunk(s)`);
  }

  const after = await buildLoadPlan({ target: options.target, organizationId, actorAccountId, files });
  const incomplete = after.files.filter((file) => file.status !== 'complete');
  if (incomplete.length > 0) {
    throw new ExcerptLoadRefusal(
      'POSTCONDITION_FAILED',
      `after apply, ${incomplete.map((file) => `${file.name}=${file.status}`).join(', ')} did not read complete`,
    );
  }
  options.log(`applied: ${documentsCreated} document(s), ${chunksWritten} chunk(s); every file reads complete`);
  return { plan, documentsCreated, chunksWritten };
}
