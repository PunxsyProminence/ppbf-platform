import manifest, { dynamic } from './manifest';

// The web app manifest (lane W5-WP, WP-1c; QF A on #2228). The gym's name
// comes from its stored profile; nothing about the gym is written here.

let profile: unknown = null;
jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfileOrNull: async () => profile,
}));

const { PPBF_PROFILE } = jest.requireActual('@/src/testing/organizationProfileFixtures');

test('it names the app from the gym profile, starts at "/login", opens on its own, and lists only the existing seal', async () => {
  profile = PPBF_PROFILE;
  expect(await manifest()).toEqual({
    id: '/',
    name: `${PPBF_PROFILE.shortName} Platform`,
    short_name: PPBF_PROFILE.shortName,
    start_url: '/login',
    display: 'standalone',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  });
});

test('another gym gets its own name', async () => {
  profile = { ...PPBF_PROFILE, shortName: 'RLBF' };
  const result = await manifest();
  expect(result.name).toBe('RLBF Platform');
  expect(result.short_name).toBe('RLBF');
  expect(JSON.stringify(result)).not.toContain(PPBF_PROFILE.shortName);
});

test('with no profile it falls back to the layout\'s "Platform" and invents no gym fact', async () => {
  profile = null;
  expect(await manifest()).toEqual({
    id: '/',
    name: 'Platform',
    short_name: 'Platform',
    start_url: '/login',
    display: 'standalone',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  });
});

test('it is read per request, as the layout is (no build-time database)', () => {
  expect(dynamic).toBe('force-dynamic');
});
