/**
 * @jest-environment jsdom
 */

/**
 * OW25-47 A (Jason: "A: Count restrictions and missing waivers, name the child
 * (Recommended)"; lane SH, PR SH-3). The Parent Hub's Safety & Consent line
 * says, per child, what is waiting: active training holds, gates awaiting
 * clearance, a medical restriction in force (or that it could not be
 * checked), and missing waivers. It is read only from /api/pilot/parent/safety,
 * which answers only for this account's own linked children, and it names
 * only what the ruling names: no restriction detail, date, release flag or
 * waiver type.
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import ParentHub, { safetyChildFromItem, safetyChildSentence } from './ParentHub';

const TAIL = 'This is not a punishment — see the Safety page for details.';
const NEUTRAL = /Check your child.s active training-hold and safety-gate status/;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const SIGNED = { general: 'signed', medical_release: 'signed', photo_media: 'signed', travel: 'signed' };

/** One item as the parent safety route sends it (route.ts:243-257). */
function item(overrides: Record<string, unknown> = {}) {
  return {
    athlete_id: 'ath_1',
    athlete_name: 'First Child',
    hold: null,
    gates: [],
    waivers: { ...SIGNED },
    medical_restriction: null,
    ...overrides,
  };
}

// A restriction and waivers carrying every detail the line must not repeat.
const RESTRICTION = { on_file: true, minimum_end_date: '2026-12-24', release_needed: true };
const HOLD = {
  hold_id: 'hold-1',
  scope: 'contact_only',
  reason_category: 'medical',
  reason_text: 'Concussion protocol',
  placed_by_name: 'Coach Ray',
  placed_at: '2026-11-01T12:00:00.000Z',
};

function mockSafety(response: Response | (() => never) | Promise<never>) {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/parent/safety')) {
      if (typeof response === 'function') return response();
      return response;
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }] });
    }
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    return jsonResponse({ ok: true, items: [] });
  }) as unknown as typeof fetch;
}

async function lineFor(items: unknown[]): Promise<HTMLElement> {
  mockSafety(jsonResponse({ ok: true, items }));
  render(<ParentHub />);
  return screen.findByTestId('parent-safety-line');
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('the Safety & Consent line on the hub', () => {
  test('nothing to report: the neutral line, no child named, no tail', async () => {
    mockSafety(jsonResponse({ ok: true, items: [item()] }));
    render(<ParentHub />);
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.queryByTestId('parent-safety-line')).toBeNull();
    expect(screen.queryByText(new RegExp(TAIL))).toBeNull();
  });

  test('a hold only', async () => {
    const line = await lineFor([item({ hold: HOLD })]);
    expect(line.textContent).toBe(`First Child: 1 active training hold. ${TAIL}`);
  });

  test('gates only, counted as today: flagged and blocked, not passed', async () => {
    const line = await lineFor([item({
      gates: [{ outcome: 'flagged' }, { outcome: 'blocked' }, { outcome: 'passed' }, { outcome: 'not_evaluated' }],
    })]);
    expect(line.textContent).toBe(`First Child: 2 gates awaiting clearance. ${TAIL}`);
  });

  test('a restriction in force only', async () => {
    const line = await lineFor([item({ medical_restriction: RESTRICTION })]);
    expect(line.textContent).toBe(`First Child: a medical restriction in force. ${TAIL}`);
  });

  test('missing waivers only', async () => {
    const line = await lineFor([item({ waivers: { ...SIGNED, medical_release: 'missing', travel: 'missing' } })]);
    expect(line.textContent).toBe(`First Child: 2 waivers missing. ${TAIL}`);
  });

  test('one missing waiver reads in the singular', async () => {
    const line = await lineFor([item({ waivers: { ...SIGNED, general: 'missing' } })]);
    expect(line.textContent).toBe(`First Child: 1 waiver missing. ${TAIL}`);
  });

  test('declined, withdrawn and photo_only are not counted as missing', async () => {
    mockSafety(jsonResponse({
      ok: true,
      items: [item({ waivers: { general: 'declined', medical_release: 'withdrawn', photo_media: 'photo_only', travel: 'signed' } })],
    }));
    render(<ParentHub />);
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.queryByTestId('parent-safety-line')).toBeNull();
  });

  test('a restriction that could not be read says so, and is neither "in force" nor nothing', async () => {
    const line = await lineFor([item({ medical_restriction: null, medical_restriction_unread: true })]);
    expect(line.textContent).toBe(`First Child: medical restriction could not be checked. ${TAIL}`);
    expect(line).not.toHaveTextContent('in force');
    expect(screen.queryByText(NEUTRAL)).toBeNull();
  });

  test('everything at once, in the ruling\'s order', async () => {
    const line = await lineFor([item({
      hold: HOLD,
      gates: [{ outcome: 'flagged' }, { outcome: 'blocked' }],
      medical_restriction: RESTRICTION,
      waivers: { ...SIGNED, travel: 'missing', general: 'missing' },
    })]);
    expect(line.textContent).toBe(
      `First Child: 1 active training hold, 2 gates awaiting clearance, a medical restriction in force, 2 waivers missing. ${TAIL}`,
    );
  });

  test('two children in different states: one sentence each, a child with nothing is not named', async () => {
    const line = await lineFor([
      item({ athlete_id: 'ath_1', athlete_name: 'First Child', medical_restriction: RESTRICTION }),
      item({ athlete_id: 'ath_2', athlete_name: 'Second Child', waivers: { ...SIGNED, travel: 'missing' }, gates: [{ outcome: 'flagged' }] }),
      item({ athlete_id: 'ath_3', athlete_name: 'Third Child' }),
    ]);
    expect(line.textContent).toBe(
      `First Child: a medical restriction in force. Second Child: 1 gate awaiting clearance, 1 waiver missing. ${TAIL}`,
    );
    expect(line).not.toHaveTextContent('Third Child');
    // Nothing from one child is counted under another.
    expect(line).not.toHaveTextContent('First Child: a medical restriction in force, ');
  });

  test('a child with no name on file reads "Your child"', async () => {
    const line = await lineFor([item({ athlete_name: null, hold: HOLD })]);
    expect(line.textContent).toBe(`Your child: 1 active training hold. ${TAIL}`);
  });

  test('a parent of another child: the line names only the children the route returned', async () => {
    // The route answers for this account's own linked children only
    // (route.ts guardianAthleteIds; route.test.ts proves another family's
    // child is never read). The hub adds no child of its own: the switcher's
    // roster lists a child the safety route did not return, and that child is
    // never named or counted.
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/pilot/parent/safety')) {
        return jsonResponse({ ok: true, items: [item({ athlete_id: 'ath_1', athlete_name: 'First Child', hold: HOLD })] });
      }
      if (url.includes('/api/pilot/athletes/list')) {
        return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'First Child' }, { athlete_id: 'ath_9', full_name: 'Other Family Child' }] });
      }
      if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] });
      if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
    render(<ParentHub />);
    const line = await screen.findByTestId('parent-safety-line');
    expect(line.textContent).toBe(`First Child: 1 active training hold. ${TAIL}`);
    expect(line).not.toHaveTextContent('Other Family Child');
  });

  test('the line carries no restriction detail, date, release flag, hold reason, placer or waiver type', async () => {
    const line = await lineFor([item({
      hold: HOLD,
      gates: [{ gate_key: 'sparring_readiness', name: 'Sparring readiness', category: 'contact', outcome: 'flagged', evaluated_at: '2026-11-02T12:00:00.000Z' }],
      medical_restriction: { ...RESTRICTION, source: 'usa_boxing', loss_of_consciousness: true, note: 'Knocked down', restriction_type: 'concussion' },
      waivers: { general: 'missing', medical_release: 'missing', photo_media: 'missing', travel: 'missing' },
    })]);
    const text = line.textContent ?? '';
    for (const forbidden of [
      '2026', '12-24', 'Dec', 'release', 'Release', 'usa_boxing', 'USA Boxing', 'consciousness', 'Knocked', 'concussion', 'Concussion',
      'contact_only', 'medical,', 'Coach Ray', 'Sparring', 'sparring', 'general', 'General', 'medical_release', 'photo', 'Photo', 'travel', 'Travel',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toBe(
      `First Child: 1 active training hold, 1 gate awaiting clearance, a medical restriction in force, 4 waivers missing. ${TAIL}`,
    );
  });

  test('a failed read and a slow read keep their own lines', async () => {
    mockSafety(jsonResponse({ error: 'nope' }, false));
    const first = render(<ParentHub />);
    expect(await screen.findByText(/Couldn.t check right now. Use View Safety Status to see it./)).toBeInTheDocument();
    expect(screen.queryByTestId('parent-safety-line')).toBeNull();
    first.unmount();

    mockSafety(new Promise<never>(() => {}));
    render(<ParentHub />);
    expect(await screen.findByText('Checking safety status')).toBeInTheDocument();
  });

  test('a read that throws is the failed-read line, never the neutral line', async () => {
    mockSafety(() => {
      throw new TypeError('Failed to fetch');
    });
    render(<ParentHub />);
    expect(await screen.findByText(/Couldn.t check right now/)).toBeInTheDocument();
    expect(screen.queryByText(NEUTRAL)).toBeNull();
  });

  test('an answer with no items list is the failed-read line, never the neutral line', async () => {
    mockSafety(jsonResponse({ ok: true }));
    render(<ParentHub />);
    expect(await screen.findByText(/Couldn.t check right now/)).toBeInTheDocument();
    expect(screen.queryByText(NEUTRAL)).toBeNull();
    expect(screen.queryByTestId('parent-safety-line')).toBeNull();
  });

  test('no children returned: the neutral line', async () => {
    mockSafety(jsonResponse({ ok: true, items: [] }));
    render(<ParentHub />);
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  });
});

describe('safetyChildFromItem / safetyChildSentence', () => {
  test('a blank name reads "Your child"', () => {
    expect(safetyChildSentence(safetyChildFromItem({ athlete_name: '   ', hold: {} }))).toBe('Your child: 1 active training hold.');
  });

  test('unread wins over a stray restriction value: never "in force" when the read failed', () => {
    const child = safetyChildFromItem({ medical_restriction: RESTRICTION, medical_restriction_unread: true });
    expect(child.restrictionInForce).toBe(false);
    expect(safetyChildSentence(child)).toBe('Your child: medical restriction could not be checked.');
  });

  test('nothing waiting is no sentence at all', () => {
    expect(safetyChildSentence(safetyChildFromItem({ athlete_name: 'A', waivers: SIGNED }))).toBeNull();
    expect(safetyChildSentence(safetyChildFromItem({}))).toBeNull();
  });
});
