/**
 * @jest-environment jsdom
 */

// Lane U2 (audit UX-A A-2): the Gym Office shows what is open in each of the
// safety rollup's five feeds and links Safety Review. A failed read never
// reads as zero.

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import GymOfficeSafetyStrip from './GymOfficeSafetyStrip';
import { BUILDING } from './buildingMap';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function respond(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response) as unknown as typeof fetch;
}

const REVIEW = {
  ok: true,
  openHolds: [{}, {}],
  failingGates: [],
  openEscalations: [{}],
  openViolations: [{}, {}, {}],
  openFlags: [{}, {}, {}, {}],
  violationsReadLimit: 200,
  violationsTruncated: false,
};

function count(label: string) {
  const term = screen.getByText(label);
  return within(term.parentElement as HTMLElement).getByRole('definition').textContent;
}

test('shows each feed\'s open count and links Safety Review', async () => {
  respond(200, REVIEW);
  render(<GymOfficeSafetyStrip />);
  await screen.findByText('Training holds');
  expect(count('Training holds')).toBe('2');
  expect(count('Failing gate checks')).toBe('0');
  expect(count('Open escalations')).toBe('1');
  expect(count('Compliance violations')).toBe('3');
  expect(count('Safety flags')).toBe('4');
  expect(screen.getByRole('link', { name: 'Open Safety Review' }).getAttribute('href')).toBe('/admin/safety-review');
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/pilot/admin/safety-review'), expect.anything());
});

test('a capped violations read says so rather than giving a bare number', async () => {
  respond(200, { ...REVIEW, violationsTruncated: true });
  render(<GymOfficeSafetyStrip />);
  await screen.findByText('Compliance violations');
  expect(count('Compliance violations')).toBe('3 in the latest read');
});

test.each([
  ['a refused read', 403, { error: 'no' }],
  ['a read missing the flags list', 200, { ...REVIEW, openFlags: undefined }],
])('%s says it could not be read, never zero', async (_name, status, body) => {
  respond(status, body);
  render(<GymOfficeSafetyStrip />);
  expect(await screen.findByText(/could not be read/)).toBeTruthy();
  expect(screen.queryByText('Training holds')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Safety Review' })).toBeTruthy();
});

test('the catalog lists the escalations queue once (A-13)', () => {
  expect(BUILDING.filter((door) => door.href === '/admin/safety-escalations')).toEqual([]);
  expect(BUILDING.filter((door) => door.href === '/admin/escalations')).toHaveLength(1);
});

describe('where it sits', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  test('on the Gym Office, the admin\'s home', () => {
    expect(read('app/admin/people/page.tsx')).toMatch(/<GymOfficeSafetyStrip \/>/);
  });

  test('the Compliance Center button carries no Planned stamp; the automation note stays', () => {
    const admin = read('app/admin/page.tsx');
    expect(admin).not.toMatch(/COMPLIANCE CENTER\s*<span className="stamp/);
    expect(admin).toContain('Planned — Not Yet Implemented');
  });
});
