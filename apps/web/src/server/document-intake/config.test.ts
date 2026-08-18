// Document-intake destination configuration.
//
// The two properties under test are the two defects this file's subject used
// to have, and both are the same shape: a system reporting success while doing
// something other than what it claims.
//
//  1. A BLANK FOLDER ID IS AN ERROR, NOT A DEFAULT. GOOGLE_DRIVE_FOLDER_ID was
//     optional, so googleDrive.ts passed `parents: undefined` and uploaded into
//     the service account's own Drive. The API returned success, the audit row
//     said success, and nobody could ever open the file.
//  2. THE DESTINATIONS ARE INDEPENDENT. Getting a PDF into a Drive folder used
//     to require standing up a Dataverse instance, because getPipelineConfig()
//     demanded all three.

import {
  describeDocumentIngestDestinations,
  getPipelineConfig,
} from './config'

/** Complete Google Drive settings, and nothing else. */
const DRIVE_ONLY = {
  GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"k"}',
  GOOGLE_DRIVE_FOLDER_ID: 'folder-abc',
} as const;

const DATAVERSE_ONLY = {
  DATAVERSE_ORG_URL: 'https://example.crm.dynamics.com',
  DATAVERSE_TENANT_ID: 't',
  DATAVERSE_CLIENT_ID: 'c',
  DATAVERSE_CLIENT_SECRET: 's',
} as const;

const SHAREPOINT_ONLY = {
  GRAPH_TENANT_ID: 't',
  GRAPH_CLIENT_ID: 'c',
  GRAPH_CLIENT_SECRET: 's',
  SHAREPOINT_SITE_ID: 'site',
  SHAREPOINT_DRIVE_ID: 'drive',
} as const;

describe('a destination is only ready when it has somewhere to write', () => {
  test('Google Drive with credentials but no folder id is enabled and NOT ready', () => {
    const status = describeDocumentIngestDestinations({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
    });

    expect(status.googleDrive.enabled).toBe(true);
    expect(status.googleDrive.ready).toBe(false);
    expect(status.googleDrive.missing).toEqual(['GOOGLE_DRIVE_FOLDER_ID']);
  });

  test('a blank folder id is treated as absent, not as a value', () => {
    // '   ' is what an empty deployment setting looks like in practice. If it
    // counted as present, the config would build and the upload would land in
    // the service account's Drive -- the exact failure being fixed.
    const status = describeDocumentIngestDestinations({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      GOOGLE_DRIVE_FOLDER_ID: '   ',
    });

    expect(status.googleDrive.ready).toBe(false);
    expect(status.googleDrive.missing).toContain('GOOGLE_DRIVE_FOLDER_ID');
  });

  test('getPipelineConfig REFUSES rather than falling back to an unreachable folder', () => {
    expect(() => getPipelineConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }))
      .toThrow(/GOOGLE_DRIVE_FOLDER_ID/);
  });

  test('the refusal names the destination and the missing variable, without echoing a value', () => {
    let message = '';
    try {
      getPipelineConfig({ ...DRIVE_ONLY, GOOGLE_DRIVE_FOLDER_ID: '', DATAVERSE_ORG_URL: 'https://secret.example.com' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Google Drive/);
    expect(message).toMatch(/GOOGLE_DRIVE_FOLDER_ID/);
    // An ops-readiness endpoint echoes these strings back, so a secret value
    // must never travel in one.
    expect(message).not.toContain('https://secret.example.com');
  });
});

describe('the three destinations are independent', () => {
  test('Google Drive alone is a valid pipeline -- no Dataverse, no Graph', () => {
    const config = getPipelineConfig({ ...DRIVE_ONLY });

    expect(config.googleDrive).toEqual({
      serviceAccountJson: DRIVE_ONLY.GOOGLE_SERVICE_ACCOUNT_JSON,
      folderId: 'folder-abc',
    });
    expect(config.dataverse).toBeNull();
    expect(config.sharepoint).toBeNull();
  });

  test('Dataverse alone is a valid pipeline', () => {
    const config = getPipelineConfig({ ...DATAVERSE_ONLY });

    expect(config.dataverse?.orgUrl).toBe('https://example.crm.dynamics.com');
    expect(config.sharepoint).toBeNull();
    expect(config.googleDrive).toBeNull();
  });

  test('SharePoint alone is a valid pipeline, and keeps its documented folder default', () => {
    const config = getPipelineConfig({ ...SHAREPOINT_ONLY });

    // Unlike Drive's folder id, this default lands inside the site and drive
    // the operator explicitly configured, so the file is somewhere a human can
    // navigate to. That is a default; the Drive case was data loss.
    expect(config.sharepoint?.folderPath).toBe('PPBF/Intake');
    expect(config.dataverse).toBeNull();
    expect(config.googleDrive).toBeNull();
  });

  test('all three together still work', () => {
    const config = getPipelineConfig({ ...DRIVE_ONLY, ...DATAVERSE_ONLY, ...SHAREPOINT_ONLY });

    expect(config.dataverse).not.toBeNull();
    expect(config.sharepoint).not.toBeNull();
    expect(config.googleDrive).not.toBeNull();
  });
});

describe('partial configuration is loud, and no configuration is refused', () => {
  test('a half-configured destination throws rather than switching itself off', () => {
    // Reading enabled-but-incomplete as "disabled" would mean one typo'd
    // variable name silently stops every document reaching that destination.
    expect(() => getPipelineConfig({ ...DRIVE_ONLY, GRAPH_TENANT_ID: 't' }))
      .toThrow(/SharePoint \(missing GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, SHAREPOINT_SITE_ID, SHAREPOINT_DRIVE_ID\)/);
  });

  test('an empty environment is refused, not treated as a working pipeline', () => {
    // An ingest with no destination still returns 200 and still writes an
    // audit row saying the document was handled.
    expect(() => getPipelineConfig({})).toThrow(/no configured destination/i);
  });

  test('a destination nobody configured reports disabled rather than broken', () => {
    const status = describeDocumentIngestDestinations({ ...DRIVE_ONLY });

    expect(status.dataverse.enabled).toBe(false);
    expect(status.dataverse.ready).toBe(false);
    expect(status.dataverse.missing).toEqual([]);
    expect(status.dataverse.reason).toMatch(/not configured/i);
  });

  test('values are trimmed, so a ready destination cannot ship whitespace credentials', () => {
    // Readiness is decided on the trimmed form. If the config passed raw
    // values through, a secret with a trailing newline -- what a file-loaded
    // or pasted deployment setting routinely carries -- would report ready and
    // then fail at token acquisition with an opaque auth error.
    const config = getPipelineConfig({
      DATAVERSE_ORG_URL: '  https://example.crm.dynamics.com\n',
      DATAVERSE_TENANT_ID: 't\n',
      DATAVERSE_CLIENT_ID: ' c ',
      DATAVERSE_CLIENT_SECRET: 's\t',
      GOOGLE_SERVICE_ACCOUNT_JSON: ' {} ',
      GOOGLE_DRIVE_FOLDER_ID: ' folder-abc\n',
    });

    expect(config.dataverse).toEqual({
      orgUrl: 'https://example.crm.dynamics.com',
      tableName: 'annotations',
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
    });
    expect(config.googleDrive?.folderId).toBe('folder-abc');
    expect(config.googleDrive?.serviceAccountJson).toBe('{}');
  });

  test('an optional setting alone still counts as intent to enable', () => {
    // Setting only SHAREPOINT_FOLDER_PATH is meaningless on its own, but it
    // says somebody meant to use SharePoint. Reporting that as "off" would
    // hide the mistake.
    const status = describeDocumentIngestDestinations({ SHAREPOINT_FOLDER_PATH: 'PPBF/Somewhere' });

    expect(status.sharepoint.enabled).toBe(true);
    expect(status.sharepoint.ready).toBe(false);
    expect(status.sharepoint.missing).toContain('SHAREPOINT_SITE_ID');
  });
});
