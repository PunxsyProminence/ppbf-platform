import { graphTokenProvider } from './managedIdentityToken';
import type { ResearchArchiveConfig } from './researchArchiveWrite';

/**
 * Whether this deployment may file research originals in the SharePoint
 * Research Archive, where, and for whom.
 *
 * Four settings, none of them secret: the verified site, drive and archive
 * root item (docs/SHADOW_RESEARCH_ARCHITECTURE.md section 1.0), and the
 * organizations whose Library shelves may file there. The archive is the
 * nonprofit's own SharePoint, and the platform hosts other gyms: their admins
 * pass the same curator gate, so who may file is named here explicitly rather
 * than implied by a role (PPBF's gym and the platform shelf, `__platform__`).
 *
 * Sign-in is the container app's managed identity, so there is no client
 * secret to configure. Only production is given these values; everywhere else
 * the archive is OFF and research intake works exactly as it did before.
 *
 * INTENT, THEN VALIDATE (the document-intake/config.ts rule). Any one setting
 * present means somebody meant to switch the archive on, so a missing or
 * malformed one is reported by name instead of silently reading as "off" -- a
 * typo'd variable would otherwise switch filing off with nobody told. The
 * shapes are checked because each value is placed into a Graph URL.
 *
 * It does not read SHAREPOINT_SITE_ID / SHAREPOINT_DRIVE_ID /
 * SHAREPOINT_FOLDER_PATH: configuring the generic intake uploader must never
 * switch archive filing on.
 */

export const RESEARCH_ARCHIVE_SETTINGS = [
  'RESEARCH_ARCHIVE_SITE_ID',
  'RESEARCH_ARCHIVE_DRIVE_ID',
  'RESEARCH_ARCHIVE_ROOT_ITEM_ID',
  'RESEARCH_ARCHIVE_ORGANIZATION_IDS',
] as const;

type Setting = (typeof RESEARCH_ARCHIVE_SETTINGS)[number];

/** Graph's forms: `host,site-guid,web-guid`; `b!` + base64url; an item id; organization ids. */
const SHAPES: Record<Setting, RegExp> = {
  RESEARCH_ARCHIVE_SITE_ID: /^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i,
  RESEARCH_ARCHIVE_DRIVE_ID: /^b![A-Za-z0-9_-]+$/,
  RESEARCH_ARCHIVE_ROOT_ITEM_ID: /^[A-Za-z0-9]+$/,
  RESEARCH_ARCHIVE_ORGANIZATION_IDS: /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/,
};

export type ResearchArchiveSetup =
  | { state: 'off' }
  /** Names only, never values. */
  | { state: 'incomplete'; missing: string[] }
  | { state: 'ready'; config: ResearchArchiveConfig; filingOrganizationIds: readonly string[] };

export function readResearchArchiveSetup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  getAccessToken: () => Promise<string> = graphTokenProvider(),
): ResearchArchiveSetup {
  const values = Object.fromEntries(
    RESEARCH_ARCHIVE_SETTINGS.map((name) => [name, (env[name] ?? '').replace(/\s+/g, '')]),
  ) as Record<Setting, string>;
  const unset = RESEARCH_ARCHIVE_SETTINGS.filter((name) => values[name] === '');
  if (unset.length === RESEARCH_ARCHIVE_SETTINGS.length) return { state: 'off' };
  const missing = RESEARCH_ARCHIVE_SETTINGS.filter((name) => values[name] === '' || !SHAPES[name].test(values[name]))
    .map((name) => (values[name] === '' ? name : `${name} (malformed)`));
  if (missing.length > 0) return { state: 'incomplete', missing };
  return {
    state: 'ready',
    config: {
      siteId: values.RESEARCH_ARCHIVE_SITE_ID,
      driveId: values.RESEARCH_ARCHIVE_DRIVE_ID,
      archiveRootItemId: values.RESEARCH_ARCHIVE_ROOT_ITEM_ID,
      getAccessToken,
    },
    filingOrganizationIds: values.RESEARCH_ARCHIVE_ORGANIZATION_IDS.split(','),
  };
}
