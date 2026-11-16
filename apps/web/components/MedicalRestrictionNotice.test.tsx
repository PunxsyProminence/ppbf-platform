/**
 * @jest-environment jsdom
 */

// What a member (MedicalRestrictionNotice) and a guardian
// (MedicalRestrictionStatement) see of a USA Boxing medical restriction, lane
// P22c, Jason's card OW25-06 A: on file, the minimum end date, whether a
// physician's release is needed -- and nothing at all when none is in force,
// when the read fails, or when what arrived is not those three fields
// (Overwatch, P22c step 1; no new warning).

import { render, screen, waitFor } from '@testing-library/react';

import MedicalRestrictionNotice, {
  MedicalRestrictionStatement,
  isFamilyMedicalRestriction,
  medicalRestrictionSentence,
} from './MedicalRestrictionNotice';

const IN_FORCE = { on_file: true, minimum_end_date: '2026-12-01', release_needed: true };

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockRead(responder: () => Response | Promise<Response>) {
  const fetchMock = jest.fn(async () => responder());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
// jsdom has no Response; the shape the component reads is enough.
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** Let the read settle, then report what is on screen. */
async function settled(fetchMock: jest.Mock, container: HTMLElement): Promise<string> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return container.textContent ?? '';
}

describe('the sentence', () => {
  test('names the end date in words and the release while one is needed', () => {
    expect(medicalRestrictionSentence(IN_FORCE as never)).toBe(
      'No sparring until December 1, 2026 has passed and a physician’s release is on file. Training below sparring is fine.',
    );
  });

  test('without the release clause once a release is on file', () => {
    expect(medicalRestrictionSentence({ ...IN_FORCE, release_needed: false } as never)).toBe(
      'No sparring until December 1, 2026 has passed. Training below sparring is fine.',
    );
  });

  test.each([
    null, undefined, {}, [], 'on file',
    { ...IN_FORCE, on_file: false },
    { ...IN_FORCE, minimum_end_date: 'soon' },
    { ...IN_FORCE, release_needed: 'yes' },
    { on_file: true, release_needed: true },
  ])('%p is not a restriction to show', (value) => {
    expect(isFamilyMedicalRestriction(value)).toBe(false);
  });
});

describe('MedicalRestrictionNotice (the member)', () => {
  test('a restriction in force: heading and sentence, nothing else', async () => {
    const fetchMock = mockRead(() => json({ ok: true, medical_restriction: IN_FORCE }));
    const { container } = render(<MedicalRestrictionNotice />);

    expect(await screen.findByText('USA Boxing medical restriction on file')).toBeTruthy();
    expect(container.textContent).toBe(
      'USA Boxing medical restriction on file'
      + 'No sparring until December 1, 2026 has passed and a physician’s release is on file. Training below sparring is fine.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/athlete/medical-restriction'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  test.each([
    ['none in force (null)', () => json({ ok: true, medical_restriction: null })],
    ['a refused read (not an athlete)', () => json({ ok: false, error: 'Forbidden' }, 403)],
    ['a server fault', () => json({ ok: false }, 500)],
    ['a 200 that does not say ok', () => json({ medical_restriction: IN_FORCE })],
    ['a malformed value', () => json({ ok: true, medical_restriction: { on_file: true } })],
    ['a body that is not JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response],
  ])('%s: renders nothing', async (_label, responder) => {
    const fetchMock = mockRead(responder);
    const { container } = render(<MedicalRestrictionNotice />);
    expect(await settled(fetchMock, container)).toBe('');
  });

  test('an unreachable API renders nothing', async () => {
    const fetchMock = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<MedicalRestrictionNotice />);
    expect(await settled(fetchMock, container)).toBe('');
  });
});

describe('MedicalRestrictionStatement (the guardian)', () => {
  test('shows the same words for a value already read', () => {
    render(<MedicalRestrictionStatement restriction={{ ...IN_FORCE, release_needed: false }} />);
    expect(screen.getByTestId('medical-restriction-notice').textContent).toBe(
      'USA Boxing medical restriction on file'
      + 'No sparring until December 1, 2026 has passed. Training below sparring is fine.',
    );
  });

  test.each([null, undefined, { on_file: true }])('%p renders nothing', (value) => {
    const { container } = render(<MedicalRestrictionStatement restriction={value} />);
    expect(container.textContent).toBe('');
  });
});
