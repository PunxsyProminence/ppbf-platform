
/**
 * ISSUE #1469 (N9-01B), server side: the sign-in email and SHADOW's prompt name the gym from its one profile. A second gym's profile
 * replaces every one of them with no PPBF trace; PPBF's own text is pinned
 * unchanged in organizationProfile.ppbf.test.tsx and the existing suites.
 */

import type { OrganizationProfile } from './organizationProfile';
import type { MagicLinkAccount, MagicLinkDependencies } from '@/src/server/pilot/magicLink';

const mockSecondGym: OrganizationProfile = {
  brand: 'Ridgeway Lantern Boxing & Fitness',
  legalName: 'Ridgeway Lantern Boxing and Fitness',
  shortName: 'RLBF',
  commonName: 'Ridgeway Lantern',
  ein: '12-3456789',
  url: 'https://www.ridgeway-lantern.example',
  domain: 'ridgeway-lantern.example',
  email: 'office@ridgeway-lantern.example',
  donationsEmail: 'give@ridgeway-lantern.example',
  grantsEmail: 'grants@ridgeway-lantern.example',
  established: '2031',
  town: 'Ridgeway',
  serviceArea: 'Ridgeway and the surrounding valley towns',
  serviceAreaShort: 'Ridgeway and nearby towns',
  physical: { street: '9 Kiln Road', city: 'Ridgeway', region: 'PA', postalCode: '15853' },
  mailing: 'PO Box 7, Ridgeway, PA 15853',
  headCoachName: 'Morgan Hale',
};

jest.mock('./organizationProfile', () => {
  const actual = jest.requireActual('./organizationProfile');
  return { ...actual, currentOrganizationProfile: () => mockSecondGym };
});

const PPBF_TRACES = [/Punxsy/i, /PPBF/, /punxsyprominence/i, /Punxsutawney/i];

function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

test('the sign-in email names the second gym; the link itself is unchanged', async () => {
  const { issueMagicLink } = await import('@/src/server/pilot/magicLink');
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const account: MagicLinkAccount = {
    account_id: 'coach-1',
    organization_id: 'ridgeway',
    role: 'coach',
    auth_provider: 'magic_link',
    login_email: 'coach@example.com',
    active_flag: true,
    account_deleted: false,
  } as MagicLinkAccount;
  const deps = {
    findAccountByEmail: async () => account,
    invalidateLiveTokens: async () => undefined,
    discardToken: async () => undefined,
    storeToken: async () => undefined,
    sendMail: async (message: { to: string; subject: string; body: string }) => {
      sent.push(message);
    },
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    createToken: () => 'test-token-value',
    appOrigin: 'https://app.ridgeway-lantern.example',
  } as unknown as MagicLinkDependencies;

  await issueMagicLink('coach@example.com', deps);

  expect(sent).toHaveLength(1);
  expect(sent[0].subject).toBe('Your RLBF sign-in link');
  expect(sent[0].body).toContain('Someone asked to sign in to Ridgeway Lantern Boxing and Fitness with this address.');
  expect(sent[0].body).toContain('https://app.ridgeway-lantern.example/auth/link?token=test-token-value');
  expectNoPpbfTrace(`${sent[0].subject}\n${sent[0].body}`);
});

test("SHADOW's system prompt introduces the second gym", async () => {
  const { SHADOW_SYSTEM_PROMPT } = await import('@/src/server/pilot/shadowChat');

  expect(SHADOW_SYSTEM_PROMPT.startsWith('You are SHADOW, the organizational intelligence system for Ridgeway Lantern Boxing & Fitness.')).toBe(true);
  expectNoPpbfTrace(SHADOW_SYSTEM_PROMPT);
});
