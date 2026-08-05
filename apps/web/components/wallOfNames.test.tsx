/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import WallOfNames from './WallOfNames';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function board(overrides: Record<string, unknown> = {}) {
  return {
    generated_at: '2026-08-03T15:00:00.000Z',
    name_mode: 'initials',
    total_people: 2,
    total_training: 1,
    first_year: 2019,
    last_year: 2024,
    truncated: false,
    years: [
      {
        year: 2019,
        entries: [{ key: 'aaaaaaaaaaaa', name: 'A.D.', visibility: 'initials', standing: 'came_through' }],
      },
      {
        year: 2024,
        entries: [{ key: 'bbbbbbbbbbbb', name: 'B.K.', visibility: 'initials', standing: 'training' }],
      },
    ],
    ...overrides,
  };
}

async function renderWall(response: { ok?: boolean; body?: unknown }) {
  const mock = jest.fn(async () => ({
    ok: response.ok ?? true,
    json: async () => response.body,
  } as Response));
  global.fetch = mock as unknown as typeof fetch;

  let container!: HTMLElement;
  await act(async () => {
    container = render(<WallOfNames />).container;
  });
  return { container, mock };
}

describe('the wall of names on screen', () => {
  it('draws every year, oldest first, with everybody in it', async () => {
    const { container } = await renderWall({ body: { ok: true, board: board() } });

    expect(screen.getByText('2019')).toBeTruthy();
    expect(screen.getByText('2024')).toBeTruthy();
    expect(screen.getByText('A.D.')).toBeTruthy();
    expect(screen.getByText('B.K.')).toBeTruthy();

    const years = [...container.querySelectorAll('.wall-names-year-plate')].map((el) => el.textContent);
    expect(years).toEqual(['2019', '2024']);
  });

  it('says in words why everybody is initials, so it does not read as broken', async () => {
    await renderWall({ body: { ok: true, board: board() } });
    expect(screen.getByText(/needs a signed release naming that screen/i)).toBeTruthy();
  });

  it('marks who is still training in words as well as in weight', async () => {
    // Law 3: never colour alone. A photocopy, a monochrome screen, or a reader
    // who cannot separate the two tints still gets the fact.
    await renderWall({ body: { ok: true, board: board() } });

    expect(screen.getByText('Training now')).toBeTruthy();
    expect(screen.getByText('Came through')).toBeTruthy();
  });

  it('carries no per-person number anywhere on the page', async () => {
    const { container } = await renderWall({ body: { ok: true, board: board() } });

    // Nothing beside a person's name is a number: no session count, no years
    // served, no milestone tally. A shared board that puts 233 beside one child
    // and 3 beside another ranks children against each other.
    const people = [...container.querySelectorAll('.wall-names-item')].map((el) => el.textContent ?? '');
    expect(people).toHaveLength(2);
    for (const entry of people) {
      expect({ entry, hasDigit: /\d/.test(entry) }).toEqual({ entry, hasDigit: false });
    }

    // The only numbers on the surface are the year plates and the whole-wall
    // aggregates, neither of which is a fact about one person.
    expect(screen.getByText('People on this wall')).toBeTruthy();
  });

  it('is a finished object on the day nobody is on it', async () => {
    await renderWall({
      body: {
        ok: true,
        board: board({ total_people: 0, total_training: 0, first_year: null, last_year: null, years: [] }),
      },
    });

    expect(screen.getByText('Nobody is on the wall yet')).toBeTruthy();
    expect(screen.getByText(/it never comes down/i)).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('explains the operator switch rather than showing a blank board', async () => {
    await renderWall({
      body: { ok: true, board: board({ name_mode: 'off', years: [] }) },
    });

    expect(screen.getByText(/Names are switched off/i)).toBeTruthy();
    // The lineage is still reported. The records behind it are unchanged.
    expect(screen.getByText('2019–2024')).toBeTruthy();
  });

  it('does not pretend the wall is empty when the read failed', async () => {
    await renderWall({ ok: false, body: {} });

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('The wall did not load')).toBeTruthy();
    expect(screen.queryByText('Nobody is on the wall yet')).toBeNull();
  });

  it('files an undated record under its own heading', async () => {
    await renderWall({
      body: {
        ok: true,
        board: board({
          years: [
            {
              year: null,
              entries: [{ key: 'cccccccccccc', name: 'C.D.', visibility: 'initials', standing: 'came_through' }],
            },
          ],
        }),
      },
    });

    expect(screen.getByText('Year not recorded')).toBeTruthy();
  });

  it('says what the year actually means, because the platform does not know when anybody walked in', async () => {
    await renderWall({ body: { ok: true, board: board() } });
    expect(screen.getByText(/plenty of people trained here long before any of this existed/i)).toBeTruthy();
  });
});
