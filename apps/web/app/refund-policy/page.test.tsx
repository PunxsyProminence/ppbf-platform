/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import RefundPolicyPage, { generateMetadata } from './page';

jest.mock('@/src/server/pilot/organizationProfileStore', () => ({
  getOperatingOrganizationProfile: async () => jest.requireActual('@/src/testing/organizationProfileFixtures').PPBF_PROFILE,
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

type Store = { getOperatingOrganizationProfile: () => Promise<unknown> };

async function renderWith(override?: Record<string, unknown>) {
  const store = jest.requireMock('@/src/server/pilot/organizationProfileStore') as Store;
  const { PPBF_PROFILE } = jest.requireActual('@/src/testing/organizationProfileFixtures');
  const original = store.getOperatingOrganizationProfile;
  if (override) store.getOperatingOrganizationProfile = async () => ({ ...PPBF_PROFILE, ...override });
  try {
    const { container } = render(await RefundPolicyPage());
    return { container, text: (container.textContent ?? '').replace(/\s+/g, ' ') };
  } finally {
    store.getOperatingOrganizationProfile = original;
  }
}

/* Jason 2026-11-12, "go with your recommendations": 30 days, 3 business days, 5 business days. */
test("states Jason's terms as approved", async () => {
  const { text } = await renderWith();
  for (const line of [
    'Punxsy Prominence Boxing and Fitness · 501(c)(3) nonprofit · EIN 99-2073622',
    'Youth train free. Donations, sponsorships and the suggested adult donation of $20 a month are what keep it that way. Giving is never a condition of training here. Card payments are processed by Stripe.',
    'Donations are generally not refundable. If a donation was made by mistake (the wrong amount, a duplicate charge, or a charge you did not authorize), email treasurer@punxsyprominence.org within 30 days and we will refund it to the card or account it came from.',
    'Refunds usually show up within 5 to 10 business days. A refunded donation is no longer a tax-deductible gift, and any receipt for it is void.',
    'You can stop or change a monthly donation at any time: email treasurer@punxsyprominence.org. A request we receive at least 3 business days before the next charge takes effect before that charge.',
    'Months already charged are not refunded, except for the mistakes listed under Refunds.',
    'If a charge looks wrong, contact us first. We answer within 5 business days',
    'Email: treasurer@punxsyprominence.org or admin@punxsyprominence.org',
    'If you file a dispute with your bank or card company, we will give them our records of the charge.',
    'Sponsorships follow the written agreement made with each sponsor.',
  ]) {
    expect(text).toContain(line);
  }
});

test('the $20 is a suggested donation, never a fee, and giving is never a condition of training', async () => {
  const { text } = await renderWith();
  expect(text).not.toMatch(/\bfees?\b/i);
  expect(text).not.toMatch(/adults pay/i);
  // OD-2026-11-12-004 chose the optional line: giving is never a condition of training.
  expect(text).toContain('Giving is never a condition of training here.');
  expect(text).not.toMatch(/\$250/);
});

test('the mailing address comes from the stored profile', async () => {
  const { text } = await renderWith({ mailing: '805 E Mahoning St, Punxsutawney, PA 15767' });
  expect(text).toContain('Mail: 805 E Mahoning St, Punxsutawney, PA 15767');
});

test('without a donations email the general email takes its place; with no email at all, nothing is invented', async () => {
  const general = await renderWith({ donationsEmail: '' });
  expect(general.text).toContain('email admin@punxsyprominence.org within 30 days');
  expect(general.text).toContain('Email: admin@punxsyprominence.org');
  expect(general.text).not.toContain('treasurer@');

  const none = await renderWith({ donationsEmail: '', email: '', mailing: '', ein: '' });
  expect(none.text).toContain('contact us within 30 days');
  expect(none.text).not.toContain('Email:');
  expect(none.text).not.toContain('Mail:');
  expect(none.text).not.toContain('EIN');
  expect(none.container.querySelectorAll('a[href^="mailto:"]')).toHaveLength(0);
});

test("a second gym's profile leaves no trace of PPBF", async () => {
  const { SECOND_GYM_PROFILE, PPBF_TRACES } = jest.requireActual('@/src/testing/organizationProfileFixtures');
  const { text } = await renderWith(SECOND_GYM_PROFILE);
  expect(text).toContain('Ridgeway Lantern Boxing and Fitness');
  expect(text).toContain('give@ridgeway-lantern.example');
  for (const trace of PPBF_TRACES as RegExp[]) expect(text).not.toMatch(trace);
});

test('has its own title and canonical address', async () => {
  const metadata = await generateMetadata();
  expect(metadata.title).toBe('Donations, refunds and cancellations');
  expect(metadata.alternates?.canonical).toBe('https://www.punxsyprominence.org/refund-policy');
});
