/**
 * @jest-environment jsdom
 */

/**
 * THE PAD, AS A COACH ACTUALLY USES IT.
 *
 * Two things are being pinned, and neither is cosmetic.
 *
 * SPEED IS THE FEATURE. A coach has taped hands and the forty seconds between
 * rounds. If sending takes a dropdown, a text area and a Send button, this
 * becomes a feature that exists in the codebase and is never used -- so the
 * test counts the taps. Two: the name, the sentence. A regression that adds a
 * confirm step fails here rather than in six months of silence.
 *
 * THE ROSTER MUST STAY DULL. No counts, no "last recognized", no ordering by
 * anything but the alphabet. The moment a coach's list can be read as "who has
 * had one lately", a kid glancing at the tablet can read it as a ranking, and a
 * kid at the bottom of a visible ranking is a kid who quits.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachRecognitionPad from './CoachRecognitionPad';

const played: string[] = [];

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({
    enabled: false,
    ready: false,
    status: 'off' as const,
    play: (name: string) => {
      played.push(name);
      return false;
    },
    setEnabled: async () => false,
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> };

// jsdom carries no fetch and no Response, so responses are the minimal shape
// the components actually read -- the same seam athleteWorkspace.test.tsx uses.
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

let calls: Call[] = [];
let rosterFails = false;
let postFails = false;

const ROSTER = [
  { athlete_id: 'ath_2', full_name: 'Marcus Bell' },
  { athlete_id: 'ath_1', full_name: 'Ada Rivera' },
];

beforeEach(() => {
  calls = [];
  played.length = 0;
  rosterFails = false;
  postFails = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method, body });

    if (url.includes('/api/pilot/athletes/list')) {
      if (rosterFails) {
        return jsonResponse({ error: 'nope' }, false);
      }
      return jsonResponse({ items: ROSTER });
    }

    if (url.includes('/api/pilot/achievements/recognition')) {
      if (postFails) {
        return jsonResponse({ error: 'That did not send. Try it again.' }, false);
      }
      return jsonResponse({ ok: true, recognition: {} });
    }

    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderPad() {
  const view = render(<CoachRecognitionPad />);
  await screen.findByRole('button', { name: 'Ada Rivera' });
  return view;
}

it('sends in two taps: the name, then the sentence', async () => {
  await renderPad();

  // TAP ONE.
  fireEvent.click(screen.getByRole('button', { name: 'Marcus Bell' }));

  // TAP TWO. Tapping a sentence IS the send -- there is no third control, and
  // specifically no Send button anywhere on the surface.
  const phrase = await screen.findByRole('button', { name: 'Showed up anyway' });
  expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();

  await act(async () => {
    fireEvent.click(phrase);
  });

  const posted = calls.filter((call) => call.method === 'POST');
  expect(posted).toHaveLength(1);
  expect(posted[0].url).toContain('/api/pilot/achievements/recognition');
  expect(posted[0].body).toEqual({
    athlete_id: 'ath_2',
    kind: 'showed_up_hard_day',
    note: '',
  });
});

it('requires no typing at all', async () => {
  await renderPad();
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera' }));

  // The note field is not even mounted until a coach asks for it, so the fast
  // path never has a keyboard in it.
  expect(screen.queryByLabelText(/in your own words/i)).toBeNull();

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Good partner' }));
  });

  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('carries an optional word when the coach chose to add one', async () => {
  await renderPad();
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera' }));

  fireEvent.click(await screen.findByRole('button', { name: /add a word/i }));
  const note = screen.getByLabelText(/in your own words/i) as HTMLInputElement;
  // Capped in the markup as well as the database and the module.
  expect(note.maxLength).toBe(140);
  fireEvent.change(note, { target: { value: 'Best round you have had, kid.' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Took the correction' }));
  });

  const posted = calls.filter((call) => call.method === 'POST');
  expect(posted[0].body.note).toBe('Best round you have had, kid.');
  expect(posted[0].body.kind).toBe('took_the_correction');
});

it('tells the coach what was sent, in the words the athlete will read', async () => {
  await renderPad();
  fireEvent.click(screen.getByRole('button', { name: 'Marcus Bell' }));

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Came back' }));
  });

  // The visible confirmation carries the whole message on its own -- the stamp
  // is confirmation of this line, never a substitute for it (rule 2 of the
  // sound system).
  const status = await screen.findByRole('status');
  expect(status.textContent).toContain('Marcus Bell');
  expect(status.textContent).toContain('You came back in after a rough one');
  expect(played).toEqual(['stamp']);
});

it('does not double-send when the button is hit twice', async () => {
  await renderPad();
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera' }));

  const phrase = await screen.findByRole('button', { name: 'Left it better' });
  await act(async () => {
    fireEvent.click(phrase);
    fireEvent.click(phrase);
  });

  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('says so when the send failed, rather than claiming it landed', async () => {
  postFails = true;
  await renderPad();
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera' }));

  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Helped someone' }));
  });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('did not send');
  expect(screen.queryByRole('status')).toBeNull();
});

describe('the roster cannot be read as a ranking', () => {
  it('shows names in alphabetical order and nothing else beside them', async () => {
    await renderPad();

    const names = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((text) => text === 'Ada Rivera' || text === 'Marcus Bell');

    // Alphabetical, despite the API returning Marcus first. Any other ordering
    // -- most recent, fewest received, most active -- is a ranking.
    expect(names).toEqual(['Ada Rivera', 'Marcus Bell']);

    // No digits anywhere on a roster chip: a count beside a name is a
    // scoreboard the moment somebody looks over the coach's shoulder.
    for (const button of screen.getAllByRole('button')) {
      if (button.textContent === 'Ada Rivera' || button.textContent === 'Marcus Bell') {
        expect(button.textContent).not.toMatch(/\d/);
      }
    }
  });

  it('never suggests who is "due" one', async () => {
    const { container } = await renderPad();
    const text = container.textContent ?? '';
    for (const phrase of ['has not had', 'due for', 'overdue', 'last recognized', 'nobody has']) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });

  it('offers no negative sentence to send', async () => {
    const { container } = await renderPad();
    fireEvent.click(screen.getByRole('button', { name: 'Marcus Bell' }));
    await screen.findByRole('button', { name: 'Good partner' });

    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['concern', 'warning', 'incident', 'needs improvement', 'report']) {
      expect(text).not.toContain(word);
    }
  });
});

it('says the roster failed rather than showing an empty gym', async () => {
  rosterFails = true;
  render(<CoachRecognitionPad />);

  // No jest-dom in this project, so the assertion is that getByText resolves at
  // all -- it throws when the node is absent.
  await waitFor(() => {
    expect(screen.getByText(/roster did not load/i)).toBeTruthy();
  });
});
