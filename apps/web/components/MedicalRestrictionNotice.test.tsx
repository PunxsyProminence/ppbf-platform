/**
 * @jest-environment jsdom
 */

// What a member (MedicalRestrictionNotice) and a guardian
// (MedicalRestrictionStatement) see of a USA Boxing medical restriction, lane
// P22c, Jason's card OW25-06 A: on file, the minimum end date, whether a
// physician's release is needed -- with the Restricted mark, never the
// medical-stop mark (OD-2026-11-17-009 ruling 5, OW25-38 A). Nothing at all
// when none is in force. A read that fails, or what arrived is not null and
// not those three fields, shows ONE neutral line and never the "none" state
// (ruling 3, OW25-35 A).

import { render, screen, waitFor } from '@testing-library/react';

import MedicalRestrictionNotice, {
  MEDICAL_RESTRICTION_UNREAD_LINE,
  MedicalRestrictionStatement,
  RestrictedMark,
  familyRestrictionRead,
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
      '▲Restricted'
      + 'USA Boxing medical restriction on file'
      + 'No sparring until December 1, 2026 has passed and a physician’s release is on file. Training below sparring is fine.',
    );
    expect(screen.queryByTestId('medical-restriction-unread')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/pilot/athlete/medical-restriction'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  test.each([
    ['none in force (null)', () => json({ ok: true, medical_restriction: null })],
    ['signed out (401)', () => json({ error: 'Unauthorized' }, 401)],
    ['a refused read (not an athlete, 403)', () => json({ ok: false, error: 'Forbidden' }, 403)],
    ['no live record (404)', () => json({ error: 'Not found' }, 404)],
  ])('%s: renders nothing', async (_label, responder) => {
    const fetchMock = mockRead(responder);
    const { container } = render(<MedicalRestrictionNotice />);
    expect(await settled(fetchMock, container)).toBe('');
  });

  test.each([
    ['a server fault (500)', () => json({ ok: false }, 500)],
    ['a busy server (503)', () => json({ ok: false }, 503)],
    ['a 200 that does not say ok', () => json({ medical_restriction: IN_FORCE })],
    ['a 200 with no medical_restriction field', () => json({ ok: true })],
    ['a malformed value', () => json({ ok: true, medical_restriction: { on_file: true } })],
    ['a body that is not JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response],
  ])('%s: the one neutral line, never the "none" state', async (_label, responder) => {
    const fetchMock = mockRead(responder);
    const { container } = render(<MedicalRestrictionNotice />);
    expect(await settled(fetchMock, container)).toBe(MEDICAL_RESTRICTION_UNREAD_LINE);
    const line = screen.getByTestId('medical-restriction-unread');
    // Neutral: plain body text, a status (not an alert), no glyph, no mark.
    expect(line.className).toBe('t-body');
    expect(line.getAttribute('role')).toBe('status');
    expect(container.querySelector('i, .badge, [role="alert"]')).toBeNull();
  });

  test('an unreachable API shows the neutral line', async () => {
    const fetchMock = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<MedicalRestrictionNotice />);
    expect(await settled(fetchMock, container)).toBe(MEDICAL_RESTRICTION_UNREAD_LINE);
  });

  test('the line is the card wording, word for word, with the closing period', () => {
    expect(MEDICAL_RESTRICTION_UNREAD_LINE).toBe('Medical restriction: could not be checked just now; your coach can see it.');
  });
});

describe('familyRestrictionRead', () => {
  test('null is none; the three fields are in force; anything else is not read', () => {
    expect(familyRestrictionRead(null, false)).toEqual({ kind: 'none' });
    expect(familyRestrictionRead(IN_FORCE, false)).toEqual({ kind: 'in_force', restriction: IN_FORCE });
    for (const value of [undefined, {}, [], 'on file', { on_file: true }]) {
      expect(familyRestrictionRead(value, false)).toEqual({ kind: 'unread' });
    }
  });

  test('a failed read is not read, whatever value came with it', () => {
    expect(familyRestrictionRead(null, true)).toEqual({ kind: 'unread' });
    expect(familyRestrictionRead(IN_FORCE, true)).toEqual({ kind: 'unread' });
  });
});

describe('the Restricted mark (OD-2026-11-17-009 ruling 5)', () => {
  test('is the restricted rung with ▲ and the word, never the medical-stop mark', () => {
    render(<RestrictedMark />);
    const mark = screen.getByTestId('restricted-mark');
    expect(mark.className).toBe('badge badge--restricted');
    expect(mark.textContent).toBe('▲Restricted');
    expect(mark.outerHTML).not.toMatch(/locked|✕/);
    expect(mark.querySelector('i')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('MedicalRestrictionStatement (the guardian)', () => {
  test('shows the same words for a value already read', () => {
    render(<MedicalRestrictionStatement restriction={{ ...IN_FORCE, release_needed: false }} />);
    expect(screen.getByTestId('medical-restriction-notice').textContent).toBe(
      '▲Restricted'
      + 'USA Boxing medical restriction on file'
      + 'No sparring until December 1, 2026 has passed. Training below sparring is fine.',
    );
  });

  test.each([null, undefined, { on_file: true }])('%p renders nothing', (value) => {
    const { container } = render(<MedicalRestrictionStatement restriction={value} />);
    expect(container.textContent).toBe('');
  });
});
