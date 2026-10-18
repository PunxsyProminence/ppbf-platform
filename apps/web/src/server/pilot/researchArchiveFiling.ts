import { createHash, randomUUID } from 'node:crypto';

import { researchClassificationArchiveCode } from '@/src/shared/researchClassification';

import { queryOne } from './db';
import { ConflictError, ForbiddenError, NotFoundError, PilotError, ValidationError } from './errors';
import { LIBRARY_PDF_MAX_BYTES, hasPdfSignature } from './libraryPdfText';
import {
  ResearchArchiveConflictError,
  archiveFilenameFor,
  archiveResearchOriginal,
  readArchivedOriginal,
  resolveArchiveDomainFolder,
  type ResearchArchiveConfig,
  type ResearchArchiveIdentity,
} from './researchArchiveWrite';

/**
 * Files one research PDF in the SharePoint Research Archive and records where
 * it went (issue #345; lane L57). The record is a row of
 * pilot.shadow_library_archived_originals; the PDF itself stays in SharePoint
 * and nowhere else (OD-2026-10-02-013 answer 4A).
 *
 * THE ORDER, AND WHY. Database first, archive second, database third:
 *   1. The same bytes already recorded for this shelf -> "already filed", and
 *      Graph is not called at all. A retried upload files nothing twice.
 *   2. The archive write, create-only. If the filed name is already taken --
 *      an earlier request filed the file and then failed before step 3 -- the
 *      item is read back and hashed: the same bytes are recorded as they are,
 *      different bytes are refused. The filed name embeds the hash, so the
 *      second case means a real clash, not a common file name.
 *   3. The row. A concurrent upload of the same PDF that won the race is found
 *      by the unique key and returned instead.
 * A failure after step 2 never deletes the filed original: the file is the
 * durable artefact, and the next attempt records it through the read-back.
 *
 * CUSTODY IS NOT APPROVAL. Filing changes nothing about the source's review
 * state; the archive copy is not evidence (docs/SHADOW_RESEARCH_ARCHITECTURE.md
 * section 3, researchArchiveGating.pg.test.ts).
 *
 * WHO FILES. Only the shelves named in RESEARCH_ARCHIVE_ORGANIZATION_IDS: the
 * archive is PPBF's own SharePoint, and other gyms on the platform have admins
 * who pass the same curator gate.
 *
 * THE FOLDER COMES FROM THE SOURCE'S SUBJECT. A source's classification_domain
 * maps to its R-code (researchClassification.ts archiveCode); an unclassified
 * source is refused rather than filed in a guessed folder. Reclassifying later
 * does not move the file.
 */

export const ARCHIVE_ACQUISITION_CHANNELS = [
  'library_database',
  'publisher_site',
  'open_access_repository',
  'author_copy',
  'ppbf_created',
  'other',
] as const;
export type ArchiveAcquisitionChannel = (typeof ARCHIVE_ACQUISITION_CHANNELS)[number];

/** NISO Journal Article Versions (RP-8-2008), the ones a curator can tell apart. */
export const ARCHIVE_VERSION_KINDS = [
  'author_original',
  'accepted_manuscript',
  'version_of_record',
  'corrected_version_of_record',
  'other',
  'unknown',
] as const;
export type ArchiveVersionKind = (typeof ARCHIVE_VERSION_KINDS)[number];

export interface ArchivedOriginalRow {
  archived_original_id: string;
  organization_id: string;
  source_id: string;
  provider: 'sharepoint';
  site_id: string;
  drive_id: string;
  item_id: string;
  web_url: string | null;
  archive_root_item_id: string;
  archive_domain_code: string;
  archive_filename: string;
  original_filename: string;
  content_sha256: string;
  byte_size: string;
  acquisition_provider: string;
  acquisition_channel: ArchiveAcquisitionChannel;
  acquired_at: Date;
  version_kind: ArchiveVersionKind;
  supersedes_archived_original_id: string | null;
  created_by_account_id: string;
  created_by_role: string;
  created_at: Date;
}

export interface FileResearchOriginalInput {
  config: ResearchArchiveConfig;
  /** The organizations whose shelves may file in this archive (researchArchiveConfig.ts). */
  filingOrganizationIds: readonly string[];
  /** The shelf: the gym's organization, or the platform shelf. */
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  sourceId: string;
  originalFilename: string;
  fileBytes: Uint8Array;
  acquisitionProvider: string;
  acquisitionChannel: string;
  /** ISO date or timestamp; when PPBF obtained the file. Defaults to now. */
  acquiredAt?: string | null;
  versionKind?: string | null;
  supersedesArchivedOriginalId?: string | null;
  now?: () => Date;
}

export type FileResearchOriginalResult =
  | { status: 'filed'; original: ArchivedOriginalRow }
  | { status: 'already_filed'; original: ArchivedOriginalRow };

const ACQUIRED_AT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_OR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
// Text that cannot be stored or would display misleadingly: Postgres text holds
// no NUL, and no C0/C1 control or bidirectional override belongs in a name.
function hasControlCharacter(value: string): boolean {
  // Code points, not a regex: the lint rules refuse control characters in a
  // pattern, and these bidi overrides are invisible in source.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return true;
    }
  }
  return false;
}

/**
 * An ISO date or timestamp, and only one that means what it says. `new Date`
 * alone reads "1" as 2001 and rolls 2026-02-30 into March; a date recorded as
 * provenance must be the one the curator meant, or be refused.
 */
function parseAcquiredAt(value: string): Date | null {
  const match = ISO_DATE_OR_TIMESTAMP.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const parsed = value.length === 10 ? calendar : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function validate(input: FileResearchOriginalInput, now: Date) {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new ValidationError('Choose the Library source this PDF belongs to.', 'ARCHIVE_SOURCE_REQUIRED');

  const originalFilename = input.originalFilename.trim();
  if (originalFilename.length < 1 || originalFilename.length > 255 || hasControlCharacter(originalFilename)) {
    throw new ValidationError('The PDF needs a plain file name of 1 to 255 characters.', 'ARCHIVE_FILENAME_INVALID');
  }

  const acquisitionProvider = input.acquisitionProvider.trim();
  if (acquisitionProvider.length < 1 || acquisitionProvider.length > 200 || hasControlCharacter(acquisitionProvider)) {
    throw new ValidationError('Say where the PDF came from (1 to 200 characters).', 'ARCHIVE_PROVIDER_INVALID');
  }
  if (!isOneOf(ARCHIVE_ACQUISITION_CHANNELS, input.acquisitionChannel)) {
    throw new ValidationError('Choose how the PDF was obtained.', 'ARCHIVE_CHANNEL_INVALID');
  }
  const versionKind = input.versionKind ?? 'unknown';
  if (!isOneOf(ARCHIVE_VERSION_KINDS, versionKind)) {
    throw new ValidationError('Choose which version of the work this PDF is.', 'ARCHIVE_VERSION_INVALID');
  }

  let acquiredAt = now;
  if (input.acquiredAt !== undefined && input.acquiredAt !== null && input.acquiredAt.trim() !== '') {
    const parsed = parseAcquiredAt(input.acquiredAt.trim());
    if (!parsed || parsed.getTime() > now.getTime() + ACQUIRED_AT_FUTURE_SLACK_MS) {
      throw new ValidationError('The date the PDF was obtained is not a valid past date (YYYY-MM-DD).', 'ARCHIVE_ACQUIRED_AT_INVALID');
    }
    acquiredAt = parsed;
  }

  const bytes = input.fileBytes;
  if (bytes.length === 0) throw new ValidationError('That file is empty.', 'ARCHIVE_FILE_EMPTY');
  if (bytes.length > LIBRARY_PDF_MAX_BYTES) {
    throw new PilotError(413, 'PDFs up to 10 MB.', 'ARCHIVE_FILE_TOO_LARGE');
  }
  if (!hasPdfSignature(bytes)) throw new ValidationError('That file is not a PDF.', 'NOT_A_PDF');

  const supersedes = input.supersedesArchivedOriginalId?.trim() || null;

  return {
    sourceId,
    originalFilename,
    acquisitionProvider,
    acquisitionChannel: input.acquisitionChannel,
    versionKind,
    acquiredAt,
    supersedes,
  };
}

async function findBySha(organizationId: string, contentSha256: string): Promise<ArchivedOriginalRow | null> {
  return queryOne<ArchivedOriginalRow>(
    `select * from pilot.shadow_library_archived_originals
      where organization_id = $1 and content_sha256 = $2`,
    [organizationId, contentSha256],
  );
}

function alreadyFiled(existing: ArchivedOriginalRow, sourceId: string): FileResearchOriginalResult {
  if (existing.source_id !== sourceId) {
    throw new ConflictError(
      'This PDF is already filed in the Research Archive for another Library source.',
      'ARCHIVE_ORIGINAL_OTHER_SOURCE',
    );
  }
  return { status: 'already_filed', original: existing };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === constraint
  );
}

/** Archive I/O failed: what the curator is told, with the cause kept for the server log. */
function archiveUnavailable(cause: unknown): PilotError {
  // Not "nothing was filed": a write can land and its answer be lost. A retry
  // with the same file finds it by its hash and records it.
  const error = new PilotError(
    502,
    'The Research Archive did not confirm the filing. Try again with the same file.',
    'ARCHIVE_UNAVAILABLE',
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

async function archiveOrRecover(
  config: ResearchArchiveConfig,
  archiveDomainCode: string,
  archiveFilename: string,
  bytes: Buffer,
  contentSha256: string,
): Promise<ResearchArchiveIdentity> {
  try {
    return await archiveResearchOriginal({ config, archiveDomainCode, archiveFilename, fileBuffer: bytes });
  } catch (error) {
    if (!(error instanceof ResearchArchiveConflictError)) throw archiveUnavailable(error);
    if (error.existingItemId === null) throw archiveUnavailable(error);

    let recovered;
    let folder;
    try {
      folder = await resolveArchiveDomainFolder(config, await config.getAccessToken(), archiveDomainCode);
      recovered = await readArchivedOriginal({
        config,
        itemId: error.existingItemId,
        expectedFolderItemId: folder.id,
        maxBytes: LIBRARY_PDF_MAX_BYTES,
      });
    } catch (readError) {
      throw archiveUnavailable(readError);
    }
    if (recovered.contentSha256 !== contentSha256) {
      throw new ConflictError(
        'A different file already has this name in the Research Archive. Nothing was filed or changed.',
        'ARCHIVE_NAME_TAKEN',
      );
    }
    return {
      provider: 'sharepoint',
      siteId: config.siteId,
      driveId: config.driveId,
      itemId: recovered.itemId,
      webUrl: recovered.webUrl,
      archiveRootItemId: config.archiveRootItemId,
      archiveDomainCode,
      archiveFolderItemId: folder.id,
      archiveFilename: recovered.name,
      contentSha256: recovered.contentSha256,
      byteSize: recovered.bytes.length,
    };
  }
}

export async function fileResearchOriginal(input: FileResearchOriginalInput): Promise<FileResearchOriginalResult> {
  // The nonprofit's own SharePoint: another gym's admin passes the curator gate
  // but does not file here. Refused before anything is read or called.
  if (!input.filingOrganizationIds.includes(input.organizationId)) {
    throw new ForbiddenError('This shelf does not file originals in the Research Archive.', 'ARCHIVE_ORGANIZATION_NOT_ALLOWED');
  }
  const now = (input.now ?? (() => new Date()))();
  const valid = validate(input, now);
  const bytes = Buffer.from(input.fileBytes);
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');

  // 1. Already recorded on this shelf: no Graph call.
  const existing = await findBySha(input.organizationId, contentSha256);
  if (existing) return alreadyFiled(existing, valid.sourceId);

  const source = await queryOne<{ classification_domain: string | null }>(
    `select metadata->>'classification_domain' as classification_domain
       from pilot.shadow_library_sources
      where source_id = $1 and organization_id = $2`,
    [valid.sourceId, input.organizationId],
  );
  if (!source) throw new NotFoundError('That Library source was not found on this shelf.', 'SOURCE_NOT_FOUND');
  const archiveDomainCode = source.classification_domain
    ? researchClassificationArchiveCode(source.classification_domain)
    : null;
  if (!archiveDomainCode) {
    throw new ConflictError(
      "Classify this source first: its subject decides the Research Archive folder.",
      'SOURCE_NOT_CLASSIFIED',
    );
  }

  if (valid.supersedes) {
    const earlier = await queryOne<{ archived_original_id: string }>(
      `select archived_original_id from pilot.shadow_library_archived_originals
        where archived_original_id = $1 and source_id = $2 and organization_id = $3`,
      [valid.supersedes, valid.sourceId, input.organizationId],
    );
    if (!earlier) {
      throw new ValidationError(
        'The version this PDF replaces must be an original already filed for the same source.',
        'ARCHIVE_SUPERSEDES_INVALID',
      );
    }
  }

  // 2. The archive.
  const identity = await archiveOrRecover(
    input.config,
    archiveDomainCode,
    archiveFilenameFor(valid.originalFilename, contentSha256),
    bytes,
    contentSha256,
  );

  // 3. The row.
  try {
    const row = await queryOne<ArchivedOriginalRow>(
      `insert into pilot.shadow_library_archived_originals
         (archived_original_id, organization_id, source_id, provider, site_id, drive_id, item_id, web_url,
          archive_root_item_id, archive_domain_code, archive_filename, original_filename, content_sha256,
          byte_size, acquisition_provider, acquisition_channel, acquired_at, version_kind,
          supersedes_archived_original_id, created_by_account_id, created_by_role)
       values ($1, $2, $3, 'sharepoint', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       returning *`,
      [
        `arc_${randomUUID()}`,
        input.organizationId,
        valid.sourceId,
        identity.siteId,
        identity.driveId,
        identity.itemId,
        // The table holds archive links to https only; anything else is recorded as no link
        // rather than failing the row after the original is already filed.
        identity.webUrl?.startsWith('https://') ? identity.webUrl : null,
        identity.archiveRootItemId,
        identity.archiveDomainCode,
        identity.archiveFilename,
        valid.originalFilename,
        identity.contentSha256,
        identity.byteSize,
        valid.acquisitionProvider,
        valid.acquisitionChannel,
        valid.acquiredAt.toISOString(),
        valid.versionKind,
        valid.supersedes,
        input.actorAccountId,
        input.actorRole,
      ],
    );
    if (!row) throw new Error('The archived original was not recorded.');
    return { status: 'filed', original: row };
  } catch (error) {
    // A lost race: the other request recorded these bytes (and, after a
    // read-back, the same item) first. Postgres reports whichever key it
    // checked first, so either one means the same thing.
    if (
      isUniqueViolation(error, 'pilot_shadow_library_archived_originals_org_sha_key')
      || isUniqueViolation(error, 'pilot_shadow_library_archived_originals_org_item_key')
    ) {
      const winner = await findBySha(input.organizationId, contentSha256);
      if (winner) return alreadyFiled(winner, valid.sourceId);
      throw new ConflictError(
        'That Research Archive item is already recorded for different bytes on this shelf. Nothing new was recorded.',
        'ARCHIVE_ITEM_ALREADY_RECORDED',
      );
    }
    throw error;
  }
}
