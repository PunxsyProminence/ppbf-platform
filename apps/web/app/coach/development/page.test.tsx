/**
 * @jest-environment jsdom
 */

/*
 * The coach UI over a coach's own development record.
 *
 * Three properties are worth a test here and the rest is the route's job:
 *
 *   1. the page never renders a progress figure. This is not a hypothetical
 *      risk: the Coach Goals tab shipped with hardcoded goals carrying
 *      progress bars that read the same percentages for every coach who
 *      logged in, and the way to keep them out is to assert their absence
 *      rather than to remember.
 *   2. nothing here is presented as a credential. A coach may well log
 *      "SafeSport refresher"; what must never appear next to it is anything
 *      that reads as verification, because the verified record lives
 *      elsewhere and is confirmed by an administrator.
 *   3. a failed read is never rendered as "you have nothing recorded". A
 *      coach who reads that writes down a goal they already had.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachDevelopmentPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function goalRow(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal-1',
    title: 'Corner work under pressure',
    development_focus: 'Keep the anxious kids in the room during hard rounds.',
    target_on: '2026-12-01',
    status: 'draft',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: 'act-1',
    goal_id: null,
    title: 'Youth coaching clinic',
    provider: 'USA Boxing',
    occurred_on: '2026-03-12',
    duration_minutes: 180,
    notes: '',
    created_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

interface Stubs {
  readOk?: boolean;
  goals?: Array<Record<string, unknown>>;
  activities?: Array<Record<string, unknown>>;
  writeOk?: boolean;
  writeError?: string;
  /** Delays the write response, so a second click lands while the first is in
      flight. Without this a double-submit test proves nothing: two clicks
      inside one act() flush nothing in between. */
  holdWrite?: () => Promise<void>;
}

const writes: Array<{ method: string; body: Record<string, unknown> }> = [];

function installFetch(stubs: Stubs = {}): jest.Mock {
  writes.length = 0;
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/coach/development')) {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return {
          ok: stubs.readOk ?? true,
          status: stubs.readOk === false ? 503 : 200,
          json: async () => ({
            ok: true,
            goals: stubs.goals ?? [],
            activities: stubs.activities ?? [],
          }),
        } as Response;
      }
      writes.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (stubs.holdWrite) {
        await stubs.holdWrite();
      }
      return {
        ok: stubs.writeOk ?? true,
        status: stubs.writeOk === false ? 400 : 200,
        json: async () => (stubs.writeOk === false
          ? { error: stubs.writeError ?? 'refused' }
          : { ok: true, goal: goalRow() }),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(stubs: Stubs = {}) {
  const fetchMock = installFetch(stubs);
  await act(async () => {
    render(<CoachDevelopmentPage />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * The text of the sections that render STORED ROWS, excluding the page's own
 * prose.
 *
 * Scoped deliberately, and the reason is worth recording: the first version of
 * these assertions read document.body and failed on the page's own
 * disclaimers -- "It does not score it, rank it, grade it" and "A total built
 * from self-entered rows would read like proof of hours". Those sentences are
 * the point of the page and must not be deleted to make a test pass. What has
 * to be free of a score, a percentage or a total is the part that renders a
 * coach's actual record, which is what this returns.
 */
function recordText(): string {
  return ['Your goals', 'What you have done']
    .map((heading) => screen.getByText(heading).closest('section')?.textContent ?? '')
    .join(' ');
}

/**
 * One goal's own card.
 *
 * Scoped, because a goal title appears TWICE on this page by design: as the
 * card's heading, and as an option on the activity form's "Toward a goal"
 * picker. An unscoped getByText is ambiguous and, worse, could silently match
 * the option instead of the card a later assertion is about.
 */
function goalCard(title: string): HTMLElement {
  const section = screen.getByText('Your goals').closest('section') as HTMLElement;
  return within(section).getByRole('heading', { name: title }).closest('article') as HTMLElement;
}

describe('the page invents no development science', () => {
  test('no score, percentage, progress bar or level anywhere on the page', async () => {
    await renderPage({
      goals: [goalRow(), goalRow({ goal_id: 'goal-2', title: 'Read the room', status: 'active' })],
      activities: [
        activityRow({ duration_minutes: 60 }),
        activityRow({ activity_id: 'act-2', title: 'Ringside seminar', duration_minutes: 120 }),
      ],
    });

    const body = recordText();
    expect(body).not.toMatch(/\d+\s*%/);
    expect(body).not.toMatch(/progress/i);
    expect(body).not.toMatch(/\blevel\b/i);
    expect(body).not.toMatch(/\bscore\b/i);
    expect(body).not.toMatch(/\brank(ed|ing)?\b/i);
    // No bar element either -- a visual progress indicator carrying no word
    // would pass every assertion above.
    expect(document.querySelectorAll('progress')).toHaveLength(0);
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0);

    // Guards the guard: both goals and both activities really did render.
    expect(goalCard('Read the room')).toBeTruthy();
    expect(screen.getByText('Ringside seminar')).toBeTruthy();
  });

  test('nothing sums the durations into an hours total', async () => {
    await renderPage({
      activities: [
        activityRow({ activity_id: 'a', title: 'A', duration_minutes: 60 }),
        activityRow({ activity_id: 'b', title: 'B', duration_minutes: 120 }),
        activityRow({ activity_id: 'c', title: 'C', duration_minutes: 30 }),
      ],
    });

    const body = recordText();
    // Each activity shows its own duration.
    expect(body).toContain('1h 00m');
    expect(body).toContain('2h 00m');
    expect(body).toContain('30m');
    // And the total -- 210 minutes, 3h 30m -- appears nowhere. A summed
    // figure built from self-entered rows would read as proof of hours.
    expect(body).not.toContain('3h 30m');
    expect(body).not.toContain('210');
    expect(body).not.toMatch(/total/i);
  });

  test('a goal whose target date passed years ago is still shown as the coach left it', async () => {
    await renderPage({
      goals: [goalRow({ target_on: '2020-01-01', status: 'active' })],
    });

    // 'Working on it' is what 'active' reads as. Scoped to the goal's own
    // card: the label also appears on the new-goal form's state picker and on
    // the other goals' change buttons, so an unscoped lookup is ambiguous and
    // would pass for the wrong element.
    const card = goalCard('Corner work under pressure');
    expect(card.querySelector('.badge')?.textContent).toBe('Working on it');
    // And nothing anywhere decides that a goal with an elapsed date was
    // finished, or abandoned, or is behind.
    expect(document.body.textContent).not.toMatch(/overdue|expired|missed|late|behind/i);
  });
});

describe('nothing on this page claims a clearance', () => {
  test('a logged SafeSport refresher shows as what it is, with no verification language', async () => {
    await renderPage({
      activities: [activityRow({ title: 'SafeSport refresher', provider: 'US Center for SafeSport' })],
    });

    expect(screen.getByText('SafeSport refresher')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/verified|approved|cleared for|current until|expires/i);
    // And the page says plainly where the real record is, rather than leaving
    // a coach to work out that this list is not it.
    expect(body).toMatch(/self-entered/i);
    expect(screen.getByRole('link', { name: 'Your credentials' }).getAttribute('href'))
      .toBe('/coach/credentials');
  });

  test('the topic prompts are offered as prompts, not as a syllabus', async () => {
    await renderPage();

    // They fill the box in. They are not a closed vocabulary, and the page
    // says so -- promoting them to one would make this platform the author of
    // a coaching curriculum it does not possess.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adaptive Coaching' }));
    });
    expect((screen.getByLabelText('What it was') as HTMLInputElement).value).toBe('Adaptive Coaching');
    expect(document.body.textContent).toMatch(/prompts, not a syllabus/i);
  });
});

describe('a failed read is never rendered as an empty record', () => {
  test('a failed read says nobody could look, not that there is nothing', async () => {
    await renderPage({ readOk: false });

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/could not be read/i);
    expect(body).toMatch(/does not mean you have nothing recorded/i);
    // The two "you have none" lines belong to a LOADED empty record and must
    // not appear for a failed one.
    expect(body).not.toMatch(/have not written down a development goal/i);
    expect(body).not.toMatch(/have not recorded any development work/i);
  });

  test('a genuinely empty record says so, and is not the same message', async () => {
    await renderPage({ goals: [], activities: [] });

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/have not written down a development goal/i);
    expect(body).toMatch(/have not recorded any development work/i);
    expect(body).not.toMatch(/could not be read/i);
  });
});

describe('writing', () => {
  test('a new goal posts the coach\'s own words, with no account or organization id', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'Corner work under pressure' },
      });
      fireEvent.change(screen.getByLabelText('What you are trying to get better at'), {
        target: { value: 'Keep the anxious kids in the room.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      kind: 'goal',
      title: 'Corner work under pressure',
      development_focus: 'Keep the anxious kids in the room.',
    });
    // The session decides both. A page that sent either would be a page that
    // could be made to write under somebody else's name.
    expect(writes[0].body).not.toHaveProperty('account_id');
    expect(writes[0].body).not.toHaveProperty('coach_account_id');
    expect(writes[0].body).not.toHaveProperty('organization_id');
  });

  test('an omitted target date is sent as null, not as an empty string', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A' } });
      fireEvent.change(screen.getByLabelText('What you are trying to get better at'), {
        target: { value: 'B' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    });

    expect(writes[0].body.target_on).toBeNull();
  });

  test('an omitted duration is sent as null, so no zero nobody typed is stored', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('What it was'), { target: { value: 'Clinic' } });
      fireEvent.change(screen.getByLabelText('When it happened'), {
        target: { value: '2026-03-12' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record it' }));
    });

    expect(writes[0].body).toMatchObject({ kind: 'activity', title: 'Clinic' });
    expect(writes[0].body.duration_minutes).toBeNull();
    expect(writes[0].body.goal_id).toBeNull();
  });

  test('a refused write shows the server\'s own reason, not a generic failure', async () => {
    await renderPage({ writeOk: false, writeError: 'A development goal needs a stated focus.' });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    });

    expect(screen.getByText('A development goal needs a stated focus.')).toBeTruthy();
  });

  test('a second click while the first save is in flight does not write twice', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await renderPage({ holdWrite: () => held });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A' } });
      fireEvent.change(screen.getByLabelText('What you are trying to get better at'), {
        target: { value: 'B' },
      });
    });

    const button = screen.getByRole('button', { name: 'Save goal' });
    // Outside act(), so the click lands while the first write is genuinely
    // held open. Two clicks inside one act() flush nothing in between and
    // would pass against a component with no guard at all.
    fireEvent.click(button);
    fireEvent.click(button);

    await act(async () => {
      release?.();
      await held;
    });

    expect(writes).toHaveLength(1);
  });

  test('a status change patches only the status of the goal it names', async () => {
    await renderPage({ goals: [goalRow({ status: 'draft' })] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Working on it' }));
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].body).toEqual({ goal_id: 'goal-1', status: 'active' });
  });
});

describe('what a row shows when a field was never recorded', () => {
  test('an unrecorded provider, duration and goal leave no empty fields behind', async () => {
    await renderPage({
      activities: [activityRow({
        title: 'Watched the Tuesday class',
        provider: '',
        duration_minutes: null,
        goal_id: null,
        notes: '',
      })],
    });

    const body = document.body.textContent ?? '';
    expect(body).toContain('Watched the Tuesday class');
    // The whole detail line, asserted as a whole: a partial match would pass
    // while a stray separator or the word null sat next to it.
    expect(screen.getByText('2026-03-12')).toBeTruthy();
    expect(body).not.toContain('null');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('· ·');
    expect(body).not.toMatch(/Toward:\s*$/m);
  });

  test('a recorded provider, duration and goal all appear on one line', async () => {
    await renderPage({
      goals: [goalRow()],
      activities: [activityRow({ goal_id: 'goal-1' })],
    });

    expect(screen.getByText(
      '2026-03-12 · USA Boxing · 3h 00m · Toward: Corner work under pressure',
    )).toBeTruthy();
  });
});

/*
 * THE PAGE MUST ADMIT WHOEVER THE ROUTE ADMITS.
 *
 * The route gates on STAFF_CREDENTIAL_ROLES; the page admitted only coach and
 * admin, so staff and volunteers could call the API that serves this feature
 * and were redirected away from its only UI. Found by a review bot on the
 * pull request. This record is self-scoped -- the route takes no account id --
 * so there is no safety reason to shut anyone with staff standing out of
 * their own development record.
 */
describe('the role gate matches the route it fronts', () => {
  test('staff and volunteers are admitted, alongside coaches and admins', () => {
    const source = readFileSync(
      resolve(__dirname, 'page.tsx'),
      'utf8',
    );
    const allowed = /allowedRoles=\{\[([^\]]+)\]\}/.exec(source)?.[1] ?? '';
    for (const role of ['coach', 'admin', 'staff', 'volunteer']) {
      expect([role, allowed.includes(`'${role}'`)]).toEqual([role, true]);
    }
  });

  test('the building map offers the room to the same roles', () => {
    const map = readFileSync(
      resolve(__dirname, '../../../components/buildingMap.ts'),
      'utf8',
    );
    const entry = /\{ href: '\/coach\/development',[\s\S]*?\},/.exec(map)?.[0] ?? '';
    expect(entry).not.toBe('');
    for (const role of ['coach', 'admin', 'staff', 'volunteer']) {
      expect([role, entry.includes(`'${role}'`)]).toEqual([role, true]);
    }
  });
});

/*
 * CORRECTING A GOAL'S OWN WORDS.
 *
 * The PATCH route has always accepted title, development_focus and target_on;
 * the page offered only status buttons. A coach who typed a title wrong could
 * leave it or file a second goal beside it, and the duplicate is worse than
 * the typo -- it turns the list into a record of mistakes rather than of
 * intentions. Found by a review bot on the pull request stack.
 *
 * This is deliberately NOT the amendment this lane refuses elsewhere. A block
 * review is dated testimony and a changed mind there is a new row; a goal is
 * a live intention that already moves through four statuses by design, and it
 * is the coach's own note about themselves, carrying nothing about a child.
 */
describe('a coach can correct a goal instead of duplicating it', () => {
  const goal = () => goalRow({
    goal_id: 'goal-1',
    title: 'Corner work under presure',
    development_focus: 'Keep the anxious kids in the room.',
    target_on: '2026-12-01',
  });

  test('the correction form opens holding what is stored, not an empty draft', async () => {
    await renderPage({ goals: [goal()] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Correct wording' }));
    });

    /* Pre-filled on purpose: a coach fixing one letter of a title must not
       have to retype the sentence, and an empty form would invite them to
       save a blank over a goal they meant to keep. */
    expect((screen.getByLabelText('Corrected title') as HTMLInputElement).value)
      .toBe('Corner work under presure');
    expect((screen.getByLabelText('Corrected focus') as HTMLTextAreaElement).value)
      .toBe('Keep the anxious kids in the room.');
    expect((screen.getByLabelText('Corrected target date') as HTMLInputElement).value).toBe('2026-12-01');
  });

  test('saving sends the corrected words, and the goal id, on a PATCH', async () => {
    await renderPage({ goals: [goal()] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Correct wording' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Corrected title'), {
        target: { value: 'Corner work under pressure' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    });

    const patch = writes.find((entry) => entry.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      goal_id: 'goal-1',
      title: 'Corner work under pressure',
      development_focus: 'Keep the anxious kids in the room.',
      target_on: '2026-12-01',
    });
  });

  test('clearing the date removes the deadline rather than leaving it standing', async () => {
    /* '' and "omitted" are two different intentions at the route: one clears
       the date, the other leaves it alone. A coach taking back a deadline
       they no longer mean has to be able to say the first. */
    await renderPage({ goals: [goal()] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Correct wording' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Corrected target date'), { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    });

    const patch = writes.find((entry) => entry.method === 'PATCH');
    expect(patch?.body.target_on).toBe('');
  });

  test('a refused correction shows the server\'s own reason and keeps the form open', async () => {
    await renderPage({
      goals: [goal()],
      writeOk: false,
      writeError: 'A development goal needs a title -- what you are working on.',
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Correct wording' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Corrected title'), { target: { value: '  ' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    });

    expect(screen.getByText(/needs a title/i)).toBeTruthy();
    // Still open, so the coach can fix it rather than retype from scratch.
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeTruthy();
  });
});
