/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import Chalkboard, { CHALK_MAX_LENGTH, chalkDateLabel, pickChalkLine } from './Chalkboard';
import type { AnnouncementItem } from './AnnouncementBanner';
import { GYM_SAYINGS, pickSaying } from './gymSayings';

// The vocabulary import in AnnouncementBanner's own test pulls the server
// module; nothing here needs it, but usePilotSession and the component both
// reach fetch, so that is what is stubbed.
function item(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann-1',
    message: 'Gloves on at five. Bring water.',
    author_name: 'Coach Jason',
    author_role: 'coach',
    created_at: '2026-08-01T12:00:00.000Z',
    placement: 'athlete_workspace',
    kind: 'motivation',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function stubFetch(options: {
  announcements?: AnnouncementItem[];
  role?: string | null;
  authProvider?: string | null;
  announcementsOk?: boolean;
  /** The live library (#1462). Undefined: the read is not answered (throws), as an unreachable library. */
  quotes?: Array<{ quote_text: string; speaker: string; shown: string[] }>;
  quotesOk?: boolean;
}) {
  const mock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes('/api/pilot/auth/session')) {
      return {
        ok: true,
        json: async () => ({
          authenticated: options.role !== null && options.role !== undefined,
          role: options.role ?? undefined,
          organization_id: 'org-ppbf',
          auth_provider: options.authProvider ?? undefined,
          account_id: 'acct-1',
          must_change_pin: false,
        }),
      } as Response;
    }
    if (href.includes('/api/pilot/announcements/get')) {
      return {
        ok: options.announcementsOk ?? true,
        json: async () => ({ ok: true, announcements: options.announcements ?? [] }),
      } as Response;
    }
    if (href.includes('/api/pilot/quotes') && options.quotes !== undefined) {
      return {
        ok: options.quotesOk ?? true,
        json: async () => ({ ok: true, quotes: options.quotes }),
      } as Response;
    }
    if (href.includes('/api/pilot/announcements/post')) {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function renderBoard(options: Parameters<typeof stubFetch>[0]) {
  const mock = stubFetch(options);
  await act(async () => {
    render(<Chalkboard placement="athlete_workspace" />);
  });
  return mock;
}

describe('picking the line on the board', () => {
  it('takes the newest live motivation for this surface', () => {
    const chosen = pickChalkLine(
      [
        item({ announcement_id: 'old', message: 'Old line', created_at: '2026-07-01T12:00:00.000Z' }),
        item({ announcement_id: 'new', message: 'New line', created_at: '2026-08-01T12:00:00.000Z' }),
      ],
      'athlete_workspace',
      Date.parse('2026-08-03T00:00:00.000Z'),
    );

    // A board holds one line. The previous one was rubbed out.
    expect(chosen?.message).toBe('New line');
  });

  it('ignores the operational notice, which is a different object', () => {
    const chosen = pickChalkLine([item({ kind: 'notice' })], 'athlete_workspace');
    expect(chosen).toBeNull();
  });

  it('ignores a retired, scheduled or expired item', () => {
    const now = Date.parse('2026-08-03T00:00:00.000Z');

    expect(pickChalkLine([item({ active: false })], 'athlete_workspace', now)).toBeNull();
    expect(
      pickChalkLine([item({ starts_at: '2026-09-01T00:00:00.000Z' })], 'athlete_workspace', now),
    ).toBeNull();
    expect(
      pickChalkLine([item({ ends_at: '2026-07-01T00:00:00.000Z' })], 'athlete_workspace', now),
    ).toBeNull();
  });

  it('ignores an item placed on somebody else’s surface, and accepts everywhere', () => {
    expect(pickChalkLine([item({ placement: 'coach_workspace' })], 'athlete_workspace')).toBeNull();
    expect(pickChalkLine([item({ placement: 'everywhere' })], 'athlete_workspace')).not.toBeNull();
  });

  it('ignores a blank line, which would render an empty board that looks written on', () => {
    expect(pickChalkLine([item({ message: '   ' })], 'athlete_workspace')).toBeNull();
  });

  it('dates a line the way a board does', () => {
    const now = new Date('2026-08-03T12:00:00.000Z');
    expect(chalkDateLabel('2026-08-03T09:00:00.000Z', now)).toBe('today');
    expect(chalkDateLabel('2026-08-02T09:00:00.000Z', now)).toBe('yesterday');
    expect(chalkDateLabel('nonsense', now)).toBe('');
  });
});

describe('the board on a dashboard', () => {
  it('is a blank board, not an error, when nothing is written', async () => {
    await renderBoard({ announcements: [], role: 'athlete', authProvider: 'ppbf_local' });

    expect(screen.getByText('Nothing on the board.')).toBeTruthy();
    // No apology, no empty-state illustration, no "no announcements found".
    expect(screen.queryByText(/no announcements/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Jason 2026-10-03 (Q1), replacing blank-on-failure: a board that could not
  // be read must not say "Nothing on the board." (a coach could rub out a real
  // line). It shows a gym saying and says it cannot be read -- still no alert,
  // no status code (#991 class, Lane 14 batch 8 P5).
  it('says it cannot be read when the read fails, under a gym saying, with no alert', async () => {
    await renderBoard({ announcementsOk: false, role: 'athlete', authProvider: 'ppbf_local' });

    expect(screen.queryByText('Nothing on the board.')).toBeNull();
    expect(screen.getByText("Can't read the board right now.")).toBeTruthy();
    const saying = pickSaying('anywhere', 'chalkboard-athlete_workspace');
    expect(saying).not.toBeNull();
    expect(GYM_SAYINGS).toContain(saying);
    expect(screen.getByText(saying!.line)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a gym saying and "Loading..." while the read is open, never "Nothing on the board."', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const base = stubFetch({ announcements: [], role: 'athlete', authProvider: 'ppbf_local' });
    global.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('/api/pilot/announcements/get')) await held;
      return base(url);
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<Chalkboard placement="athlete_workspace" />);
    });

    expect(screen.getByText('Loading...')).toBeTruthy();
    expect(screen.getByText(pickSaying('anywhere', 'chalkboard-athlete_workspace')!.line)).toBeTruthy();
    expect(screen.queryByText('Nothing on the board.')).toBeNull();

    await act(async () => { release(); await held; });
    expect(screen.getByText('Nothing on the board.')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it('warns a writer while the read is still open, too', async () => {
    const base = stubFetch({ announcements: [], role: 'coach', authProvider: 'microsoft' });
    global.fetch = jest.fn(async (url: unknown) => {
      if (String(url).includes('/api/pilot/announcements/get')) return new Promise<Response>(() => {});
      return base(url);
    }) as unknown as typeof fetch;

    await act(async () => {
      render(<Chalkboard placement="athlete_workspace" />);
    });

    expect(screen.getByText('Loading...')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Write on the board' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Rub it out and write' })).toBeTruthy();
  });

  it('warns a writer that an unreadable board may hold a line', async () => {
    await renderBoard({ announcementsOk: false, role: 'coach', authProvider: 'microsoft' });

    expect(screen.getByRole('button', { name: 'Rub it out and write' })).toBeTruthy();
  });

  it('writes the line and who wrote it', async () => {
    await renderBoard({ announcements: [item()], role: 'athlete', authProvider: 'ppbf_local' });

    expect(screen.getByText('Gloves on at five. Bring water.')).toBeTruthy();
    expect(screen.getByText(/Coach Jason/)).toBeTruthy();
  });
});

describe('who may write on it', () => {
  it('offers nothing to an athlete', async () => {
    await renderBoard({ announcements: [], role: 'athlete', authProvider: 'ppbf_local' });

    expect(screen.queryByRole('button', { name: /write on the board/i })).toBeNull();
    expect(screen.queryByText(/Microsoft sign-in/i)).toBeNull();
  });

  it('offers nothing to a parent', async () => {
    await renderBoard({ announcements: [], role: 'parent', authProvider: 'ppbf_local' });
    expect(screen.queryByRole('button', { name: /write on the board/i })).toBeNull();
  });

  it('offers the chalk to a coach on the Microsoft session the server requires', async () => {
    await renderBoard({ announcements: [], role: 'coach', authProvider: 'microsoft' });
    expect(screen.getByRole('button', { name: /write on the board/i })).toBeTruthy();
  });

  it('offers the chalk to an organization admin', async () => {
    await renderBoard({ announcements: [], role: 'organization_admin', authProvider: 'microsoft' });
    expect(screen.getByRole('button', { name: /write on the board/i })).toBeTruthy();
  });

  it('does not hand a coach on a PIN session a button that would 403, and says why', async () => {
    // POST /api/pilot/announcements/post requires a Microsoft-authenticated
    // principal. Offering the control anyway would be a guaranteed failure
    // dressed as a feature.
    await renderBoard({ announcements: [], role: 'coach', authProvider: 'ppbf_local' });

    expect(screen.queryByRole('button', { name: /write on the board/i })).toBeNull();
    expect(screen.getByText(/Microsoft sign-in/i)).toBeTruthy();
  });

  it('offers nothing to a signed-out visitor', async () => {
    await renderBoard({ announcements: [], role: null, authProvider: null });
    expect(screen.queryByRole('button', { name: /write on the board/i })).toBeNull();
  });

  it('says "rub it out" rather than "edit" when there is already a line', async () => {
    await renderBoard({ announcements: [item()], role: 'coach', authProvider: 'microsoft' });
    expect(screen.getByRole('button', { name: /rub it out and write/i })).toBeTruthy();
  });
});

describe('it is the existing announcements system, not a second one', () => {
  it('reads the same endpoint every other surface reads, asking for the motivation kind', async () => {
    const mock = await renderBoard({ announcements: [], role: 'athlete', authProvider: 'ppbf_local' });

    const calls = mock.mock.calls as unknown as Array<[string, RequestInit]>;
    const call = calls.find((args) => String(args[0]).includes('/api/pilot/announcements/get'));
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({ placement: 'athlete_workspace', kind: 'motivation' });
  });

  it('keeps one line one line', () => {
    // The database column is free text. The cap is what keeps a chalkboard from
    // becoming a memo, and it is stated in one place.
    expect(CHALK_MAX_LENGTH).toBeLessThanOrEqual(200);
  });
});

describe('the line under a board with nothing real on it comes from the quote library (#1462)', () => {
  const ALI = { quote_text: 'FLOAT LIKE A BUTTERFLY, STING LIKE A BEE.', speaker: 'Muhammad Ali', shown: ['anywhere'] };

  it('reads the live library, and shows an attributed boxing quote with who said it', async () => {
    const mock = await renderBoard({ announcementsOk: false, role: 'parent', authProvider: 'ppbf_local', quotes: [ALI] });

    expect(mock.mock.calls.some(([url]) => String(url).includes('/api/pilot/quotes?live=1'))).toBe(true);
    expect(screen.getByText(ALI.quote_text)).toBeTruthy();
    expect(screen.getByText('— Muhammad Ali')).toBeTruthy();
    expect(screen.getByText("Can't read the board right now.")).toBeTruthy();
  });

  it('picks from the library on the same fixed seed, so the line does not reshuffle', async () => {
    const library = [
      ALI,
      { quote_text: 'AMPLECTERE MISERIAM', speaker: 'the wall', shown: ['anywhere'] },
      { quote_text: 'HANDS UP. HEAD CLEAR.', speaker: 'the wall', shown: ['after-hard-session'] },
    ];
    await renderBoard({ announcementsOk: false, role: 'athlete', authProvider: 'ppbf_local', quotes: library });
    const expected = pickSaying('anywhere', 'chalkboard-athlete_workspace', [
      { line: ALI.quote_text, said_by: ALI.speaker, shown: ['anywhere'] },
      { line: 'AMPLECTERE MISERIAM', said_by: 'the wall', shown: ['anywhere'] },
      { line: 'HANDS UP. HEAD CLEAR.', said_by: 'the wall', shown: ['after-hard-session'] },
    ]);
    expect(screen.getByText(expected!.line)).toBeTruthy();
  });

  it.each([
    ['empty', { quotes: [] as Array<{ quote_text: string; speaker: string; shown: string[] }> }],
    ['refused', { quotes: [ALI], quotesOk: false }],
    ['unreachable', {}],
  ])('falls back to the gym\'s own sayings when the library is %s', async (_label, library) => {
    await renderBoard({ announcementsOk: false, role: 'athlete', authProvider: 'ppbf_local', ...library });

    const local = pickSaying('anywhere', 'chalkboard-athlete_workspace');
    expect(screen.getByText(local!.line)).toBeTruthy();
    expect(screen.queryByText(ALI.quote_text)).toBeNull();
  });

  it('a written line still wins: the library never covers what somebody wrote', async () => {
    await renderBoard({ announcements: [item()], role: 'athlete', authProvider: 'ppbf_local', quotes: [ALI] });

    expect(screen.getByText('Gloves on at five. Bring water.')).toBeTruthy();
    expect(screen.queryByText(ALI.quote_text)).toBeNull();
  });
});
