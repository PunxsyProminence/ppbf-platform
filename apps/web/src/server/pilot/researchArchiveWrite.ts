import { createHash } from 'node:crypto';

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
 * HOW IT FINDS THE FOLDER. The archive's subject folders are named
 * `R19 - Measurement and Assessment Instruments` and so on (read from the live
 * archive 2026-10-17). An earlier version of this module wrote to the PATH
 * `Research Archive/R19/<file>`, which names a folder that does not exist: the
 * write either failed or started a second, bare `R19` tree inside the archive.
 * Now every address is an ITEM ID: the subject folder is the one child of the
 * verified archive root item whose name starts `R19 - `, and the file is
 * created under that folder's id. Nothing here creates a folder, so a missing
 * or doubled subject folder stops the write instead of improvising one.
 *
 * HOW IT SIGNS IN. With a token the caller supplies: in production the
 * container app's own managed identity (managedIdentityToken.ts), which needs
 * no secret. Jason grants that identity write on the Research Archive folder
 * only (Graph `ListItems.SelectedOperations.Selected`, lane L57 plan section 4).
 *
 * WHAT THIS MODULE WILL NOT DO, each stated because the tempting alternative is
 * worse than failing:
 *
 *   - It will not rename around a collision. An automatic `-2` suffix turns a
 *     duplicate into a second original with no recorded relationship between
 *     them, which is exactly the lineage loss the archive exists to prevent.
 *     A collision is returned to the caller as a conflict carrying the identity
 *     of the item already there (best-effort when the collision is only
 *     discovered at write time -- see ResearchArchiveConflictError), so the
 *     caller can check whether it holds the same bytes.
 *   - It will not delete an archived original because a later database write
 *     failed. The original is the durable artefact; the database row is
 *     re-creatable. Rolling back the wrong one of those is unrecoverable.
 *   - It will not read `SHAREPOINT_SITE_ID` / `SHAREPOINT_DRIVE_ID` /
 *     `SHAREPOINT_FOLDER_PATH`. Configuring the generic uploader must never
 *     have the side effect of enabling archive writes.
 *   - It will not accept a caller-supplied content hash. `contentSha256` is
 *     computed here from the bytes actually uploaded, because the database's
 *     duplicate defence (`unique (organization_id, content_sha256)`) is only as
 *     honest as that value.
 *   - It will not file into R00 (Unsorted Drop), R98 (Duplicate Hold) or any
 *     code outside R01-R19. Those two are archive workflow states, not
 *     subjects (#345), and the database refuses them too.
 *   - It will not build a Graph address from unvalidated names. Both names are
 *     checked against conservative allowlists before any network call, the
 *     token included.
 */

/** A file upload, not a metadata call: 30s matches the generic uploader. */
const RESEARCH_ARCHIVE_TIMEOUT_MS = 30_000;

/**
 * Create-only. Graph refuses the write with 409 `nameAlreadyExists` when an
 * item already exists at the name, instead of replacing it.
 *
 * Sent as a query parameter on the content endpoint rather than a header
 * because that is where Graph reads it for a simple upload. It is the guard --
 * not the existence pre-check below, which cannot be one.
 */
const CONFLICT_BEHAVIOR_FAIL = '@microsoft.graph.conflictBehavior=fail';

/**
 * Graph's machine-readable code for "an item with this name is already there".
 *
 * A 409 STATUS ALONE IS NOT THAT. Graph also answers 409 on concurrency
 * violations (e.g. `resourceModified`). Classifying every 409 as a duplicate
 * would let a failed write be recorded as "this original is already archived"
 * while nothing was archived at all -- so only this code is a conflict, and
 * every other 409 is a failed write.
 */
const GRAPH_NAME_ALREADY_EXISTS = 'nameAlreadyExists';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';

/** The root holds 22 children today; a listing this long means something else is wrong. */
const MAX_ROOT_LISTING_PAGES = 10;
/** A subject folder is read in full before a write; 25 pages of 200 is 5,000 originals. */
const MAX_SUBJECT_LISTING_PAGES = 25;

/**
 * Conservative allowlists, not denylists: anything that is not obviously a
 * bare PDF name / a subject R-code is refused. The filename must start with a
 * letter or digit (which excludes `.` and `..` outright), may contain only
 * letters, digits, dot, underscore, space, and hyphen, and must end in `.pdf`.
 * The database holds the filed name to the same pattern
 * (pilot_shadow_library_archived_originals_filename_check).
 */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}\.pdf$/i;
const SAFE_DOMAIN_CODE = /^R(0[1-9]|1[0-9])$/;

function assertSafeArchiveNames(archiveDomainCode: string, archiveFilename: string): void {
  if (!SAFE_DOMAIN_CODE.test(archiveDomainCode)) {
    throw new Error(
      `Refusing research archive write: archive domain code ${JSON.stringify(archiveDomainCode)} is not a subject code R01-R19. R00 and R98 are archive workflow states, and a path-shaped code could aim the write outside the archive.`,
    );
  }
  if (archiveFilename.length === 0) {
    throw new Error('Refusing research archive write: the filename is empty.');
  }
  if (/[/\\]/.test(archiveFilename)) {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(archiveFilename)} contains a path separator, which would let the write escape its archive folder.`,
    );
  }
  if (archiveFilename === '.' || archiveFilename === '..') {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(archiveFilename)} is a relative path segment, not a name.`,
    );
  }
  if (!SAFE_FILENAME.test(archiveFilename)) {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(archiveFilename)} does not match the conservative allowlist (a plain PDF name: letters, digits, dot, underscore, space, hyphen; starting with a letter or digit; ending in .pdf).`,
    );
  }
}

/**
 * The name an original is filed under: the curator's file name cleaned to the
 * allowlist, then `--` and the first 12 hex characters of its sha-256.
 *
 * Deterministic on purpose. Two different PDFs that happen to share a name get
 * different filed names, so a name clash in the archive means "these bytes are
 * probably already there" -- which the caller then checks by hash -- rather
 * than "somebody else's paper.pdf".
 */
export function archiveFilenameFor(originalFilename: string, contentSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error('archiveFilenameFor needs the lowercase hex sha-256 of the bytes being filed.');
  }
  const baseName = originalFilename.split(/[/\\]/).pop() ?? '';
  const stem = baseName
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    // SharePoint refuses any name containing _vti_ (its reserved folder prefix).
    .replace(/_vti_/gi, '_vti-')
    .slice(0, 150)
    .replace(/[ ._-]+$/, '');
  return `${stem || 'original'}--${contentSha256.slice(0, 12)}.pdf`;
}

export interface ResearchArchiveConfig {
  /** Verified 2026-08-24. Punxsy Prominence - Club Operations. */
  readonly siteId: string;
  readonly driveId: string;
  /** The verified `Research Archive` root item; every address starts here. */
  readonly archiveRootItemId: string;
  /** A Microsoft Graph token. In production: the app's managed identity, never a client secret. */
  readonly getAccessToken: () => Promise<string>;
}

/**
 * The stable identity of one archived original.
 *
 * `webUrl` is the ARCHIVE location. It is not the publisher or DOI URL, and the
 * two must never be conflated: one says where the governed copy lives, the
 * other says where the work was published.
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
  readonly archiveFolderItemId: string;
  readonly archiveFilename: string;
  /** Computed by this module from the bytes it uploaded (or, on recovery, downloaded). */
  readonly contentSha256: string;
  readonly byteSize: number;
}

/**
 * Raised when an item already exists at the target name.
 *
 * Carries the existing item's id so the caller can check what is actually
 * there. The id is best-effort on the race branch: when the collision is only
 * discovered by the write-time 409, the id comes from a follow-up lookup, and
 * if that lookup fails the id is null and the message says so.
 */
export class ResearchArchiveConflictError extends Error {
  readonly existingItemId: string | null;

  constructor(message: string, existingItemId: string | null) {
    super(message);
    this.name = 'ResearchArchiveConflictError';
    this.existingItemId = existingItemId;
  }
}

function driveBase(config: ResearchArchiveConfig): string {
  return `${GRAPH_ORIGIN}/v1.0/sites/${config.siteId}/drives/${config.driveId}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  folder?: unknown;
  parentReference?: { id?: string };
}

/**
 * Every child of one archive folder, read to the end or refused: a choice made
 * from a partial list is a guess. Each next page is fetched with the bearer
 * token, so it must be Microsoft Graph itself.
 */
async function listChildren(
  config: ResearchArchiveConfig,
  token: string,
  parentItemId: string,
  label: string,
  maxPages: number,
): Promise<GraphDriveItem[]> {
  const items: GraphDriveItem[] = [];
  let next: string | null = `${driveBase(config)}/items/${parentItemId}/children?$select=id,name,folder,parentReference&$top=200`;
  for (let page = 0; next !== null; page += 1) {
    if (page === maxPages) {
      throw new Error(`Research archive ${label} listing did not end; refusing to act on a partial list.`);
    }
    const response = await fetch(next, {
      method: 'GET',
      headers: bearer(token),
      signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Research archive ${label} listing failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as { value?: GraphDriveItem[]; '@odata.nextLink'?: string };
    items.push(...(payload.value ?? []));
    next = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null;
    if (next !== null && new URL(next).origin !== GRAPH_ORIGIN) {
      throw new Error(`Research archive ${label} listing pointed its next page outside Microsoft Graph; refusing to follow it.`);
    }
  }
  return items;
}

/**
 * The one subject folder for `archiveDomainCode`: a FOLDER directly under the
 * archive root whose name starts with the code and ` - `. Zero or several such
 * folders is a refusal, never a guess and never a new folder.
 */
export async function resolveArchiveDomainFolder(
  config: ResearchArchiveConfig,
  token: string,
  archiveDomainCode: string,
): Promise<{ id: string; name: string }> {
  if (!SAFE_DOMAIN_CODE.test(archiveDomainCode)) {
    throw new Error(`Refusing research archive lookup: ${JSON.stringify(archiveDomainCode)} is not a subject code R01-R19.`);
  }
  const prefix = `${archiveDomainCode} - `;
  const children = await listChildren(config, token, config.archiveRootItemId, 'root', MAX_ROOT_LISTING_PAGES);
  const matches = children
    .filter(
      (item): item is GraphDriveItem & { id: string; name: string } =>
        typeof item.id === 'string'
        && typeof item.name === 'string'
        && item.folder != null
        && item.name.startsWith(prefix)
        && (item.parentReference?.id === undefined || item.parentReference.id === config.archiveRootItemId),
    )
    .map((item) => ({ id: item.id, name: item.name }));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `The research archive has no "${prefix}..." folder under its root. Nothing was filed, and no folder was created.`
        : `The research archive has ${matches.length} "${prefix}..." folders under its root (${matches.map((m) => JSON.stringify(m.name)).join(', ')}). Nothing was filed.`,
    );
  }
  return matches[0];
}

/**
 * Writes one original into the governed archive, or refuses.
 *
 * Returns the identity of what it wrote. Throws ResearchArchiveConflictError
 * if something is already there under that name, and a plain Error for every
 * other failure -- the caller must be able to tell "already archived" from "the
 * archive is broken", because the first is an ordinary duplicate and the second
 * must stop the run. That distinction is made on Graph's error CODE, not its
 * status.
 *
 * ON THE PRE-CHECK. Before the write, the subject folder is read in full and
 * refused as a conflict if it holds the same name OR any name ending in the
 * same `--<sha12>.pdf`: the same bytes filed earlier under a curator's other
 * file name (a retry after a failed record, say) are found and checked by the
 * caller, rather than filed a second time. The scan is NOT the guard: between
 * it and the write another writer can create the item. The guard against
 * overwriting is `conflictBehavior=fail` on the write, and it guards only the
 * exact name.
 *
 * WHERE A SECOND COPY CAN STILL BE FILED, said so nobody relies on more: two
 * uploads of the same bytes at the same moment under different curator file
 * names (both scans see nothing; the database keeps one row and the other copy
 * stays, never deleted); the same bytes filed for sources in different subject
 * folders, since only the target folder is read; and an original hand-filed
 * under a name without `--<sha12>.pdf` (SharePoint business drives expose only
 * quickXorHash, so a hash scan would mean computing that here).
 */
export async function archiveResearchOriginal(input: {
  config: ResearchArchiveConfig;
  /** A subject code, R01-R19. */
  archiveDomainCode: string;
  /** A bare PDF filename ending in "--<sha12 of these bytes>.pdf": build it with archiveFilenameFor. */
  archiveFilename: string;
  fileBuffer: Buffer;
}): Promise<ResearchArchiveIdentity> {
  const { config } = input;

  // Before any network call, the token fetch included: a rejected name must
  // leave no trace anywhere.
  assertSafeArchiveNames(input.archiveDomainCode, input.archiveFilename);

  // Computed here, never accepted from the caller: see the module contract.
  const contentSha256 = createHash('sha256').update(input.fileBuffer).digest('hex');

  // The filed name must carry THESE bytes' hash (archiveFilenameFor). A name
  // whose suffix came from other bytes would hide this copy from the
  // same-bytes scan below on every later retry, which would then file a second.
  const sameBytes = `--${contentSha256.slice(0, 12)}.pdf`;
  if (!input.archiveFilename.toLowerCase().endsWith(sameBytes)) {
    throw new Error(
      `Refusing research archive write: filename ${JSON.stringify(input.archiveFilename)} does not end in the hash of these bytes ("${sameBytes}"). Build it with archiveFilenameFor.`,
    );
  }

  const token = await config.getAccessToken();
  const folder = await resolveArchiveDomainFolder(config, token, input.archiveDomainCode);
  const itemPath = `${driveBase(config)}/items/${folder.id}:/${encodeURIComponent(input.archiveFilename)}`;

  // SharePoint names are case-insensitive.
  const sameName = input.archiveFilename.toLowerCase();
  const existing = (await listChildren(config, token, folder.id, 'subject folder', MAX_SUBJECT_LISTING_PAGES)).find(
    (item) =>
      typeof item.name === 'string'
      // Absent or null both mean "not a folder": a file is never skipped.
      && item.folder == null
      && (item.name.toLowerCase() === sameName || item.name.toLowerCase().endsWith(sameBytes)),
  );
  if (existing) {
    throw new ResearchArchiveConflictError(
      `An original already exists in the research archive at ${folder.name}/${String(existing.name)}. Not overwritten, and not renamed.`,
      existing.id ?? null,
    );
  }

  const response = await fetch(`${itemPath}:/content?${CONFLICT_BEHAVIOR_FAIL}`, {
    method: 'PUT',
    headers: { ...bearer(token), 'Content-Type': 'application/pdf' },
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
      throw new Error(
        `Research archive write failed (409${graphCode === null ? ', no error code' : ` ${graphCode}`}): ${detail}`,
      );
    }

    // The guard doing its job: the item appeared between the probe and the
    // write. The 409 does not carry the existing item's id, so fetch it --
    // best-effort, because the refusal stands whether or not the lookup works.
    let existingItemId: string | null = null;
    try {
      const lookup = await fetch(itemPath, {
        method: 'GET',
        headers: bearer(token),
        signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
      });
      if (lookup.ok) {
        const found = (await lookup.json()) as GraphDriveItem;
        existingItemId = found.id ?? null;
      }
    } catch {
      existingItemId = null;
    }

    throw new ResearchArchiveConflictError(
      `An original already exists in the research archive at ${folder.name}/${input.archiveFilename} (refused by conflictBehavior=fail). Not overwritten, and not renamed.${
        existingItemId === null ? " The existing item's id could not be fetched after the refusal." : ''
      }`,
      existingItemId,
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Research archive write failed (${response.status}): ${detail}`);
  }
  // A heuristic, not a replacement detector: a create answers 201, and
  // anything else from a create-only write is unexpected, so it is not
  // recorded as filed. (Microsoft's own examples answer 201 for a replace too,
  // so a 201 proves nothing about conflictBehavior; the supervised proof in
  // production checks a second PUT to the same name is refused 409.) A fresh
  // create that ever answered 200 would fail closed: the retry finds the file
  // and records it through the read-back.
  if (response.status !== 201) {
    throw new Error(`Research archive write answered ${response.status}, not 201 Created. Not recorded.`);
  }

  const payload = (await response.json()) as GraphDriveItem;

  if (!payload.id) {
    throw new Error('Research archive write succeeded but returned no item id, so the original cannot be addressed.');
  }
  if (payload.parentReference?.id !== undefined && payload.parentReference.id !== folder.id) {
    throw new Error(
      `Research archive write landed under ${payload.parentReference.id}, not the ${folder.name} folder; not recorded.`,
    );
  }

  return {
    provider: 'sharepoint',
    siteId: config.siteId,
    driveId: config.driveId,
    itemId: payload.id,
    webUrl: payload.webUrl ?? null,
    archiveRootItemId: config.archiveRootItemId,
    archiveDomainCode: input.archiveDomainCode,
    archiveFolderItemId: folder.id,
    archiveFilename: input.archiveFilename,
    contentSha256,
    byteSize: input.fileBuffer.length,
  };
}

/**
 * Reads back an original already in the archive, so a caller holding a
 * conflict can tell "these exact bytes are already filed" from "a different
 * file has this name". Read-only: one metadata GET and one content GET.
 *
 * Refuses an item that is not under the expected subject folder, and one
 * larger than `maxBytes` before downloading it.
 */
export async function readArchivedOriginal(input: {
  config: ResearchArchiveConfig;
  itemId: string;
  expectedFolderItemId: string;
  maxBytes: number;
}): Promise<{ itemId: string; name: string; webUrl: string | null; bytes: Buffer; contentSha256: string }> {
  const { config } = input;
  const token = await config.getAccessToken();
  const itemUrl = `${driveBase(config)}/items/${encodeURIComponent(input.itemId)}`;

  const meta = await fetch(`${itemUrl}?$select=id,name,size,webUrl,parentReference`, {
    method: 'GET',
    headers: bearer(token),
    signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
  });
  if (!meta.ok) {
    throw new Error(`Research archive item lookup failed (${meta.status}): ${await meta.text()}`);
  }
  const item = (await meta.json()) as GraphDriveItem;
  if (item.id !== input.itemId || typeof item.name !== 'string') {
    throw new Error('Research archive item lookup returned a different item.');
  }
  if (item.parentReference?.id !== input.expectedFolderItemId) {
    throw new Error('Research archive item is not in the expected subject folder.');
  }
  if (typeof item.size !== 'number' || item.size <= 0 || item.size > input.maxBytes) {
    throw new Error(`Research archive item size ${String(item.size)} is outside 1..${input.maxBytes} bytes.`);
  }

  const content = await fetch(`${itemUrl}/content`, {
    method: 'GET',
    headers: bearer(token),
    signal: AbortSignal.timeout(RESEARCH_ARCHIVE_TIMEOUT_MS),
  });
  if (!content.ok) {
    throw new Error(`Research archive item download failed (${content.status}).`);
  }
  const bytes = Buffer.from(await content.arrayBuffer());
  if (bytes.length > input.maxBytes) {
    throw new Error('Research archive item download was larger than its recorded size.');
  }
  return {
    itemId: item.id,
    name: item.name,
    webUrl: item.webUrl ?? null,
    bytes,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
