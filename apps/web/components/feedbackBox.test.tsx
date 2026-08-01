/**
 * @jest-environment jsdom
 */

// The box a child might type a disclosure into. What is tested here is mostly
// what it must NOT do: branch on where a submission went, say the word
// "flagged", or lose what somebody just worked up the nerve to write.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import FeedbackBox from './FeedbackBox';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function open() {
  render(<FeedbackBox />);
  fireEvent.click(screen.getByRole('button', { name: /tell us/i }));
}

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/type it however it comes out/i), {
    target: { value },
  });
}

function bodyOfCall(fetchMock: jest.Mock, index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

it('renders nothing until it is opened', () => {
  render(<FeedbackBox />);

  expect(screen.queryByPlaceholderText(/type it however it comes out/i)).toBeNull();
});

it('sends the words and the kind, and nothing that could steer the routing', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, acknowledgement: 'Thank you.' }));
  global.fetch = fetchMock as unknown as typeof fetch;

  open();
  type('  someone at the gym keeps hurting me  ');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());

  expect(bodyOfCall(fetchMock)).toEqual({
    kind: 'bug',
    body: 'someone at the gym keeps hurting me',
  });
});

// The server composes the confirmation. If this component ever decided the
// sentence, it would have to know the route -- and knowing the route is the
// thing that lets an interface treat a child differently.
it('shows the confirmation the server sent, word for word', async () => {
  const acknowledgement =
    'Thank you for telling us. A person at the gym reads this, and someone will come and talk with you about it.';
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, acknowledgement }));
  global.fetch = fetchMock as unknown as typeof fetch;

  open();
  type('im scared to come on thursday');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await screen.findByText(acknowledgement);

  const panelText = document.body.textContent?.toLowerCase() ?? '';
  expect(panelText).not.toContain('safeguard');
  expect(panelText).not.toContain('flag');
  expect(panelText).not.toContain('report');
});

it('does not send a second copy while the first is still in flight', async () => {
  let release: (value: Response) => void = () => {};
  const settled = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchMock = jest.fn(async () => settled);
  global.fetch = fetchMock as unknown as typeof fetch;

  open();
  type('the attendance page loses my selection');

  const send = screen.getByRole('button', { name: 'Send' });
  fireEvent.click(send);
  fireEvent.click(send);

  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    release(jsonResponse({ ok: true, acknowledgement: 'Thank you.' }));
    await settled;
  });

  await screen.findByText('Thank you.');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps the typed words when the send fails', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ error: 'Internal server error' }, false));
  global.fetch = fetchMock as unknown as typeof fetch;

  open();
  type('he grabbed me by the arm');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await screen.findByText('Internal server error');

  const textarea = screen.getByPlaceholderText(/type it however it comes out/i) as HTMLTextAreaElement;
  expect(textarea.value).toBe('he grabbed me by the arm');
});

it('will not send an empty submission', () => {
  const fetchMock = jest.fn(async () => jsonResponse({ ok: true, acknowledgement: 'Thank you.' }));
  global.fetch = fetchMock as unknown as typeof fetch;

  open();
  type('   \n  ');

  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);

  fireEvent.click(send);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('offers the same four kinds to everyone, with no route among them', () => {
  open();

  const options = Array.from(document.querySelectorAll('option')).map((option) => option.getAttribute('value'));
  expect(options).toEqual(['bug', 'frustration', 'idea', 'other']);
});
