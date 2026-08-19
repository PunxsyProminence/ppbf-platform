/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';

import WaiverComplianceAuditPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const INCOMPLETE = [
  {
    athlete_id: 'ath-1',
    athlete_name: 'Jordan T.',
    active_flag: true,
    waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
  },
];

const COMPLETE = [
  {
    athlete_id: 'ath-2',
    athlete_name: 'Sam R.',
    active_flag: true,
    waivers: { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' },
  },
];

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('the default view shows athletes with a missing waiver', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: INCOMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Jordan T.');
  expect(screen.getAllByText('Missing').length).toBeGreaterThan(0);
});

test('an athlete with every tracked waiver signed is excluded from the default (incomplete) filter', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: COMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Nothing in this view');
  expect(screen.queryByText('Sam R.')).not.toBeInTheDocument();
});

test('switching to "All signed" shows the fully-compliant athlete', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: COMPLETE })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Nothing in this view');

  fireEvent.click(screen.getByRole('button', { name: 'All signed' }));

  await screen.findByText('Sam R.');
});

test('switching to "All athletes" shows both complete and incomplete rows together', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [...INCOMPLETE, ...COMPLETE] })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Jordan T.');

  fireEvent.click(screen.getByRole('button', { name: 'All athletes' }));

  await screen.findByText('Sam R.');
  expect(screen.getByText('Jordan T.')).toBeInTheDocument();
});

test('unchecking "Active athletes only" includes an inactive athlete', async () => {
  const inactive = [{ ...INCOMPLETE[0], athlete_id: 'ath-3', athlete_name: 'Retired R.', active_flag: false }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: inactive })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);
  await screen.findByText('Nothing in this view');

  fireEvent.click(screen.getByRole('checkbox', { name: /Active athletes only/ }));

  await screen.findByText('Retired R.');
});

test('a declined waiver renders distinctly from a missing one', async () => {
  const declined = [{ ...INCOMPLETE[0], waivers: { ...INCOMPLETE[0].waivers, medical_release: 'declined' } }];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: declined })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Declined');
});

test('no athletes at all renders the empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Nothing in this view');
});

test('a failed load shows the error state, never a false empty state', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  await screen.findByText('Database unavailable');
  expect(screen.queryByText('Nothing in this view')).not.toBeInTheDocument();
});


test('a failed read is not stamped as a medical emergency', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<WaiverComplianceAuditPage />);

  // Room DNA: --locked red is what this room says when a clinician or a
  // safeguarding decision has stopped something. A read that failed is a
  // network fact. Law 3 keeps the glyph and the uppercase label doing the
  // work colour must never do alone.
  const alert = await screen.findByRole('alert');
  expect(alert.className).toContain('alert--warning');
  expect(alert.className).not.toContain('alert--critical');
  expect(within(alert).getByText('Attention')).toBeTruthy();
});

