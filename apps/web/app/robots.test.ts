import robots from './robots';
import sitemap from './sitemap';

jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfile: async () => jest.requireActual('@/src/testing/organizationProfileFixtures').PPBF_PROFILE,
}));

test('robots allows the site and points at the sitemap on the www address', async () => {
  expect(await robots()).toEqual({
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://www.punxsyprominence.org/sitemap.xml',
  });
});

test('sitemap lists the public homepage and the privacy notice, and nothing else', async () => {
  expect(await sitemap()).toEqual([
    { url: 'https://www.punxsyprominence.org/' },
    { url: 'https://www.punxsyprominence.org/privacy' },
  ]);
});
