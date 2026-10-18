import { RESEARCH_ARCHIVE_SETTINGS, readResearchArchiveSetup } from './researchArchiveConfig';

const token = async () => 'test-token';

// The verified identity's shapes (docs/SHADOW_RESEARCH_ARCHITECTURE.md section 1.0), not its values.
const ALL = {
  RESEARCH_ARCHIVE_SITE_ID: 'example.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
  RESEARCH_ARCHIVE_DRIVE_ID: 'b!-Vo_driveId-123',
  RESEARCH_ARCHIVE_ROOT_ITEM_ID: '0154ROOTITEM',
  RESEARCH_ARCHIVE_ORGANIZATION_IDS: 'punxsy_prominence,__platform__',
};

describe('whether this deployment files research originals', () => {
  test('nothing set is OFF: research intake works as before', () => {
    expect(readResearchArchiveSetup({}, token)).toEqual({ state: 'off' });
    expect(readResearchArchiveSetup({ RESEARCH_ARCHIVE_SITE_ID: '  ' }, token)).toEqual({ state: 'off' });
  });

  test('all four set is ON, for exactly the shelves named, with the supplied sign-in', () => {
    const setup = readResearchArchiveSetup(
      { ...ALL, RESEARCH_ARCHIVE_DRIVE_ID: ' b!-Vo_driveId-123 ', RESEARCH_ARCHIVE_ORGANIZATION_IDS: 'punxsy_prominence, __platform__' },
      token,
    );
    expect(setup).toEqual({
      state: 'ready',
      config: {
        siteId: ALL.RESEARCH_ARCHIVE_SITE_ID,
        driveId: 'b!-Vo_driveId-123',
        archiveRootItemId: '0154ROOTITEM',
        getAccessToken: token,
      },
      filingOrganizationIds: ['punxsy_prominence', '__platform__'],
    });
  });

  test.each(RESEARCH_ARCHIVE_SETTINGS.map((name) => [name]))('any one missing (%s) is reported by name, not read as OFF', (name) => {
    const env: Record<string, string> = { ...ALL };
    delete env[name];
    expect(readResearchArchiveSetup(env, token)).toEqual({ state: 'incomplete', missing: [name] });
  });

  // Each value is placed into a Graph URL: a slash or query character would change the request.
  test.each([
    ['RESEARCH_ARCHIVE_SITE_ID', 'example.sharepoint.com/sites/x'],
    ['RESEARCH_ARCHIVE_DRIVE_ID', 'b!drive/../other'],
    ['RESEARCH_ARCHIVE_DRIVE_ID', 'drive-without-prefix'],
    ['RESEARCH_ARCHIVE_ROOT_ITEM_ID', 'ROOT?$expand=children'],
    ['RESEARCH_ARCHIVE_ORGANIZATION_IDS', 'punxsy_prominence,,__platform__'],
  ])('a malformed %s (%j) is reported, never used', (name, value) => {
    expect(readResearchArchiveSetup({ ...ALL, [name]: value }, token)).toEqual({
      state: 'incomplete',
      missing: [`${name} (malformed)`],
    });
  });

  test('configuring the generic intake uploader never switches archive filing on', () => {
    expect(
      readResearchArchiveSetup(
        { SHAREPOINT_SITE_ID: 'site', SHAREPOINT_DRIVE_ID: 'drive', SHAREPOINT_FOLDER_PATH: 'Research Archive' },
        token,
      ),
    ).toEqual({ state: 'off' });
  });

  test('no setting is a secret: there is no client id, tenant or secret to configure', () => {
    expect(RESEARCH_ARCHIVE_SETTINGS).toEqual([
      'RESEARCH_ARCHIVE_SITE_ID',
      'RESEARCH_ARCHIVE_DRIVE_ID',
      'RESEARCH_ARCHIVE_ROOT_ITEM_ID',
      'RESEARCH_ARCHIVE_ORGANIZATION_IDS',
    ]);
  });
});
