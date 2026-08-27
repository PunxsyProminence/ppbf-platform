/**
 * @jest-environment jsdom
 */

// READ HONESTY. This page's "The record" drawer links out to /notices. That
// destination is a CAPPED read: app/notices/page.tsx asks for
// NOTICE_READ_LIMIT (25) and announcements.ts clamps the authoring read to 25
// (clampLimit) ordered `created_at desc`, with no pager anywhere on it. The
// destination page was corrected to say "Recently Posted" and to state its own
// 25-row window; this link was left calling the same rows "the full record".
//
// An admin hunting for an old notice clicks a control labelled "the full
// record", reads 25 rows, does not find it, and concludes it was never posted.
// The 26th-newest notice is not reachable from any screen.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import CustomizePage from './page';

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

jest.mock('@/components/Chalkboard', () => ({
  __esModule: true,
  default: () => <div data-testid="chalkboard" />,
}));

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, announcements: [] }),
  } as Response) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

// WATCHED TO FAIL: restore the label "Notices — the full record" and the first
// assertion goes red naming the word.
test('the link to the capped notices register never calls it the full record', async () => {
  render(<CustomizePage />);

  const noticesLinks = (await screen.findAllByRole('link')).filter(
    (link) => link.getAttribute('href') === '/notices',
  );

  // Not vacuous: the link this test is about really is on the page.
  expect(noticesLinks.length).toBeGreaterThan(0);

  for (const link of noticesLinks) {
    expect(link.textContent ?? '').not.toMatch(/full record|complete|everything|all notices/i);
  }
});
