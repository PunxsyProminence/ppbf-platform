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
  // The link names what the privacy page covers (FAM-26; AS-9 Q11 = A).
  expect(screen.getByRole('link', { name: 'Privacy: interest form' }).getAttribute('href')).toBe('/privacy');
});

test('each control is named by its own label only, not by option text', () => {
  render(<PublicInterestForm />);
  expect(screen.getByRole('combobox', { name: 'How to reach you' })).toBeTruthy();
  expect(screen.getAllByLabelText(/Email/)).toHaveLength(1);
});

/* A sent form and a failed one are told apart (app scrub FAM-25): the thanks
   is a status line, a failure is an alert with the warning mark. */
describe('sent and not sent are not the same line', () => {
  function send() {
    render(<PublicInterestForm />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Pat Example' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send this to a coach' }));
  }

  /** The send has settled: the button is back from "Sending...". */
  async function settled() {
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send this to a coach' }) as HTMLButtonElement).disabled).toBe(false));
  }

  test('a refused send is an alert, not a status, with the same words as before', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ ok: false }) });
    send();

    const alert = await screen.findByRole('alert');
    await settled();
    expect(alert.className).toContain('alert--warning');
    expect(alert.textContent).toContain('▲');
    expect(alert.textContent).toContain('Failed');
    expect(alert.textContent).toContain('Something went wrong sending this and it did not go through.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a dropped connection is an alert too', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    send();

    const alert = await screen.findByRole('alert');
    await settled();
    expect(alert.textContent).toContain('The connection dropped and this was not sent.');
    // The title makes no claim about whether the gym received it.
    expect(alert.querySelector('.alert-title')?.textContent).toBe('Failed');
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('a sent form is a status line and no alert; a later failure clears the thanks', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    send();
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Got it/));
    expect(screen.queryByRole('alert')).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false }) });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Pat Example' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send this to a coach' }));
    await screen.findByRole('alert');
    await settled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
