/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import PublicInterestForm from './PublicInterestForm';

jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

test('has no consent checkbox', () => {
  const { container } = render(<PublicInterestForm />);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(screen.queryByText(/okay to contact me/i)).toBeNull();
});

test('submits name and email straight away, without a consent field', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  render(<PublicInterestForm />);

  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Pat Example' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send this to a coach' }));

  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Got it/));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/pilot/public-interest');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ full_name: 'Pat Example', email: 'pat@example.com', website: '' });
  expect(body).not.toHaveProperty('consent_to_contact');
});

test('says what the information is used for, who the form is for, and links Privacy', () => {
  render(<PublicInterestForm />);
  expect(screen.getByText(/We use what you send only to answer you\./)).toBeTruthy();
  expect(screen.getByText(/13 or older/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
});
