/**
 * @jest-environment jsdom
 */

// OD-2026-10-17-003 (lane L43): an athlete's milestone "I did it" is one tap, and their own slip
// can be taken back for ten minutes with a short Undo line. The server holds the window, the
// owner and self-only (milestoneUndo.pg.test.ts); this file holds what the panel offers, and
// F-134: a goal or milestone taken back and later really reached rings the bell again.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import AthleteAchievements from './AthleteAchievements';
import PersonalGoalBoard from './PersonalGoalBoard';
import { achievementCeremonyKey, readCelebrated, resetAchievementCeremonyMemory } from './achievementCeremony';

const mockPlay = jest.fn(() => false);
jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: true, ready: true, status: 'on' as const, play: mockPlay, setEnabled: async () => true }),
}));

const MILE = 'conditioning.mile_unbroken';
const MILE_LABEL = 'Ran a mile without stopping';
const UNDO_MILE = { name: `Undo "${MILE_LABEL}"` };

function json(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

type Award = { milestone_key: string; awarded_by_role: string; note: string; awarded_at: string };

/** A server holding one athlete's awards: a mark stores 'self' at the current clock, an undo takes it off. */
function serve(initial: Award[] = [], undoAnswer: 'ok' | 409 | 'pending' = 'ok', completedSessions = 0) {
  let awards = [...initial];
  const posts: Array<Record<string, unknown>> = [];
  let release: () => void = () => {};
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/achievements/milestones') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { milestone_key: string; undo?: boolean };
      posts.push(body);
      if (body.undo) {
        if (undoAnswer === 409) return json({ error: 'That can no longer be undone.' }, false, 409);
        if (undoAnswer === 'pending') {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        awards = awards.filter((award) => award.milestone_key !== body.milestone_key);
        return json({ ok: true, undone: { milestone_key: body.milestone_key } });
      }
      awards = [...awards, { milestone_key: body.milestone_key, awarded_by_role: 'self', note: '', awarded_at: new Date().toISOString() }];
      return json({ ok: true }, true, 201);
    }
    if (url.includes('/achievements/milestones')) {
      return json({ ok: true, program: 'fitness', completed_sessions: completedSessions, items: awards });
    }
    if (url.includes('/achievements/recognition') || url.includes('/achievements/mentorships')) {
      return json({ ok: true, items: [] });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { posts, release: () => release() };
}

/** The milestone's own card on the path (the ceremony line above the path also names it). */
function card(label: string): HTMLElement {
  const node = screen.getAllByText(label).map((match) => match.closest('li')).find(Boolean);
  if (!node) throw new Error(`no card for ${label}`);
  return node as HTMLElement;
}

async function renderPanel(audience: 'athlete' | 'family' = 'athlete') {
  render(<AthleteAchievements athleteId="ath_1" audience={audience} />);
  await screen.findByText(MILE_LABEL);
}

beforeEach(() => {
  mockPlay.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  resetAchievementCeremonyMemory();
  window.localStorage.clear();
});

describe('the milestone Undo line', () => {
  test("a fresh mark of the athlete's own offers Undo, and Undo sends their undo and puts it back ahead", async () => {
    const server = serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: new Date(Date.now() - 60_000).toISOString() }]);
    await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', UNDO_MILE));
    });

    expect(server.posts).toEqual([{ athlete_id: 'ath_1', milestone_key: MILE, undo: true }]);
    await waitFor(() => expect(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' })).toBeTruthy());
    expect(screen.queryByRole('button', UNDO_MILE)).toBeNull();
  });

  test("a coach's award never offers Undo, however fresh", async () => {
    serve([{ milestone_key: MILE, awarded_by_role: 'coach', note: '', awarded_at: new Date().toISOString() }]);
    await renderPanel();

    expect(within(card(MILE_LABEL)).getByText(/— earned/)).toBeTruthy();
    expect(screen.queryByRole('button', UNDO_MILE)).toBeNull();
  });

  test('a mark older than ten minutes offers no Undo', async () => {
    serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: new Date(Date.now() - 11 * 60_000).toISOString() }]);
    await renderPanel();

    expect(within(card(MILE_LABEL)).getByText(/— earned/)).toBeTruthy();
    expect(screen.queryByRole('button', UNDO_MILE)).toBeNull();
  });

  test('the Undo line goes away once ten minutes have passed', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T20:00:00.000Z') });
    serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: '2026-10-17T19:59:00.000Z' }]);
    render(<AthleteAchievements athleteId="ath_1" />);
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(screen.getByRole('button', UNDO_MILE)).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.queryByRole('button', UNDO_MILE)).toBeNull();
  });

  test('the header says what stays, and tells only the athlete about their own Undo', async () => {
    serve();
    await renderPanel();
    expect(screen.getByText('Earned milestones stay. If you marked one yourself by mistake, you can undo it for 10 minutes.')).toBeTruthy();
    expect(screen.queryByText(/nothing here ever comes off/i)).toBeNull();
  });

  test('the family surface is offered no Undo', async () => {
    serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: new Date().toISOString() }]);
    render(<AthleteAchievements athleteId="ath_1" audience="family" />);
    await screen.findByText('Ran a full mile without stopping to walk');

    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
    expect(screen.getByText('Earned milestones stay.')).toBeTruthy();
    expect(screen.queryByText(/undo it for 10 minutes/)).toBeNull();
  });

  test('when the server says the window has closed, the panel says so and the award stands', async () => {
    serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: new Date(Date.now() - 9 * 60_000).toISOString() }], 409);
    await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', UNDO_MILE));
    });

    await waitFor(() => expect(within(card(MILE_LABEL)).getByRole('status')).toHaveTextContent('That can no longer be undone.'));
    expect(within(card(MILE_LABEL)).getByText(/— earned/)).toBeTruthy();
    // Refused once, never offered again for that mark, whatever this device's clock says.
    expect(screen.queryByRole('button', UNDO_MILE)).toBeNull();
  });

  test('a seal the session count earns offers no Undo, even with a self row behind it', async () => {
    serve([{ milestone_key: 'consistency.first_session', awarded_by_role: 'self', note: '', awarded_at: new Date().toISOString() }], 'ok', 1);
    await renderPanel();

    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  test('while the slip can still be taken back, the ceremony does not say it never comes off', async () => {
    serve();
    await renderPanel();

    await act(async () => {
      fireEvent.click(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' }));
    });
    await screen.findByRole('button', UNDO_MILE);
    expect(screen.getByText('Earned.')).toBeTruthy();
    expect(screen.queryByText('Earned. It never comes off.')).toBeNull();
  });

  test('two Undo presses before the first is answered send one', async () => {
    const server = serve([{ milestone_key: MILE, awarded_by_role: 'self', note: '', awarded_at: new Date().toISOString() }], 'pending');
    await renderPanel();

    const undo = screen.getByRole('button', UNDO_MILE);
    act(() => {
      undo.click();
      undo.click();
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(undo).toBeDisabled();
    await act(async () => {
      server.release();
    });
    expect(server.posts).toHaveLength(1);
  });
});

describe('F-134: taken back, then really reached, rings again', () => {
  test('a milestone: the slip rings, Undo, the real mark rings a second time', async () => {
    serve();
    await renderPanel();
    expect(mockPlay).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' }));
    });
    await screen.findByRole('button', UNDO_MILE);
    expect(mockPlay).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', UNDO_MILE));
    });
    await waitFor(() => expect(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' })).toBeTruthy());
    // The panel does not keep saying "Earned." for a milestone taken back.
    expect(screen.queryByText('Earned. It never comes off.')).toBeNull();

    await act(async () => {
      fireEvent.click(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' }));
    });
    await screen.findByRole('button', UNDO_MILE);
    expect(mockPlay).toHaveBeenCalledTimes(2);
  });

  test('a refused Undo forgets nothing: the award stands and a re-read does not ring again', async () => {
    serve([], 409);
    await renderPanel();

    await act(async () => {
      fireEvent.click(within(card(MILE_LABEL)).getByRole('button', { name: 'I did it' }));
    });
    await screen.findByRole('button', UNDO_MILE);
    expect(mockPlay).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', UNDO_MILE));
    });
    await waitFor(() => expect(within(card(MILE_LABEL)).getByRole('status')).toHaveTextContent('That can no longer be undone.'));
    expect(mockPlay).toHaveBeenCalledTimes(1);
    // Nothing was forgotten: the key is still on this athlete's record.
    expect(readCelebrated(achievementCeremonyKey('ath_1'))).toContain(MILE);
  });

  test('an own-words goal: the slip rings, Undo, the real reach rings a second time', async () => {
    let reachedAt: string | null = null;
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { undo?: boolean };
        reachedAt = body.undo ? null : new Date().toISOString();
        return json({ ok: true });
      }
      return json({
        items: [{ goal_id: 'g1', own_words: 'Run a mile', title: 'Run a mile', why_it_matters: '', target_date: null, reached_at: reachedAt, created_at: '2026-10-01T12:00:00Z' }],
      });
    }) as unknown as typeof fetch;
    render(<PersonalGoalBoard athleteId="ath_1" />);

    const did = await screen.findByRole('button', { name: 'I did it' });
    await act(async () => {
      fireEvent.click(did);
    });
    await screen.findByRole('button', { name: 'Undo "Run a mile"' });
    expect(mockPlay).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo "Run a mile"' }));
    });
    const again = await screen.findByRole('button', { name: 'I did it' });
    await act(async () => {
      fireEvent.click(again);
    });
    await screen.findByRole('button', { name: 'Undo "Run a mile"' });
    expect(mockPlay).toHaveBeenCalledTimes(2);
  });
});
