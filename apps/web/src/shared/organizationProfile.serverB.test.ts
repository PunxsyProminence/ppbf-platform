/**
 * ISSUE #1469 (N9-01B; lane L31), server side: the sign-in email and SHADOW's
 * prompt name the gym from its stored profile. A second gym's profile replaces
 * every one of them with no PPBF trace; with no profile neither names a gym
 * and neither stops working. PPBF's own text is pinned in
 * organizationProfile.ppbfServer.test.ts.
 */

import { issueMagicLink, type MagicLinkAccount, type MagicLinkDependencies } from '@/src/server/pilot/magicLink';
import { composeShadowSystemPrompt, shadowIdentityLine, SHADOW_SYSTEM_PROMPT } from '@/src/server/pilot/shadowChat';
import { PPBF_TRACES, SECOND_GYM_PROFILE } from '@/src/testing/organizationProfileFixtures';
import type { OrganizationProfile } from './organizationProfile';


function expectNoPpbfTrace(text: string) {
  for (const trace of PPBF_TRACES) expect(text).not.toMatch(trace);
}

async function sentEmail(gymProfile: (() => Promise<OrganizationProfile | null>) | undefined) {
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
    gymProfile,
  } as unknown as MagicLinkDependencies;
  await issueMagicLink('coach@example.com', deps);
  expect(sent).toHaveLength(1);
  return sent[0];
}

test('the sign-in email names the second gym; the link itself is unchanged', async () => {
  const mail = await sentEmail(async () => SECOND_GYM_PROFILE);
  expect(mail.subject).toBe('Your RLBF sign-in link');
  expect(mail.body).toContain('Someone asked to sign in to Ridgeway Lantern Boxing and Fitness with this address.');
  expect(mail.body).toContain('https://app.ridgeway-lantern.example/auth/link?token=test-token-value');
  expectNoPpbfTrace(`${mail.subject}\n${mail.body}`);
});

test('with no profile, or a failed read, the sign-in email still goes, naming no gym', async () => {
  for (const gymProfile of [undefined, async () => null, async () => { throw new Error('db down'); }]) {
    const mail = await sentEmail(gymProfile);
    expect(mail.subject).toBe('Your sign-in link');
    expect(mail.body.split('\n')[0]).toBe('Someone asked to sign in with this address.');
    expect(mail.body).toContain('https://app.ridgeway-lantern.example/auth/link?token=test-token-value');
  }
});

test("SHADOW's prompt introduces the second gym; the doctrine names no gym", () => {
  const prompt = composeShadowSystemPrompt({ role: 'coach', sessionType: 'quick', gym: SECOND_GYM_PROFILE });
  expect(prompt.startsWith('You are SHADOW, the organizational intelligence system for Ridgeway Lantern Boxing & Fitness.\n\nPRIMARY ROLE:')).toBe(true);
  expectNoPpbfTrace(prompt);
  expectNoPpbfTrace(SHADOW_SYSTEM_PROMPT);
  expect(SHADOW_SYSTEM_PROMPT.startsWith('PRIMARY ROLE:')).toBe(true);
});

test("with no profile, SHADOW says 'this gym' rather than a name nobody stored", () => {
  expect(shadowIdentityLine(null)).toBe('You are SHADOW, the organizational intelligence system for this gym.');
});
