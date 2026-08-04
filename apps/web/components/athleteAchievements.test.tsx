/**
 * @jest-environment jsdom
 */

/**
 * THE PANEL AS EACH OF THE THREE READERS SEES IT.
 *
 * A fitness-only member, who must find a whole path rather than a boxing ladder
 * with the fighting greyed out. An athlete crossing something, who must get the
 * one ceremony this application has rather than a second one invented for
 * achievements. And a parent, who must be told the same facts in the words they
 * actually came to hear.
 *
 * The fourth reader is the one nobody wants: a kid comparing themselves to the
 * kid next to them. Nothing rendered here gives them anything to compare.
 */

import { act, render, screen, waitFor } from '@testing-library/react';

import { resetAchievementCeremonyMemory } from './achievementCeremony';
import AthleteAchievements from './AthleteAchievements';

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

let program = 'fitness';
let completedSessions = 0;
let awards: Array<{ milestone_key: string; awarded_by_role: string; note: string; awarded_at: string }> = [];
let recognitions: Array<Record<string, unknown>> = [];
let mentorships: Array<Record<string, unknown>> = [];
let milestonesFail = false;

beforeEach(() => {
  played.length = 0;
  window.localStorage.clear();
  resetAchievementCeremonyMemory();
  program = 'fitness';
  completedSessions = 0;
  awards = [];
  recognitions = [];
  mentorships = [];
  milestonesFail = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/achievements/milestones')) {
      if (milestonesFail) return jsonResponse({ error: 'no' }, false);
      return jsonResponse({
        ok: true,
        program,
        completed_sessions: completedSessions,
        items: awards,
      });
    }
    if (url.includes('/achievements/recognition')) {
      return jsonResponse({ ok: true, items: recognitions });
    }
    if (url.includes('/achievements/mentorships')) {
      return jsonResponse({ ok: true, items: mentorships });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderPanel(props: Partial<React.ComponentProps<typeof AthleteAchievements>> = {}) {
  const view = render(<AthleteAchievements athleteId="ath_1" {...props} />);
  await waitFor(() => {
    expect(screen.getByText(/nothing here ever comes off/i)).toBeTruthy();
  });
  return view;
}

describe('a fitness-only member gets a complete path', () => {
  it('shows four full tracks and no competition track at all', async () => {
    const { container } = await renderPanel();

    for (const track of ['Showing Up', 'Engine', 'Craft', 'The Room']) {
      expect(screen.getByRole('region', { name: track })).toBeTruthy();
    }

    // ABSENT, not greyed out. A rendered rung somebody can never reach tells
    // them they are the incomplete version of somebody else; a rung the
    // renderer was never handed cannot.
    expect(screen.queryByRole('region', { name: 'Competition' })).toBeNull();
    expect(container.textContent).not.toContain('First bout');
    expect(container.textContent).not.toContain('sparring');
  });

  it('never says why something is not earned yet', async () => {
    const { container } = await renderPanel();
    const text = (container.textContent ?? '').toLowerCase();
    // If an unearned entry could carry a reason, its absence would be readable
    // backwards as "not cleared", "not allowed", "not good enough".
    for (const word of ['locked', 'not cleared', 'requires', 'eligible', 'unlock', 'restricted']) {
      expect(text).not.toContain(word);
    }
  });

  it('shows a competitive athlete the same four plus one, not a different system', async () => {
    program = 'competitive';
    await renderPanel();

    for (const track of ['Showing Up', 'Engine', 'Craft', 'The Room', 'Competition']) {
      expect(screen.getByRole('region', { name: track })).toBeTruthy();
    }
  });
});

describe('an absence takes nothing away', () => {
  it('holds everything earned when the count stops moving', async () => {
    // Forty sessions and two marked milestones, then months out under the
    // safety gate. What they hold is what they held.
    completedSessions = 40;
    awards = [
      { milestone_key: 'conditioning.mile_unbroken', awarded_by_role: 'self', note: '', awarded_at: '2026-02-01' },
      { milestone_key: 'community.helped_someone_new', awarded_by_role: 'coach', note: '', awarded_at: '2026-02-08' },
    ];

    const { container, rerender } = await renderPanel();
    const before = (container.textContent ?? '').match(/✓/g)?.length ?? 0;
    expect(before).toBeGreaterThan(0);

    // Re-render months later with the identical ledger: nothing has decayed,
    // nothing has expired, and no copy anywhere mentions the gap.
    await act(async () => {
      rerender(<AthleteAchievements athleteId="ath_1" />);
    });

    const after = (container.textContent ?? '').match(/✓/g)?.length ?? 0;
    expect(after).toBe(before);
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of ['streak', 'expired', 'lapsed', 'missed', 'in a row', 'consecutive']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the ceremony is the one this application already has', () => {
  it('presses nothing the first time it sees somebody, however much is on the record', async () => {
    completedSessions = 90;
    awards = [{ milestone_key: 'craft.jab_lands_clean', awarded_by_role: 'coach', note: '', awarded_at: '2026-01-01' }];

    const { container } = await renderPanel();

    // Opening it on a new phone crosses nothing -- they are looking at history.
    expect(container.querySelector('.tcard-seal-slot--pressed')).toBeNull();
    expect(container.querySelector('.tcard-earned')).toBeNull();
    expect(played).toEqual([]);
  });

  it('presses the seal, says it in words, and rings once on the crossing', async () => {
    completedSessions = 4;
    const { container, rerender } = await renderPanel();
    expect(played).toEqual([]);

    // The fifth session lands.
    completedSessions = 5;
    await act(async () => {
      rerender(<AthleteAchievements athleteId="ath_1" key="reload" />);
    });

    await waitFor(() => {
      expect(container.querySelector('.tcard-earned')).not.toBeNull();
    });

    // Law 3 and rule 2 of the sound system: the words carry the whole message
    // on their own, for the volume-down and the screen reader.
    const note = container.querySelector('.tcard-earned');
    expect(note?.getAttribute('role')).toBe('status');
    expect(note?.textContent).toContain('5 sessions logged');
    expect(container.querySelector('.tcard-seal-slot--pressed')).not.toBeNull();
    expect(played).toEqual(['bell']);
  });
});

describe('what a coach said lands here, reading like a person said it', () => {
  it('shows the sentence, the coach\'s name, and the day', async () => {
    recognitions = [{
      recognition_id: 'r1',
      coach_display_name: 'Coach Jason',
      kind: 'showed_up_hard_day',
      note: 'Best round you have had.',
      created_at: '2026-07-30T18:00:00.000Z',
    }];

    const { container } = await renderPanel();

    expect(container.textContent).toContain('You showed up on a day it would have been easy not to.');
    expect(container.textContent).toContain('Best round you have had.');
    expect(container.textContent).toContain('Coach Jason');
    expect(container.textContent).toContain('Jul 30 2026');
  });

  it('says it is empty rather than pretending, and never counts it', async () => {
    const { container } = await renderPanel();
    expect(container.textContent).toContain('This fills up when a coach catches you doing something right.');
    // No tally beside the heading -- a number of compliments is the one figure
    // on this panel that two kids would immediately compare.
    expect(container.textContent).not.toMatch(/\d+\s+recognitions?/i);
  });
});

describe('mentorship is visible from both ends', () => {
  it('reads one way for the mentor and the other for the mentee', async () => {
    mentorships = [
      {
        mentorship_id: 'm1',
        mentor_athlete_id: 'ath_1',
        mentor_name: 'Ada Rivera',
        mentee_athlete_id: 'ath_9',
        mentee_name: 'Sam Doyle',
        started_on: '2026-03-01',
        ended_on: null,
      },
      {
        mentorship_id: 'm2',
        mentor_athlete_id: 'ath_4',
        mentor_name: 'Marcus Bell',
        mentee_athlete_id: 'ath_1',
        mentee_name: 'Ada Rivera',
        started_on: '2026-01-05',
        ended_on: null,
      },
    ];

    const { container } = await renderPanel();
    expect(container.textContent).toContain('You mentor Sam Doyle');
    expect(container.textContent).toContain('Marcus Bell mentors you');
  });

  it('treats a closed pairing as history, never as a failure', async () => {
    mentorships = [{
      mentorship_id: 'm3',
      mentor_athlete_id: 'ath_1',
      mentor_name: 'Ada Rivera',
      mentee_athlete_id: 'ath_9',
      mentee_name: 'Sam Doyle',
      started_on: '2025-09-01',
      ended_on: '2026-04-01',
    }];

    const { container } = await renderPanel();
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).toContain('sam doyle');
    for (const word of ['failed', 'unsuccessful', 'did not work', 'terminated']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the family surface translates the same facts', () => {
  it('uses the parent wording and never the gym wording', async () => {
    completedSessions = 13;
    awards = [{ milestone_key: 'craft.slip_and_return', awarded_by_role: 'coach', note: '', awarded_at: '2026-05-01' }];
    recognitions = [{
      recognition_id: 'r1',
      coach_display_name: 'Coach Jason',
      kind: 'helped_someone',
      note: '',
      created_at: '2026-07-30T18:00:00.000Z',
    }];

    const { container } = await renderPanel({ audience: 'family', athleteName: 'Ada' });
    const text = container.textContent ?? '';

    // The track names a parent came for.
    expect(text).toContain('Showing up');
    expect(text).toContain('Getting stronger');
    expect(text).toContain('Helping people');

    // The same achievements, said to somebody who was not in the room.
    expect(text).toContain('Has stuck with it — thirteen sessions');
    expect(text).toContain('Moves out of the way and answers back');
    expect(text).toContain('Helped somebody in the gym who needed it.');

    // Not the athlete's second-person voice, and no gym jargon.
    expect(text).not.toContain('Slip, and answer');
    expect(text.toLowerCase()).not.toContain('rpe');
  });

  it('rings nothing and offers no controls on a parent\'s screen', async () => {
    completedSessions = 5;
    const { container } = await renderPanel({ audience: 'family' });

    // The bell belongs to the person who earned the thing.
    expect(played).toEqual([]);
    expect(container.querySelector('.tcard-earned')).toBeNull();

    // Read-only: no "Did it" self-marking, and no programme switch.
    expect(screen.queryByRole('button', { name: /did it/i })).toBeNull();
    expect(container.textContent).not.toContain('What you came here for');
  });
});

it('says a load failed rather than showing an empty record', async () => {
  milestonesFail = true;
  const { container } = render(<AthleteAchievements athleteId="ath_1" />);

  await waitFor(() => {
    expect(container.textContent).toContain('connection problem');
  });
  // The distinction matters: "nothing earned" and "could not load" look
  // identical and mean opposite things to somebody who has been training a year.
  expect(container.textContent).toContain('nothing already earned has gone anywhere');
});
