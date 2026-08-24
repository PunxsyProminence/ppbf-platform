import { createHash } from 'node:crypto';
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
 *     A collision is returned to the caller as a conflict carrying the identity
 *     of the item already there (best-effort when the collision is only
 *     discovered at write time -- see ResearchArchiveConflictError), so lineage
 *     can be recorded deliberately.
 *   - It will not delete an archived original because a later database write
 *     failed. The original is the durable artefact; the database row is
 *     re-creatable. Rolling back the wrong one of those is unrecoverable.
 *   - It will not read `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` /
 *     `SHAREPOINT_FOLDER_PATH`. Configuring the generic uploader must never
 *     have the side effect of enabling archive writes.
 *   - It will not accept a caller-supplied content hash. `contentSha256` is
 *     computed here from the bytes actually uploaded, because the database's
 *     duplicate defence (`unique (organization_id, content_sha256)`) is only as
 *     honest as that value, and a hash the caller computed may describe
 *     different bytes than the ones archived.
 *   - It will not build a Graph path from unvalidated names. A `/`, `\`, or
 *     dot segment in a filename would aim the write outside the archive folder
 *     -- URL normalization collapses `..` segments, so `../../evil.pdf` lands
 *     at the DRIVE ROOT -- while the returned identity still claimed the
 *     domain folder. Both names are checked against conservative allowlists
 *     before any network call.
 */

/** A file upload, not a metadata call: 30s matches the generic uploader. */
const RESEARCH_ARCHIVE_TIMEOUT_MS = 30_000;

/**
 * Create-only. Graph refuses the write with 409 `nameAlreadyExists` when an
 * item already exists at the path, instead of replacing it.
 *
 * Sent as a query parameter on the content endpoint rather than a header
 * because that is where Graph reads it for a simple upload. It is the guard --
 * not the existence pre-check below, which cannot be one.
 */
const CONFLICT_BEHAVIOR_FAIL = '@microsoft.graph.conflictBehavior=fail';

/**
 * Graph's machine-readable code for "an item with this name is already there".
 *
 * A 409 STATUS ALONE IS NOT THAT. Graph also answers 409 when the specified
 * parent folder does not exist and on concurrency violations (e.g.
 * `resourceModified`, `Directory_ConcurrencyViolation`). Classifying every 409
 * as a duplicate would let a missing domain folder be recorded as "this
 * original is already archived" while nothing was archived at all -- so only
 * this code is a conflict, and every other 409 is a failed write.
 */
const GRAPH_NAME_ALREADY_EXISTS = 'nameAlreadyExists';

/**
 * Conservative allowlists, not denylists: anything that is not obviously a
 * bare PDF name / bare R-code is refused. The filename must start with a
 * letter or digit (which excludes `.` and `..` outright), may contain only
 * letters, digits, dot, underscore, space, and hyphen, and must end in `.pdf`.
 */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}\.pdf$/i;
const SAFE_DOMAIN_CODE = /^R\d{2}$/;

function assertSafeArchiveNames(archiveDomainCode: string, originalFilename: string): void {
  if (!SAFE_DOMAIN_CODE.test(archiveDomainCode)) {
    throw new Error(
      `Refusing research archive write: archive domain code ${JSON.stringify(archiveDomainCode)} is not a bare R-code such as "R19". A path-shaped code could aim the write outside the archive.`,
    );
  }
  if (originalFilename.length === 0) {
    throw new Error('Refusing research archive write: the original filename is empty.');
  }
  if (/[/\\]/.test(originalFilename)) {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(originalFilename)} contains a path separator. A separator would let the write escape its archive folder -- URL normalization turns "../" segments into a write at the drive root.`,
    );
  }
  if (originalFilename === '.' || originalFilename === '..') {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(originalFilename)} is a relative path segment, not a name.`,
    );
  }
  if (!SAFE_FILENAME.test(originalFilename)) {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(originalFilename)} does not match the conservative allowlist (a plain PDF name: letters, digits, dot, underscore, space, hyphen; starting with a letter or digit; ending in .pdf).`,
    );
  }
}

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
  /**
   * Computed by this module from the bytes it actually uploaded. Never
   * caller-supplied: the duplicate defence in the database is only as honest
   * as this value.
   */
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
 * thing that is actually there. The id is best-effort on the race branch: when
 * the collision is only discovered by the write-time 409, the id comes from a
 * follow-up lookup, and if that lookup fails the id is null and the message
 * says so. A conflict is information, not just a failure: "this original is
 * already archived" is the answer to a duplicate submission.
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
 * Returns the identity of what it wrote. Throws ResearchArchiveConflictError
 * if something is already there, and a plain Error for every other failure --
 * the caller must be able to tell "already archived" from "the archive is
 * broken", because the first is an ordinary duplicate and the second must stop
 * the run. That distinction is made on Graph's error CODE, not its status: a
 * 409 is a conflict only when Graph says `nameAlreadyExists`; a 409 for a
 * missing parent folder or a concurrency violation is a failed write.
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
  /** Folder under the archive root. Must be a bare R-code, e.g. `R19`. */
  archiveDomainCode: string;
  /** Must be a bare PDF filename: no separators, no dot segments. */
  originalFilename: string;
  fileBuffer: Buffer;
  acquisitionProvider: string;
  acquisitionChannel: string;
  acquiredAt: string;
}): Promise<ResearchArchiveIdentity> {
  const { config } = input;

  // Before any network call, the token fetch included: a rejected name must
  // leave no trace anywhere.
  assertSafeArchiveNames(input.archiveDomainCode, input.originalFilename);

  // Computed here, never accepted from the caller: see the module contract.
  const contentSha256 = createHash('sha256').update(input.fileBuffer).digest('hex');

  const token = await getClientCredentialToken(
    {
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    'https://graph.microsoft.com/.default',
  );

  const fullPath = `${trimSlashes(config.archiveRootPath)}/${input.archiveDomainCode}/${input.originalFilename}`;
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

  if (response.status === 409) {
    const detail = await response.text();
    let graphCode: string | null = null;
    try {
      const parsed = JSON.parse(detail) as { error?: { code?: string } };
      graphCode = parsed.error?.code ?? null;
    } catch {
      graphCode = null;
    }

    if (graphCode !== GRAPH_NAME_ALREADY_EXISTS) {
      // Not a duplicate. Graph answers 409 for a missing parent folder and
      // for concurrency violations too; recording those as "already archived"
      // would claim a duplicate while nothing was archived.
      throw new Error(
        `Research archive write failed (409${graphCode === null ? ', no error code' : ` ${graphCode}`}): ${detail}`,
      );
    }

    // The guard doing its job: the item appeared between the probe and the
    // write, which is the race the probe cannot close. The 409 does not carry
    // the existing item's id, so fetch it -- best-effort, because the refusal
    // stands whether or not the lookup succeeds.
    let existingItemId: string | null = null;
    try {
      const lookup = await fetch(itemPath, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
      });
      if (lookup.ok) {
        const found = (await lookup.json()) as { id?: string };
        existingItemId = found.id ?? null;
      }
    } catch {
      existingItemId = null;
    }

    throw new ResearchArchiveConflictError(
      `An original already exists in the research archive at ${fullPath} (refused by conflictBehavior=fail). Not overwritten, and not renamed.${
        existingItemId === null
          ? " The existing item's id could not be fetched after the refusal; lineage must be recorded by path."
          : ''
      }`,
      existingItemId,
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
    contentSha256,
    acquisitionProvider: input.acquisitionProvider,
    acquisitionChannel: input.acquisitionChannel,
    acquiredAt: input.acquiredAt,
    duplicateStatus: 'original',
  };
}
