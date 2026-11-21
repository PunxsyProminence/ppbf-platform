/**
 * @jest-environment jsdom
 */

/* FAM-22 (app scrub; lane AS-9, AS9-7): the list of shops is not blank while
   its read is out. */

import { act } from 'react';
import { render, screen } from '@testing-library/react';

import StoreIndexPage from './page';

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
