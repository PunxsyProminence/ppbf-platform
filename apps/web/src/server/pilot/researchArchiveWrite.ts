import { getClientCredentialToken } from '../document-intake/auth';

/**
 * THE GOVERNED RESEARCH ARCHIVE WRITE. CREATE-ONLY, NEVER REPLACE.
 *
 * This is deliberately NOT `document-intake/sharepoint.ts`. That helper is the
 * generic intake uploader: it writes to a configurable destination
 * (`SHAREPOINT_FOLDER_PATH`, defaulting to `PPBF/Intake`), it decides no
 * research authority, and -- the reason it cannot be reused here -- it issues a
 * bare `PUT /root:/{path}:/content` with no conflict header. Graph's default
 * behaviour for that call is **replace**. Pointed at the archive, it would
 * silently overwrite a governed original, and the only trace would be a new
 * version on an item nobody was told about.
 *
 * An archive whose writes can replace is not an archive. So this module exists
 * as a separate path with a separate configuration, and the two must not be
 * collapsed into one "upload to SharePoint" helper later: the whole point is
 * that one of them may overwrite and the other may never.
 *
 * WHAT THIS MODULE WILL NOT DO, each stated because the tempting alternative is
 * worse than failing:
 *
 *   - It will not rename around a collision. An automatic `-2` suffix turns a
 *     duplicate into a second original with no recorded relationship between
 *     them, which is exactly the lineage loss the archive exists to prevent.
 *     A collision is returned to the caller as a conflict, with the identity of
 *     the item already there, so lineage can be recorded deliberately.
 *   - It will not delete an archived original because a later database write
 *     failed. The original is the durable artefact; the database row is
 *     re-creatable. Rolling back the wrong one of those is unrecoverable.
 *   - It will not read `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` /
 *     `SHAREPOINT_FOLDER_PATH`. Configuring the generic uploader must never
 *     have the side effect of enabling archive writes.
 */

/** A file upload, not a metadata call: 30s matches the generic uploader. */
const RESEARCH_ARCHIVE_TIMEOUT_MS = 30_000;

/**
 * Create-only. Graph refuses the write with 409 when an item already exists at
 * the path, instead of replacing it.
 *
 * Sent as a query parameter on the content endpoint rather than a header
 * because that is where Graph reads it for a simple upload. It is the guard --
 * not the existence pre-check below, which cannot be one.
 */
const CONFLICT_BEHAVIOR_FAIL = '@microsoft.graph.conflictBehavior=fail';

export interface ResearchArchiveConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Verified 2026-08-24. Punxsy Prominence - Club Operations. */
  readonly siteId: string;
  readonly driveId: string;
  /** The canonical archive root item, carried so it can be recorded on the row. */
  readonly archiveRootItemId: string;
  /** Path of the archive root within the library, e.g. `Research Archive`. */
  readonly archiveRootPath: string;
}

/**
 * The stable identity of one archived original.
 *
 * Structured rather than free-form because every field here answers a question
 * somebody will ask about a document years from now, and a shape that lets one
 * of them be absent is a shape that will have one absent.
 *
 * `webUrl` is the ARCHIVE location. It is not the publisher or DOI URL, and the
 * two must never be conflated: one says where the governed copy lives, the
 * other says where the work was published. A reader who follows the wrong one
 * gets a paywall instead of the artefact, or a stale link instead of the record.
 */
export interface ResearchArchiveIdentity {
  readonly provider: 'sharepoint';
  readonly siteId: string;
  readonly driveId: string;
  readonly itemId: string;
  /** Archive location. NEVER the publisher/DOI source URL. */
  readonly webUrl: string | null;
  readonly archiveRootItemId: string;
  /** R01-R19. Filing, not routing authority: see researchClassification.ts. */
  readonly archiveDomainCode: string;
  readonly originalFilename: string;
  readonly contentSha256: string;
  readonly acquisitionProvider: string;
  readonly acquisitionChannel: string;
  readonly acquiredAt: string;
  readonly duplicateStatus: ResearchArchiveDuplicateStatus;
}

export type ResearchArchiveDuplicateStatus = 'original' | 'duplicate_held' | 'lineage_recorded';

/**
 * Raised when an item already exists at the target path.
 *
 * Carries the existing item's id so the caller can record lineage against the
 * thing that is actually there. A conflict is information, not just a failure:
 * "this original is already archived" is the answer to a duplicate submission.
 */
export class ResearchArchiveConflictError extends Error {
  readonly existingItemId: string | null;

  constructor(message: string, existingItemId: string | null) {
    super(message);
    this.name = 'ResearchArchiveConflictError';
    this.existingItemId = existingItemId;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/');
}

function trimSlashes(value: string): string {
  let output = value;
  while (output.startsWith('/')) output = output.slice(1);
  while (output.endsWith('/')) output = output.slice(0, -1);
  return output;
}

/**
 * Writes one original into the governed archive, or refuses.
 *
 * Returns the identity of what it wrote. Throws ResearchArchiveConflictError if
 * something is already there, and a plain Error for every other failure -- the
 * caller must be able to tell "already archived" from "the archive is broken",
 * because the first is an ordinary duplicate and the second must stop the run.
 *
 * ON THE PRE-CHECK. The existence probe below is NOT the guard, and must not be
 * mistaken for one: between the probe and the write, another writer can create
 * the item, so the probe is a time-of-check-to-time-of-use race by
 * construction. It exists to turn the common case into a clean, cheap refusal
 * that names the existing item -- which the 409 alone does not give us. The
 * actual guarantee is `conflictBehavior=fail` on the write; if Graph ever
 * stopped honouring it, this function would be unsafe no matter what the probe
 * returned, which is why the probe is documented as a convenience rather than
 * relied on.
 */
export async function archiveResearchOriginal(input: {
  config: ResearchArchiveConfig;
  /** Folder under the archive root, e.g. `R19`. Filing, not routing authority. */
  archiveDomainCode: string;
  originalFilename: string;
  contentSha256: string;
  fileBuffer: Buffer;
  acquisitionProvider: string;
  acquisitionChannel: string;
  acquiredAt: string;
}): Promise<ResearchArchiveIdentity> {
  const { config } = input;

  const token = await getClientCredentialToken(
    {
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    'https://graph.microsoft.com/.default',
  );

  const fullPath = `${trimSlashes(config.archiveRootPath)}/${trimSlashes(input.archiveDomainCode)}/${input.originalFilename}`;
  const base = `https://graph.microsoft.com/v1.0/sites/${config.siteId}/drives/${config.driveId}`;
  const itemPath = `${base}/root:/${encodePathSegment(fullPath)}`;

  const existing = await fetch(itemPath, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
  });

  if (existing.ok) {
    const found = (await existing.json()) as { id?: string };
    throw new ResearchArchiveConflictError(
      `An original already exists in the research archive at ${fullPath}. Not overwritten, and not renamed.`,
      found.id ?? null,
    );
  }

  if (existing.status !== 404) {
    const detail = await existing.text();
    throw new Error(`Research archive pre-check failed (${existing.status}): ${detail}`);
  }

  const response = await fetch(`${itemPath}:/content?${CONFLICT_BEHAVIOR_FAIL}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
    },
    body: new Uint8Array(input.fileBuffer),
    signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
  });

  // The guard doing its job. Reached when the item appeared between the probe
  // and the write, which is the race the probe cannot close.
  if (response.status === 409) {
    throw new ResearchArchiveConflictError(
      `An original already exists in the research archive at ${fullPath} (refused by conflictBehavior=fail). Not overwritten, and not renamed.`,
      null,
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Research archive write failed (${response.status}): ${detail}`);
  }

  const payload = (await response.json()) as { id?: string; webUrl?: string };

  if (!payload.id) {
    throw new Error('Research archive write succeeded but returned no item id, so the original cannot be addressed.');
  }

  return {
    provider: 'sharepoint',
    siteId: config.siteId,
    driveId: config.driveId,
    itemId: payload.id,
    webUrl: payload.webUrl ?? null,
    archiveRootItemId: config.archiveRootItemId,
    archiveDomainCode: input.archiveDomainCode,
    originalFilename: input.originalFilename,
    contentSha256: input.contentSha256,
    acquisitionProvider: input.acquisitionProvider,
    acquisitionChannel: input.acquisitionChannel,
    acquiredAt: input.acquiredAt,
    duplicateStatus: 'original',
  };
}
