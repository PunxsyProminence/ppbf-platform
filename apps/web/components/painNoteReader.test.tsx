/**
 * @jest-environment jsdom
 */

// DR-25, Q12 A on #2139: "Read the note" on a pain-note escalation reads the note only when pressed,
// shows an admin's copy of a held note with the admin-only line, and fails in its own words.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import PainNoteReader, { PAIN_NOTE_READ_FAILED, painNoteEscalationTarget } from './PainNoteReader';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const NOTE_URL = '/api/pilot/coach/pain-reports/nm-1/note';
let answer: () => Response | Promise<Response>;
let calls: string[];

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof fetch;
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

test('only an escalation filed from a pain note points at one', () => {
  expect(painNoteEscalationTarget({ channel: 'pain_report_note', near_miss_id: 'nm-1' })).toBe('nm-1');
  expect(painNoteEscalationTarget({ channel: 'shadow_chat', conversation_id: 'c' })).toBeNull();
  expect(painNoteEscalationTarget({ near_miss_id: 'nm-1', trigger: 'athlete_pain_report' })).toBeNull();
  expect(painNoteEscalationTarget({ channel: 'pain_report_note', near_miss_id: 7 })).toBeNull();
  expect(painNoteEscalationTarget(null)).toBeNull();
});

test('nothing is read until the press; then the note shows under its heading', async () => {
  let release: (response: Response) => void = () => undefined;
  answer = () => new Promise<Response>((resolve) => {
    release = resolve;
  });
  render(<PainNoteReader nearMissId="nm-1" />);
  expect(calls).toEqual([]);

  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(calls).toEqual([NOTE_URL]);
  expect(screen.getByRole('button', { name: 'Loading the note…' })).toBeDisabled();

  await act(async () => {
    release(json({ ok: true, note: 'sore after sparring' }));
  });
  await settle();
  expect(screen.getByText("Athlete's note")).toBeInTheDocument();
  expect(screen.getByText('sore after sparring')).toBeInTheDocument();
  expect(screen.queryByText("Only admins see this note. A coach's review does not cover it.")).toBeNull();
});

test("an admin's copy of a held note carries the admin-only line", async () => {
  answer = () => json({ ok: true, note: 'My coach hits me', noteAdminOnly: true });
  render(<PainNoteReader nearMissId="nm-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(screen.getByText('My coach hits me')).toBeInTheDocument();
  expect(screen.getByText("Only admins see this note. A coach's review does not cover it.")).toBeInTheDocument();
});

test('no note reads No note', async () => {
  answer = () => json({ ok: true, note: null });
  render(<PainNoteReader nearMissId="nm-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(screen.getByText('No note')).toBeInTheDocument();
});

test('a 404 says the note can no longer be opened, and offers no retry', async () => {
  answer = () => json({ error: 'Not found' }, 404);
  render(<PainNoteReader nearMissId="nm-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(screen.getByRole('alert')).toHaveTextContent('This note can no longer be opened. Speak with the athlete.');
  expect(screen.queryByRole('button', { name: 'Read the note' })).toBeNull();
});

test.each([
  ['a server error', () => json({ error: 'Server error' }, 500)],
  ['an unreadable body', () => json({ ok: true, note: 42 })],
  ['a network failure', () => Promise.reject(new Error('offline'))],
])('%s shows the reader\'s own words and the button again', async (_label, failing) => {
  answer = failing as () => Response | Promise<Response>;
  render(<PainNoteReader nearMissId="nm-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(screen.getByRole('alert')).toHaveTextContent(PAIN_NOTE_READ_FAILED);
  expect(screen.getByRole('button', { name: 'Read the note' })).toBeEnabled();
});

test('a shown note can be hidden again, and reading it again asks the server again', async () => {
  answer = () => json({ ok: true, note: 'sore after sparring' });
  render(<PainNoteReader nearMissId="nm-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(screen.getByText('sore after sparring')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Hide the note' }));
  expect(screen.queryByText('sore after sparring')).toBeNull();
  expect(screen.getByRole('button', { name: 'Read the note' })).toBeEnabled();

  fireEvent.click(screen.getByRole('button', { name: 'Read the note' }));
  await settle();
  expect(calls).toEqual([NOTE_URL, NOTE_URL]);
});
