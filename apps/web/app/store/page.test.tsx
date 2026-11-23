/**
 * @jest-environment jsdom
 */

/* FAM-22 (app scrub; lane AS-9, AS9-7): the list of shops is not blank while
   its read is out. */

import { act } from 'react';
import { render, screen } from '@testing-library/react';

import StoreIndexPage from './page';
import { backHomeTarget } from '@/components/BackHome';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: React.ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

test('a loading line shows until the shops answer, and then goes', async () => {
  let answer: (value: unknown) => void = () => {};
  global.fetch = jest.fn(() => new Promise((resolve) => { answer = resolve; })) as unknown as typeof fetch;
  await act(async () => {
    render(<StoreIndexPage />);
  });

  expect(screen.getByRole('status').textContent).toBe('Loading the shops...');
  expect(screen.queryByText('Nothing is on sale just now. Check back.')).toBeNull();

  await act(async () => {
    answer({ ok: true, json: async () => ({ stores: [] }) });
  });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Nothing is on sale just now. Check back.')).toBeTruthy();
});

// Lane AS4-4D4E (app scrub FAM-16): the store linked nowhere back.
test('the store has a way back to the front page', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ stores: [] }) })) as unknown as typeof fetch;
  await act(async () => {
    render(<StoreIndexPage />);
  });

  expect(screen.getByRole('link', { name: 'Back to the front page' }).getAttribute('href')).toBe('/');
});

// A signed-in reader goes to their own home, not the public page (layout
// review on #2129).
test('a signed-in reader is sent to their own home instead', async () => {
  const session = createPersistentRoleSession('coach');
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ stores: [] }) })) as unknown as typeof fetch;
  await act(async () => {
    render(<StoreIndexPage />);
  });

  const { href, label } = backHomeTarget(session);
  expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe(href);
  expect(screen.queryByRole('link', { name: 'Back to the front page' })).toBeNull();
  act(() => clearRoleSession());
});
