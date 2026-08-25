/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import ActivatePage from './page';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/src/lib/useFocusOnStepChange', () => ({ useFocusOnStepChange: jest.fn() }));

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('posts the one-time code with the athlete-chosen PIN and never puts the code in a URL', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => ({ ok: true, account_id: 'ath-login', signed_in: true }) } as Response;
  }) as never;

  render(<ActivatePage />);
  fireEvent.change(screen.getByLabelText('Activation code'), { target: { value: 'ABCD-2345-EFGH' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
  fireEvent.change(await screen.findByLabelText(/^Choose your PIN$/i), { target: { value: '482913' } });
  fireEvent.change(screen.getByLabelText(/^Type it again$/i), { target: { value: '482913' } });
  fireEvent.click(screen.getByRole('button', { name: /Activate/i }));

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ url: '/api/pilot/auth/activate', body: { code: 'ABCD-2345-EFGH', pin: '482913' } });
  expect(requests[0].url).not.toContain('ABCD');
  expect(await screen.findByText(/ath-login/i)).toBeTruthy();
});
