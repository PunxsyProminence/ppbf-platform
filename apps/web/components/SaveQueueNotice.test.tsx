/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import SaveQueueNotice, { FAILED_WORDS, WAITING_WORDS, checkingWords, notSentWords } from './SaveQueueNotice';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, keepSave, prepareSaveQueue, resetSaveQueueForTests, type KeptSave } from '@/src/lib/saveQueue';

// What a page that keeps saves shows about them (W4 item 7). The queue's own rules are proven in
// src/lib/saveQueue.test.ts; this file proves the words reach the screen, in the roles a reader
// hears, and go when the queue drops them at sign-out.

function answer(status: number): Response {
  const response = { ok: status >= 200 && status < 300, status, json: async () => ({}), clone: () => response };
  return response as unknown as Response;
}

function save(label: string, answers: Array<Response | 'throw'>): KeptSave {
  return {
    label,
    send: jest.fn(async () => {
      const next = answers.shift() ?? 'throw';
      if (next === 'throw') throw new TypeError('Failed to fetch');
      return next;
    }),
    onRefused: () => 'This athlete is not marked present in this session.',
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetSaveQueueForTests();
  global.fetch = jest.fn(async () => answer(200)) as unknown as typeof fetch;
  (global.fetch as jest.Mock).mockImplementation(async () => {
    const response = { ok: true, status: 200, json: async () => ({ authenticated: true, account_id: 'acct-a' }), clone: () => response };
    return response;
  });
  createPersistentRoleSession('coach');
  prepareSaveQueue();
});

afterEach(() => {
  resetSaveQueueForTests();
  jest.useRealTimers();
});

test('shows no words when no save is waiting or failed; the status region is there, empty, so the first line is announced', () => {
  const { container } = render(<SaveQueueNotice />);
  expect(container).toHaveTextContent(/^$/);
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a waiting save is named in a status line; a refused one in an alert with the reason, cleared by OK', async () => {
  render(<SaveQueueNotice />);
  await act(async () => {
    await keepSave(save('Ada Reyes: here', ['throw', answer(200)]));
    await keepSave(save('Staff note on Ben Ortiz', [answer(409)]));
    await jest.advanceTimersByTimeAsync(0);
  });

  const waiting = screen.getByRole('status');
  expect(waiting).toHaveTextContent(WAITING_WORDS);
  expect(waiting).toHaveTextContent('Ada Reyes: here');
  expect(waiting).toHaveTextContent('Staff note on Ben Ortiz');
  expect(screen.queryByRole('alert')).toBeNull();

  await act(async () => {
    await jest.advanceTimersByTimeAsync(RESEND_MS);
  });
  expect(screen.getByRole('status')).toBeEmptyDOMElement();
  const failed = screen.getByRole('alert');
  expect(failed).toHaveTextContent(FAILED_WORDS);
  expect(failed).toHaveTextContent('Staff note on Ben Ortiz: This athlete is not marked present in this session.');

  // Floor sizes on any surface: .btn--kiosk sets them in the sheet (Tailwind utilities on a .btn lose
  // to the unlayered sheet, so a class string of utilities would prove nothing).
  expect(screen.getByRole('button', { name: 'OK' })).toHaveClass('btn', 'btn--kiosk');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('signing out takes every word of the last person\'s saves off the screen at once', async () => {
  const { container } = render(<SaveQueueNotice />);
  await act(async () => {
    await keepSave(save('Staff note on Ben Ortiz', [answer(422)]));
    await jest.advanceTimersByTimeAsync(0);
    await keepSave(save('Ada Reyes: here', ['throw']));
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('status')).toHaveTextContent('Ada Reyes: here');
  expect(screen.getByRole('alert')).toHaveTextContent('Staff note on Ben Ortiz');

  act(() => {
    clearRoleSession();
  });
  expect(container).toHaveTextContent(/^$/);
  expect(container).not.toHaveTextContent('Ben Ortiz');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('after saves were dropped unsent, the person who made them is told how many, with no names', async () => {
  render(<SaveQueueNotice />);
  await act(async () => {
    await keepSave(save('Ada Reyes: here', ['throw']));
    await jest.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    clearRoleSession();
    prepareSaveQueue();
    await jest.advanceTimersByTimeAsync(0);
  });
  const line = screen.getByRole('alert');
  expect(line).toHaveTextContent(notSentWords(1));
  expect(line).not.toHaveTextContent('Ada Reyes');
});

test('while the page checks again who is signed in, only a count shows, with no names', async () => {
  const { container } = render(<SaveQueueNotice />);
  await act(async () => {
    await keepSave(save('Staff note on Ben Ortiz', [answer(422)]));
    await jest.advanceTimersByTimeAsync(0);
    await keepSave(save('Ada Reyes: here', ['throw']));
    await jest.advanceTimersByTimeAsync(0);
  });
  (global.fetch as jest.Mock).mockImplementation(async () => {
    throw new TypeError('Failed to fetch');
  });
  await act(async () => {
    createPersistentRoleSession('coach');
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('status')).toHaveTextContent(checkingWords(2));
  expect(container).not.toHaveTextContent('Ada Reyes');
  expect(container).not.toHaveTextContent('Ben Ortiz');
  expect(screen.queryByRole('alert')).toBeNull();
});
