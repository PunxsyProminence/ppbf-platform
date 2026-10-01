/**
 * @jest-environment jsdom
 */

/*
 * The athlete's own face of a training hold had two states and needed three.
 *
 * A failed read of /api/pilot/training-holds rendered nothing -- and nothing
 * is exactly what an athlete with no hold sees. The component's own comment
 * was right that an unreachable API must never say "you are held"; what it
 * missed is that it must not look like "you are not held" either. A held
 * child whose check could not be read saw an ordinary training day.
 *
 * Owner decision, 2026-10-01. Asked what an athlete (assume a minor) sees
 * when the hold check could not be read, Jason answered: "Talk to your Coach
 * about todays training". That is the whole line: no account of what failed,
 * no stamp, no red.
 */

import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import TrainingHoldBanner from './TrainingHoldBanner';

const HOLD = {
  scope: 'contact_only',
  athlete_explanation: 'No contact this week while your wrist settles.',
  lift_condition_text: 'A pain-free grip and a coach check-in.',
  placed_at: '2026-09-28T15:00:00.000Z',
  expires_at: null,
  placed_by_name: 'Coach Rivera',
};

function mockHoldRead(responder: () => Response | Promise<Response>) {
  const fetchMock = jest.fn(async () => responder());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The whole of what the banner put on screen. */
function bannerText(container: HTMLElement): string {
  return container.textContent ?? '';
}

/** Let an already-answered read land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('a hold check nobody could read never looks like "no hold"', () => {
  test('a read the server refused shows the owner’s line, exactly, and nothing else', async () => {
    mockHoldRead(() => ({ ok: false, status: 503, json: async () => ({}) }) as Response);

    const { container } = render(<TrainingHoldBanner />);

    await waitFor(() => expect(bannerText(container)).not.toBe(''));
    expect(bannerText(container)).toBe('Talk to your coach about today’s training.');
  });

  test('a read that throws is treated the same as one the server refused', async () => {
    mockHoldRead(() => Promise.reject(new Error('Network request failed')));

    const { container } = render(<TrainingHoldBanner />);

    await waitFor(() => expect(bannerText(container)).not.toBe(''));
    expect(bannerText(container)).toBe('Talk to your coach about today’s training.');
  });

  test('a body that will not parse is unread too', async () => {
    mockHoldRead(
      () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response,
    );

    const { container } = render(<TrainingHoldBanner />);

    await waitFor(() => expect(bannerText(container)).not.toBe(''));
    expect(bannerText(container)).toBe('Talk to your coach about today’s training.');
  });

  test('a 200 that carries no `hold` key answered some other question, and is unread', async () => {
    // The route always sends `hold`, null or the hold itself. A proxy page, an
    // error body or an empty object served with 200 is not "no hold".
    for (const body of [{}, { error: 'upstream' }, { ok: true, holds: [] }, { hold: false }, { hold: '' }, { hold: [] }]) {
      mockHoldRead(() => ({ ok: true, json: async () => body }) as Response);

      const { container, unmount } = render(<TrainingHoldBanner />);

      await waitFor(() => expect(bannerText(container)).not.toBe(''));
      expect(bannerText(container)).toBe('Talk to your coach about today’s training.');
      unmount();
    }
  });

  test('a failed read never says the athlete is held: no stamp, no alert, no red', async () => {
    mockHoldRead(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);

    const { container } = render(<TrainingHoldBanner />);

    await screen.findByText('Talk to your coach about today’s training.');
    expect(container.querySelector('[data-refusal-stamp]')).toBeNull();
    expect(container.querySelector('.stamp')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.innerHTML).not.toMatch(/locked|critical|danger/);
    expect(bannerText(container)).not.toMatch(/paused|hold/i);
  });
});

describe('the states a read did establish are unchanged', () => {
  test('no hold: the banner is silent, and does not show the unread line', async () => {
    const fetchMock = mockHoldRead(() => ({ ok: true, json: async () => ({ ok: true, hold: null }) }) as Response);

    const { container } = render(<TrainingHoldBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(container.firstChild).toBeNull();
  });

  test('an active hold: the stamp and the athlete’s own explanation, and not the unread line', async () => {
    mockHoldRead(() => ({ ok: true, json: async () => ({ ok: true, hold: HOLD }) }) as Response);

    const { container } = render(<TrainingHoldBanner />);

    await screen.findByText('Contact work is paused for you right now');
    expect(container.querySelector('[data-refusal-stamp="training_hold"]')).toBeTruthy();
    expect(bannerText(container)).toContain(HOLD.athlete_explanation);
    expect(bannerText(container)).not.toContain('about today’s training');
  });

  test('while the read is still out, nothing is claimed either way', async () => {
    mockHoldRead(() => new Promise<Response>(() => {}));

    const { container } = render(<TrainingHoldBanner />);

    await settle();
    expect(container.firstChild).toBeNull();
  });

  test('an aborted read is not a failed read: a cancelled first effect does not leave the unread line up', async () => {
    // StrictMode mounts, cleans up and mounts again: the first read is aborted
    // and its rejection lands while the component is still on screen with its
    // second read still out. Without the abort check that rejection reads as
    // "could not check" before anybody has.
    const fetchMock = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        // Never answers; only an abort ends it. So the second, live read is
        // still out when the first one's abort lands.
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      <StrictMode>
        <TrainingHoldBanner />
      </StrictMode>,
    );
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bannerText(container)).toBe('');
  });
});
