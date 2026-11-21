/**
 * @jest-environment jsdom
 */

/*
 * AS-9 step AS9-4 (app scrub FAM-10, FAM-11 on /schedule, FAM-23; Q7 = A).
 *
 * - A parent gets one child picker at the top of /schedule, the family
 *   pages' FamilyChildPicker, opening on the child chosen last on a family
 *   page when that child is theirs, else on the first.
 * - Register, the coaching request and the check-in act for that child; the
 *   selects that sat inside the coaching and check-in cards are gone for a
 *   parent (staff keep theirs).
 * - A parent's button reads "<name> is here" and the success line
 *   "<name> is marked here. Their coach can see it." An athlete's "I'm here"
 *   and its line are unchanged.
 * - No child id is shown to a parent.
 *
 * Pinned on the rendered DOM (jsdom). Not seen signed in or on staging.
 */

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const HOUR = 3600 * 1000;
const GYM_NOON = Date.parse('2026-10-14T16:00:00.000Z');
const KEY = 'ppbf.parent.chosenChild';

function classRow(id: string, title: string, startOffsetMs: number) {
  return {
    class_id: id,
    title,
    start_at: new Date(GYM_NOON + startOffsetMs).toISOString(),
    end_at: new Date(GYM_NOON + startOffsetMs + HOUR).toISOString(),
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 1,
  };
}

function registration(classId: string, athleteId: string) {
  return {
    registration_id: `reg-${classId}-${athleteId}`,
    class_id: classId,
    athlete_id: athleteId,
    requested_by_role: 'parent',
    parent_reviewed: true,
    status: 'registered',
    created_at: '2026-08-01T00:00:00.000Z',
  };
}

type Child = { athlete_id: string; full_name?: string };

const ROSA: Child = { athlete_id: 'ath-rosa', full_name: 'Rosa Delgado' };
const MARCUS: Child = { athlete_id: 'ath-marcus', full_name: 'Marcus Webb' };

function installFetchMock(options: {
  role?: 'parent' | 'athlete' | 'coach';
  children?: Child[];
  /** Roster answers in turn (a reload reads it again); the last repeats. */
  rosters?: Child[][];
  registrations?: ReturnType<typeof registration>[];
  classes?: ReturnType<typeof classRow>[];
}): jest.Mock {
  const role = options.role ?? 'parent';
  let rosterReads = 0;
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) {
      return json({ authenticated: true, role, athlete_id: role === 'athlete' ? 'ath-rosa' : null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      if (options.rosters) {
        rosterReads += 1;
        return json({ items: options.rosters[Math.min(rosterReads, options.rosters.length) - 1] });
      }
      return json({ items: options.children ?? [ROSA, MARCUS] });
    }
    if (url.endsWith('/api/pilot/athletes/get')) return json({ found: true, athlete: { full_name: 'Rosa Delgado' } });
    if (url.endsWith('/api/pilot/admin/staff')) return json({ members: [] });
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { athlete_id?: string };
      return json({ ok: true, class_id: 'class-today', athlete_id: body.athlete_id, method: role === 'athlete' ? 'self' : 'parent', recorded: true });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({
        ok: true,
        role,
        classes: options.classes ?? [classRow('class-today', 'Tonight', HOUR)],
        registrations: options.registrations ?? [
          registration('class-today', ROSA.athlete_id),
          registration('class-today', MARCUS.athlete_id),
        ],
        coaching_requests: [],
        attendance: [],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posts(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(GYM_NOON);
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("a parent's one child picker (FAM-10, FAM-11)", () => {
  test('sits at the top of the page, before the class schedule, and opens on the first child when none is remembered', async () => {
    installFetchMock({});
    await renderPage();

    const group = screen.getByRole('group', { name: 'Which child' });
    const schedule = screen.getByText('Class Schedule');
    expect(group.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Rosa Delgado' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Marcus Webb' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('opens on the child chosen last on a family page', async () => {
    window.sessionStorage.setItem(KEY, MARCUS.athlete_id);
    installFetchMock({});
    await renderPage();

    expect(screen.getByRole('button', { name: 'Marcus Webb' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Marcus Webb is here' })).toBeInTheDocument();
  });

  test('a remembered child who is not one of this parent\'s is ignored', async () => {
    window.sessionStorage.setItem(KEY, 'ath-someone-else');
    const fetchMock = installFetchMock({});
    await renderPage();

    expect(screen.getByRole('button', { name: 'Rosa Delgado' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rosa Delgado is here' }));
    });
    expect(posts(fetchMock).map((body) => body.athlete_id)).toEqual([ROSA.athlete_id]);
  });

  test('the selects inside the coaching and check-in cards are gone for a parent', async () => {
    installFetchMock({});
    await renderPage();

    expect(screen.queryByRole('combobox', { name: 'Athlete to mark' })).toBeNull();
    const coaching = screen.getByText('Request Individual Coaching').closest('article') as HTMLElement;
    expect(within(coaching).queryByRole('combobox')).toBeNull();
    expect(within(coaching).getByText('For Rosa Delgado')).toBeInTheDocument();
  });

  test('a pick is remembered, and Register, the coaching request and the check-in all act for it', async () => {
    const fetchMock = installFetchMock({
      classes: [classRow('class-today', 'Tonight', HOUR), classRow('class-next', 'Next week', 7 * 24 * HOUR)],
    });
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb' }));
    });
    expect(window.sessionStorage.getItem(KEY)).toBe(MARCUS.athlete_id);

    // The check-in first: Register also picks its row's class for the
    // check-in card, which would move that card to next week's class.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb is here' }));
    });
    const coaching = screen.getByText('Request Individual Coaching').closest('article') as HTMLElement;
    expect(within(coaching).getByText('For Marcus Webb')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(coaching).getByRole('button', { name: 'Submit Request' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register Marcus Webb' }));
    });

    const sent = posts(fetchMock);
    expect(sent.map((body) => [body.action, body.athlete_id])).toEqual([
      ['attendance_checkin', MARCUS.athlete_id],
      ['request_coaching', MARCUS.athlete_id],
      ['register_class', MARCUS.athlete_id],
    ]);
  });

  test('a one-child family has nothing to choose, and the page still acts for that child', async () => {
    const fetchMock = installFetchMock({ children: [ROSA], registrations: [registration('class-today', ROSA.athlete_id)] });
    await renderPage();

    expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rosa Delgado is here' }));
    });
    expect(posts(fetchMock)).toEqual([
      { action: 'attendance_checkin', class_id: 'class-today', athlete_id: ROSA.athlete_id, status: 'present' },
    ]);
  });
});

describe("a parent's check-in words (FAM-23; Q7 = A)", () => {
  test('"<name> is here", then "<name> is marked here. Their coach can see it."', async () => {
    installFetchMock({});
    await renderPage();

    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rosa Delgado is here' }));
    });
    expect(await screen.findByText('Rosa Delgado is marked here. Their coach can see it.')).toBeInTheDocument();
    expect(screen.queryByText('Checked in. Your coach can see you are here.')).toBeNull();
  });

  test('a child with no name on file reads "Your child", and no id is shown anywhere', async () => {
    const nameless: Child = { athlete_id: 'ath-nameless' };
    installFetchMock({
      children: [nameless],
      registrations: [registration('class-today', nameless.athlete_id)],
      classes: [classRow('class-today', 'Tonight', HOUR), classRow('class-next', 'Next week', 7 * 24 * HOUR)],
    });
    await renderPage();

    expect(screen.getByRole('button', { name: 'Your child is here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register your child' })).toBeInTheDocument();
    expect(screen.getByText('For your child')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('ath-nameless');
  });

  test("an athlete's \"I'm here\" and its line are unchanged", async () => {
    installFetchMock({ role: 'athlete', registrations: [registration('class-today', 'ath-rosa')] });
    await renderPage();

    expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "I'm here" }));
    });
    expect(await screen.findByText('Checked in. Your coach can see you are here.')).toBeInTheDocument();
  });

  test('a coach keeps the athlete select in both cards and gets no family picker', async () => {
    installFetchMock({ role: 'coach' });
    await renderPage();

    expect(screen.queryByRole('group', { name: 'Which child' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Athlete to mark' })).toBeInTheDocument();
    const coaching = screen.getByText('Request Individual Coaching').closest('article') as HTMLElement;
    expect(within(coaching).getByRole('combobox')).toBeInTheDocument();
  });
});

describe('review notes (AS9-4)', () => {
  test('a child no longer on the list after a reload is not kept, named or sent', async () => {
    const fetchMock = installFetchMock({
      rosters: [[ROSA, MARCUS], [ROSA]],
      classes: [classRow('class-today', 'Tonight', HOUR), classRow('class-next', 'Next week', 7 * 24 * HOUR)],
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb' }));
    });
    // Register reloads the page's reads quietly; the second roster read no
    // longer has Marcus.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register Marcus Webb' }));
    });
    await act(async () => {});

    expect(screen.queryByText(/Marcus/)).toBeNull();
    expect(document.body.textContent).not.toContain('ath-marcus');
    // Register moved the check-in card to next week's class, so the next
    // action is the coaching request, which now names and sends Rosa.
    const coaching = screen.getByText('Request Individual Coaching').closest('article') as HTMLElement;
    expect(within(coaching).getByText('For Rosa Delgado')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(coaching).getByRole('button', { name: 'Submit Request' }));
    });
    expect(posts(fetchMock).map((body) => [body.action, body.athlete_id])).toEqual([
      ['register_class', MARCUS.athlete_id],
      ['request_coaching', ROSA.athlete_id],
    ]);
  });

  test('a chosen child who is not on today\'s class is told so, with no button', async () => {
    installFetchMock({ registrations: [registration('class-today', ROSA.athlete_id)] });
    await renderPage();
    expect(screen.queryByText(/is not registered for this class/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Marcus Webb' }));
    });
    expect(screen.getByText('Marcus Webb is not registered for this class.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /is here$/ })).toBeNull();
  });
});
