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

test("says who the form is for and what the information is used for, in Jason's words", () => {
  render(<PublicInterestForm />);
  expect(screen.getByText('This form is for people 13 or older; a parent or guardian can send it for a younger child.')).toBeTruthy();
  expect(screen.getByText(/We use what you send only to answer you\. We do not sell or share it\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
});

test('each control is named by its own label only, not by option text', () => {
  render(<PublicInterestForm />);
  expect(screen.getByRole('combobox', { name: 'How to reach you' })).toBeTruthy();
  expect(screen.getAllByLabelText(/Email/)).toHaveLength(1);
});
