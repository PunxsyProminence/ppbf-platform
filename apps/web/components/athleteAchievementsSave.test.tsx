/**
 * @jest-environment jsdom
 */

// Save truth on the achievements panel (WO-N5-02): choosing a programme and marking a milestone
// say "Saving..." while the server has not answered, and "That did not save. Try it again." when it
// did not keep the press. Success is the screen itself changing after the server answers; no extra
// line appears for it.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { resetAchievementCeremonyMemory } from './achievementCeremony';
import AthleteAchievements from './AthleteAchievements';

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: false, ready: false, status: 'off' as const, play: () => false, setEnabled: async () => false }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

type Write = 'ok' | 'refused' | 'offline' | 'pending';
let write: Write = 'ok';
let release: () => void = () => {};
let program = 'fitness';

beforeEach(() => {
  window.localStorage.clear();
  resetAchievementCeremonyMemory();
  write = 'ok';
  program = 'fitness';
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/achievements/milestones') && method !== 'GET') {
      if (write === 'offline') throw new Error('offline');
      if (write === 'refused') return jsonResponse({ error: 'Forbidden' }, false);
      if (write === 'pending') {
        return new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ ok: true }));
        });
      }
      const body = JSON.parse(String(init?.body)) as { program?: string };
      if (body.program) program = body.program;
      return jsonResponse({ ok: true });
    }
    if (url.includes('/achievements/milestones')) {
      return jsonResponse({ ok: true, program, completed_sessions: 0, items: [] });
    }
    if (url.includes('/achievements/recognition') || url.includes('/achievements/mentorships')) {
      return jsonResponse({ ok: true, items: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderPanel() {
  render(<AthleteAchievements athleteId="ath_1" />);
  await waitFor(() => {
    expect(screen.getByText(/nothing here ever comes off/i)).toBeTruthy();
  });
}

function programButton(name: RegExp) {
  return screen.getByRole('button', { name });
}

describe('choosing what you came here for', () => {
  test('says "Saving..." while the server has not answered, and nothing once it has kept it', async () => {
    write = 'pending';
    await renderPanel();
    await act(async () => {
      fireEvent.click(programButton(/youth programme/i));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saving...');
    await act(async () => {
      release();
    });
    await waitFor(() => expect(programButton(/youth programme/i)).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByText('Saving...')).toBeNull();
    expect(screen.queryByText('That did not save. Try it again.')).toBeNull();
  });

  test.each(['refused', 'offline'] as const)('a %s save says it did not save, and the old choice stays', async (outcome) => {
    write = outcome;
    await renderPanel();
    await act(async () => {
      fireEvent.click(programButton(/youth programme/i));
    });
    expect(screen.getByRole('status')).toHaveTextContent('That did not save. Try it again.');
    expect(programButton(/fitness/i)).toHaveAttribute('aria-pressed', 'true');
    expect(programButton(/youth programme/i)).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('marking a milestone yourself', () => {
  test.each(['refused', 'offline'] as const)('a %s mark says it did not save', async (outcome) => {
    write = outcome;
    await renderPanel();
    const didIt = screen.getAllByRole('button', { name: 'Did it' })[0];
    await act(async () => {
      fireEvent.click(didIt);
    });
    expect(screen.getByRole('status')).toHaveTextContent('That did not save. Try it again.');
  });

  test('a mark in flight says "Saving...", and a kept one leaves no line', async () => {
    write = 'pending';
    await renderPanel();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Did it' })[0]);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saving...');
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
    expect(screen.queryByText('That did not save. Try it again.')).toBeNull();
  });
});
