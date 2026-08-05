/**
 * @jest-environment jsdom
 */

/**
 * A GOAL SOMEBODY SET FOR THEMSELVES.
 *
 * What is pinned here is mostly what is NOT required. The SMART form beside
 * this one demands a category from a picklist of boxing metrics, a deadline and
 * a success metric — four required fields before an athlete is allowed to want
 * something, and no way at all to enter "show up on the days I don't want to".
 * If a future change quietly makes the date or a metric mandatory here, this
 * board becomes that form again and the whole point is gone.
 *
 * And reaching one gets the ceremony the training card already has: seal press,
 * a line of type, one bell. Not a second celebration system.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { resetAchievementCeremonyMemory } from './achievementCeremony';
import PersonalGoalBoard from './PersonalGoalBoard';

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

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

type Call = { url: string; method: string; body: Record<string, unknown> };

let calls: Call[] = [];
let goals: Array<{
  goal_id: string;
  title: string;
  why_it_matters: string;
  target_date: string | null;
  reached_at: string | null;
}> = [];

beforeEach(() => {
  calls = [];
  played.length = 0;
  goals = [];
  window.localStorage.clear();
  resetAchievementCeremonyMemory();

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method, body });

    if (url.includes('/api/pilot/goals/personal')) {
      if (method === 'GET') {
        return jsonResponse({ ok: true, items: goals });
      }
      return jsonResponse({ ok: true });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderBoard() {
  const view = render(<PersonalGoalBoard athleteId="ath_1" />);
  await waitFor(() => {
    expect(calls.some((call) => call.method === 'GET')).toBe(true);
  });
  return view;
}

it('takes a sentence and nothing else', async () => {
  await renderBoard();

  fireEvent.change(screen.getByLabelText(/what do you want to be able to do/i), {
    target: { value: 'Show up on the days I do not want to' },
  });

  // No category picklist, no success metric, and nothing marked required
  // besides the sentence itself.
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByLabelText(/success metric/i)).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /put it on the board/i }));
  });

  const posted = calls.find((call) => call.method === 'POST');
  expect(posted?.body).toEqual({
    athlete_id: 'ath_1',
    own_words: 'Show up on the days I do not want to',
    why_it_matters: '',
    target_date: '',
  });
});

it('keeps the words exactly as they were written', async () => {
  await renderBoard();

  // Not normalized, not title-cased, not rewritten into a metric. The record is
  // what they said mattered.
  const words = "be a better training partner — the kind people don't dread";
  fireEvent.change(screen.getByLabelText(/what do you want to be able to do/i), {
    target: { value: words },
  });
  fireEvent.change(screen.getByLabelText(/why it matters/i), {
    target: { value: 'because I quit last time' },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /put it on the board/i }));
  });

  const posted = calls.find((call) => call.method === 'POST');
  expect(posted?.body.own_words).toBe(words);
  expect(posted?.body.why_it_matters).toBe('because I quit last time');
});

it('will not save an empty goal, and says so instead of failing silently', async () => {
  await renderBoard();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /put it on the board/i }));
  });

  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('your own words');
});

describe('a goal cannot be failed', () => {
  it('never calls a passed date late, overdue or missed', async () => {
    goals = [{
      goal_id: 'g1',
      title: 'Run a mile without stopping',
      why_it_matters: '',
      target_date: '2020-01-01',
      reached_at: null,
    }];

    const { container } = await renderBoard();
    await waitFor(() => {
      expect(container.textContent).toContain('Run a mile without stopping');
    });

    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['overdue', 'late', 'missed', 'failed', 'expired', 'behind']) {
      expect(text).not.toContain(word);
    }
    // A date that has passed is just a date somebody wrote down once.
    expect(container.textContent).toContain('Wrote down: Jan 1 2020');
  });

  it('offers no way to mark one failed or abandoned', async () => {
    goals = [{ goal_id: 'g1', title: 'Keep my hands up', why_it_matters: '', target_date: null, reached_at: null }];
    await renderBoard();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /i did it/i })).toBeTruthy();
    });
    for (const label of [/give up/i, /abandon/i, /failed/i, /delete/i, /remove/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });
});

describe('reaching one gets the ceremony the card already has', () => {
  it('presses nothing on first sight, however many are already done', async () => {
    goals = [
      { goal_id: 'g1', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: '2026-03-01' },
      { goal_id: 'g2', title: 'Wrap my own hands', why_it_matters: '', target_date: null, reached_at: '2026-04-02' },
    ];

    const { container } = await renderBoard();
    await waitFor(() => {
      expect(container.textContent).toContain('Run a mile');
    });

    // Opening the board on a new phone crosses nothing.
    expect(container.querySelector('.tcard-earned')).toBeNull();
    expect(container.querySelector('.tcard-seal-slot--pressed')).toBeNull();
    expect(played).toEqual([]);
  });

  it('presses the seal, says it in words, and rings once when one is reached', async () => {
    goals = [{
      goal_id: 'g1',
      title: 'Run a mile without stopping',
      why_it_matters: '',
      target_date: null,
      reached_at: null,
    }];

    const { container } = await renderBoard();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /i did it/i })).toBeTruthy();
    });
    expect(played).toEqual([]);

    // They did it. The reload after the PATCH is what carries the crossing.
    goals = [{ ...goals[0], reached_at: '2026-08-03' }];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /i did it/i }));
    });

    await waitFor(() => {
      expect(container.querySelector('.tcard-earned')).not.toBeNull();
    });

    // The words carry the whole message on their own -- rule 2 of the sound
    // system, and Law 3 for the screen reader.
    const note = container.querySelector('.tcard-earned');
    expect(note?.getAttribute('role')).toBe('status');
    expect(note?.textContent).toContain('Run a mile without stopping');
    expect(note?.textContent).toContain('You said you would. You did.');
    expect(container.querySelector('.tcard-seal-slot--pressed')).not.toBeNull();

    // ONE bell. The same one the training card rings, not a second celebration
    // invented for goals.
    expect(played).toEqual(['bell']);
  });

  it('does not ring again on a later render of the same state', async () => {
    goals = [{ goal_id: 'g1', title: 'Wrap my own hands', why_it_matters: '', target_date: null, reached_at: null }];
    const { rerender } = await renderBoard();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /i did it/i })).toBeTruthy();
    });

    goals = [{ ...goals[0], reached_at: '2026-08-03' }];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /i did it/i }));
    });
    await waitFor(() => {
      expect(played).toEqual(['bell']);
    });

    await act(async () => {
      rerender(<PersonalGoalBoard athleteId="ath_1" />);
    });

    expect(played).toEqual(['bell']);
  });
});

it('is silent and read-only for a reader who is not the athlete', async () => {
  goals = [{ goal_id: 'g1', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: '2026-03-01' }];
  const { container } = render(<PersonalGoalBoard athleteId="ath_1" readOnly />);

  await waitFor(() => {
    expect(container.textContent).toContain('Run a mile');
  });

  expect(screen.queryByLabelText(/what do you want to be able to do/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /i did it/i })).toBeNull();
  expect(played).toEqual([]);
});

it('says a load failed rather than showing an empty board', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ error: 'no' }, false)) as unknown as typeof fetch;
  const { container } = render(<PersonalGoalBoard athleteId="ath_1" />);

  await waitFor(() => {
    expect(container.textContent).toContain('did not load');
  });
  expect(container.textContent).toContain('nothing you wrote has gone anywhere');
});
