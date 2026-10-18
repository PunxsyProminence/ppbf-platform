/**
 * ISSUE #1469 (N9-01B), server side: PPBF's sign-in email and SHADOW's
 * prompt read exactly as main wrote them.
 */

import { issueMagicLink, type MagicLinkAccount, type MagicLinkDependencies } from '@/src/server/pilot/magicLink';
import { composeShadowSystemPrompt } from '@/src/server/pilot/shadowChat';
import { PPBF_PROFILE } from '@/src/testing/organizationProfileFixtures';

test('the sign-in email reads as it did', async () => {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const account = {
    account_id: 'coach-1',
    organization_id: 'ppbf-default-org',
    role: 'coach',
    auth_provider: 'magic_link',
    login_email: 'coach@example.com',
    active_flag: true,
    account_deleted: false,
  } as MagicLinkAccount;
  await issueMagicLink('coach@example.com', {
    findAccountByEmail: async () => account,
    invalidateLiveTokens: async () => undefined,
    discardToken: async () => undefined,
    storeToken: async () => undefined,
    sendMail: async (message: { to: string; subject: string; body: string }) => {
      sent.push(message);
    },
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    createToken: () => 'test-token-value',
    appOrigin: 'https://www.punxsyprominence.org',
    // The stored row, as the migration seeds it (lane L31).
    gymProfile: async () => PPBF_PROFILE,
  } as unknown as MagicLinkDependencies);

  expect(sent[0].subject).toBe('Your PPBF sign-in link');
  expect(sent[0].body.split('\n')[0]).toBe('Someone asked to sign in to Punxsy Prominence Boxing and Fitness with this address.');
});

test("SHADOW's system prompt opens as it did", () => {
  const prompt = composeShadowSystemPrompt({ role: 'coach', sessionType: 'heavy_bag', gym: PPBF_PROFILE });
  expect(prompt.split('\n')[0]).toBe('You are SHADOW, the organizational intelligence system for Punxsy Prominence Boxing & Fitness.');
  expect(prompt.split('\n')[2]).toBe('PRIMARY ROLE:');
});
