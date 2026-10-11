/**
 * @jest-environment jsdom
 */

// The workout-template catalog: the first UI consumer of the read-only
// GET /api/pilot/workout-templates route. What these pin: the page sits
// behind the coach gate; the list renders from `templates`, the key the
// route actually sends; opening a template shows its ordered items; an
// empty catalog is honest about being empty; a failed read admits templates
// may exist; and the ONLY write the page ever makes is issuing an open
// template to an athlete, after the coach confirms (second describe).

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CoachWorkoutTemplatesPage from './page';
import type { ClubRole } from '@/components/roleRoutes';

const capturedRoles: ClubRole[][] = [];

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: ClubRole[]; readonly children: ReactNode }) => {
    capturedRoles.push(allowedRoles);
    return children;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const BOXING_FUNDAMENTALS = {
  organization_id: 'org-1',
  template_id: 'wt-1',
  lineage_id: 'lin-1',
  version: 1,
  supersedes_template_id: null,
  superseded_at: null,
  name: 'Boxing Fundamentals 60',
  session_type: 'group_class',
  difficulty: 'beginner',
  age_band: '11-14',
  duration_minutes: 60,
  intent: 'Stance, guard, and the first two punches.',
  coach_notes: 'Keep the room moving between blocks.',
  requires_coach_authorization: false,
  active: true,
  created_by_account_id: null,
  created_by_role: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const CONDITIONING_ADV = {
  ...BOXING_FUNDAMENTALS,
  template_id: 'wt-2',
  lineage_id: 'lin-2',
  name: 'Conditioning Circuit 45',
  session_type: 'conditioning',
  difficulty: 'advanced',
  duration_minutes: 45,
  intent: 'Engine work under fatigue.',
};

function item(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    item_id: 'wti-1',
    template_id: 'wt-1',
    ordinal: 1,
    block: 'warmup',
    drill_id: null,
    free_text_drill: 'Rope intervals',
    scale_level: 'B',
    duration_minutes: 10,
    rep_count: null,
    contact_level: 'none',
    coach_note: 'Feet quiet, breathing loud.',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  capturedRoles.length = 0;
  jest.clearAllMocks();
});

describe('coach workout templates page', () => {
  it('sits behind the coach gate, matching the session-scripts page', async () => {
    mockFetch(() => jsonResponse({ templates: [] }));

    render(<CoachWorkoutTemplatesPage />);
    await screen.findByText(/No workout templates are loaded/i);

    expect(capturedRoles[0]).toEqual(['coach', 'admin']);
  });

  it('lists the templates returned by the route', async () => {
    mockFetch(() => jsonResponse({ templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText('Boxing Fundamentals 60')).toBeInTheDocument();
    expect(screen.getByText('Conditioning Circuit 45')).toBeInTheDocument();
    expect(screen.getByText(/Engine work under fatigue/)).toBeInTheDocument();
  });

  it('reads the list from `templates`, the key the route actually sends', async () => {
    // The drill library shipped broken for exactly this reason: the page read
    // a key the route never sent, so it rendered empty while tests passed.
    mockFetch(() => jsonResponse({ items: [BOXING_FUNDAMENTALS] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText(/No workout templates are loaded/i)).toBeInTheDocument();
  });

  it('opening a template shows its items from the detail read', async () => {
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    expect(await screen.findByText('Rope intervals')).toBeInTheDocument();
    expect(screen.getByText('warmup')).toBeInTheDocument();
    expect(screen.getByText('10 min')).toBeInTheDocument();
    expect(screen.getByText('Scale B')).toBeInTheDocument();
    expect(screen.getByText(/Feet quiet, breathing loud/)).toBeInTheDocument();
    expect(screen.getByText(/Keep the room moving between blocks/)).toBeInTheDocument();
  });

  it('says when an item uses an older drill version, and only on that item', async () => {
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({
        template: BOXING_FUNDAMENTALS,
        items: [
          item({
            item_id: 'wti-old',
            drill_id: 'drl-jab-v1',
            free_text_drill: null,
            head_drill_id: 'drl-jab-v2',
            uses_older_drill_version: true,
          }),
          item({
            item_id: 'wti-current',
            ordinal: 2,
            drill_id: 'drl-solo',
            free_text_drill: null,
            head_drill_id: 'drl-solo',
            uses_older_drill_version: false,
          }),
        ],
      })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    await screen.findByText('drl-jab-v1');
    expect(screen.getAllByText(/uses an older drill version/i)).toHaveLength(1);
    const oldItem = screen.getByText('drl-jab-v1').closest('li');
    expect(oldItem).toHaveTextContent(/uses an older drill version/i);
    expect(screen.getByText('drl-solo').closest('li')).not.toHaveTextContent(/older drill version/i);
  });

  it('a linked item shows its drill name, and the raw drill_id only when no name resolved', async () => {
    // Seeded template items all carry a drill_id, which is a key, not
    // something a coach can read off a tablet.
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({
        template: BOXING_FUNDAMENTALS,
        items: [
          item({
            item_id: 'wti-named',
            drill_id: 'drl_dbb0347500e7eb',
            free_text_drill: null,
            head_drill_id: 'drl_dbb0347500e7eb',
            head_drill_name: 'Touch to Reposition',
            uses_older_drill_version: false,
          }),
          item({
            item_id: 'wti-unresolved',
            ordinal: 2,
            drill_id: 'drl_missing',
            free_text_drill: null,
            head_drill_id: null,
            head_drill_name: null,
            uses_older_drill_version: false,
          }),
        ],
      })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    expect(await screen.findByRole('heading', { name: 'Touch to Reposition' })).toBeInTheDocument();
    expect(screen.queryByText('drl_dbb0347500e7eb')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'drl_missing' })).toBeInTheDocument();
  });

  it('an empty catalog says so honestly', async () => {
    mockFetch(() => jsonResponse({ templates: [] }));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText('No workout templates are loaded in this environment yet.')).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty catalog', async () => {
    mockFetch(() => jsonResponse({}, false));

    render(<CoachWorkoutTemplatesPage />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/not an empty catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/No workout templates are loaded/i)).not.toBeInTheDocument();
  });

  it('a failed detail read is its own alert, not silently empty items', async () => {
    mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({}, false)
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
  });

  it('browsing and opening a template sends only reads: nothing is written until an issue is confirmed', async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes('/api/pilot/coach/athletes')) return jsonResponse({ ok: true, items: [] });
      return url.includes('template_id')
        ? jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] })
        : jsonResponse({ templates: [BOXING_FUNDAMENTALS] });
    });

    render(<CoachWorkoutTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open template/i }));
    await screen.findByText('Rope intervals');
    await screen.findByText(/no athletes you can issue this to/i);

    const writes = fetchMock.mock.calls.filter((call) => {
      const method = ((call[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
      return method !== 'GET';
    });
    expect(writes).toHaveLength(0);
  });

  it('no longer calls itself read-only, and says where issuing happens', async () => {
    mockFetch(() => jsonResponse({ templates: [] }));

    render(<CoachWorkoutTemplatesPage />);
    await screen.findByText(/No workout templates are loaded/i);

    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Open one to issue it to an athlete/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ISSUE TO ATHLETE (lane P7, #1401): the page's one write.
// ---------------------------------------------------------------------------

const ISSUE_URL = '/api/pilot/workout-templates/issue';
const ATHLETES_URL = '/api/pilot/coach/athletes';

const ATHLETES = [
  { athlete_id: 'ath-1', full_name: 'Dana Reyes' },
  { athlete_id: 'ath-2', full_name: 'Sam Okafor' },
];

function statusResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const ISSUED_BODY = {
  ok: true,
  athlete_id: 'ath-1',
  template: { template_id: 'wt-1', name: 'Boxing Fundamentals 60', version: 1 },
  created: { assignments: 2, adopted_drills: 0 },
  steps: [
    { step: 1, item_id: 'wti-1', assignment: { assignment_id: 'a-1' } },
    { step: 2, item_id: 'wti-2', assignment: { assignment_id: 'a-2' } },
  ],
  adopted_drills: [],
  not_carried: ['block', 'ordinal', 'scale_level', 'contact_level', 'coach_note'],
};

const REFUSED_BODY = {
  error: 'Nothing was issued. Not floor-tested by a coach of this gym yet: Slip Rope Shuffle. Cannot be assigned as they stand: Jab Ladder.',
  code: 'WORKOUT_TEMPLATE_ISSUE_REFUSED',
  drills: [
    {
      steps: [2],
      drill_id: 'ref-2',
      name: 'Slip Rope Shuffle',
      untested_draft: true,
      reason: 'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.',
    },
    {
      steps: [3, 5],
      drill_id: 'ref-3',
      name: 'Jab Ladder',
      untested_draft: false,
      reason: 'This gym already has a drill named "Jab Ladder", so this one cannot be adopted under that name.',
    },
  ],
};

/**
 * The page with one template open. `issue` answers the POST; `athletes` is the
 * picker read's answer (a Response, so a failed read can be given too).
 */
function mockIssuePage(opts: {
  issue?: () => Response;
  athletes?: Response;
  templates?: unknown[];
  items?: unknown[];
} = {}) {
  return mockFetch((url) => {
    if (url.includes(ISSUE_URL)) {
      if (!opts.issue) throw new Error('test bug: an issue was sent that this case did not expect');
      return opts.issue();
    }
    if (url.includes(ATHLETES_URL)) return opts.athletes ?? jsonResponse({ ok: true, items: ATHLETES });
    if (url.includes('template_id=wt-2')) return jsonResponse({ template: CONDITIONING_ADV, items: [item({ template_id: 'wt-2' })] });
    if (url.includes('template_id')) {
      return jsonResponse({ template: BOXING_FUNDAMENTALS, items: opts.items ?? [item(), item({ item_id: 'wti-2', ordinal: 2 })] });
    }
    return jsonResponse({ templates: opts.templates ?? [BOXING_FUNDAMENTALS] });
  });
}

const issuePosts = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter((call) => String(call[0]).includes(ISSUE_URL));

/** Opens the first template and waits for the picker. */
async function openTemplate() {
  render(<CoachWorkoutTemplatesPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: /open template/i }))[0]);
  return screen.findByLabelText('Athlete');
}

/** Picks an athlete and goes to the confirm step. */
async function chooseAndAsk(athleteId = 'ath-1') {
  const picker = await openTemplate();
  fireEvent.change(picker, { target: { value: athleteId } });
  fireEvent.click(screen.getByRole('button', { name: 'Issue to athlete' }));
}

/** The whole action: pick, ask, confirm. */
async function issueTo(athleteId = 'ath-1') {
  await chooseAndAsk(athleteId);
  // Inside act, so the state the answer sets is flushed before the case reads
  // the screen -- an issue that fails at once would otherwise update outside it.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }));
  });
}

/** The status region once an issue has been announced in it (it is always mounted, empty until then). */
async function issuedStatus() {
  await screen.findByText(/^Issued to /);
  return screen.getByRole('status');
}

const UNKNOWN_SENTENCE =
  "This screen could not tell whether the template was issued. Check the athlete's Coach Cards before trying again.";

describe('issue to athlete', () => {
  describe('the picker', () => {
    it('is filled from the athletes this coach can reach, not from the whole gym list', async () => {
      const fetchMock = mockIssuePage();

      const picker = await openTemplate();

      expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Choose an athlete',
        'Dana Reyes',
        'Sam Okafor',
      ]);
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.filter((url) => url.endsWith(ATHLETES_URL))).toHaveLength(1);
      expect(urls.some((url) => url.includes('/api/pilot/athletes/list'))).toBe(false);
    });

    it('is sorted by name, whatever order the roster came in', async () => {
      mockIssuePage({
        athletes: jsonResponse({
          ok: true,
          items: [
            { athlete_id: 'ath-3', full_name: 'Zoe Park' },
            { athlete_id: 'ath-1', full_name: 'Dana Reyes' },
            { athlete_id: 'ath-2', full_name: 'Sam Okafor' },
          ],
        }),
      });

      const picker = await openTemplate();

      expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Choose an athlete',
        'Dana Reyes',
        'Sam Okafor',
        'Zoe Park',
      ]);
    });

    const FAILED_READS: Array<[string, () => Response]> = [
      ['a refused read', () => jsonResponse({}, false)],
      ['an answer with no list in it (the wrong key)', () => jsonResponse({ ok: true, athletes: ATHLETES })],
      ['an answer whose list is not a list', () => jsonResponse({ ok: true, items: 'none' })],
      ['a list with an entry that cannot be read (it would silently leave the picker)', () => jsonResponse({ ok: true, items: [ATHLETES[0], { athlete_id: 'ath-9' }] })],
      ['a list where no entry can be read', () => jsonResponse({ ok: true, items: [{ name: 'Dana' }, null] })],
      ['no answer at all', () => {
        throw new TypeError('Failed to fetch');
      }],
    ];

    it.each(FAILED_READS)('%s says the athletes could not be loaded, never that there are none', async (_label, answer) => {
      mockFetch((url) => {
        if (url.includes(ATHLETES_URL)) return answer();
        if (url.includes('template_id')) return jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS] });
      });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'The athletes could not be loaded. This is a failure to load, not an empty list of athletes.',
      );
      // The browser's own error text is not put on a coach's screen.
      expect(alert).not.toHaveTextContent(/Failed to fetch/);
      expect(screen.queryByText(/no athletes you can issue this to/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Athlete')).not.toBeInTheDocument();
    });

    it('Try again reads the athletes again, and the picker appears when that read answers', async () => {
      let reads = 0;
      mockFetch((url) => {
        if (url.includes(ATHLETES_URL)) {
          reads += 1;
          return reads === 1 ? jsonResponse({}, false) : jsonResponse({ ok: true, items: ATHLETES });
        }
        if (url.includes('template_id')) return jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS] });
      });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));
      const retry = await screen.findByRole('button', { name: 'Try again' });
      expect(retry).toHaveClass('btn', 'btn--kiosk');
      fireEvent.click(retry);

      expect(await screen.findByLabelText('Athlete')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(reads).toBe(2);
    });

    it('a coach who reaches nobody is told so, and is offered no picker and no button', async () => {
      mockIssuePage({ athletes: jsonResponse({ ok: true, items: [] }) });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

      expect(await screen.findByText('You have no athletes you can issue this to.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Athlete')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Issue to athlete' })).not.toBeInTheDocument();
    });

    it('a template with no steps offers nothing to issue', async () => {
      mockIssuePage({ items: [] });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));
      await screen.findByText('This template has no items yet.');

      expect(screen.queryByRole('heading', { name: 'Issue to athlete' })).not.toBeInTheDocument();
    });
  });

  describe('nothing is sent before the coach confirms', () => {
    it('the Issue button is disabled until an athlete is chosen', async () => {
      mockIssuePage();

      const picker = await openTemplate();
      expect(screen.getByRole('button', { name: 'Issue to athlete' })).toBeDisabled();

      fireEvent.change(picker, { target: { value: 'ath-2' } });
      expect(screen.getByRole('button', { name: 'Issue to athlete' })).toBeEnabled();
    });

    it('choosing an athlete and tapping Issue asks first: it names the template and the athlete, and sends nothing', async () => {
      const fetchMock = mockIssuePage();

      await chooseAndAsk('ath-2');

      expect(
        screen.getByText('Issue Boxing Fundamentals 60 to Sam Okafor? Each step becomes a separate Coach Card.'),
      ).toBeInTheDocument();
      expect(issuePosts(fetchMock)).toHaveLength(0);
    });

    it('during the confirm step the Issue button stays in its place, disabled: a double tap cannot land on Confirm', async () => {
      const fetchMock = mockIssuePage();

      await chooseAndAsk();

      const issueButton = screen.getByRole('button', { name: 'Issue to athlete' });
      expect(issueButton).toBeDisabled();
      // It comes before Confirm in the document, where it was a moment ago.
      const confirm = screen.getByRole('button', { name: 'Confirm issue' });
      expect(issueButton.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(issueButton);
      expect(issuePosts(fetchMock)).toHaveLength(0);
    });

    it('Cancel sends nothing and goes back to the first step', async () => {
      const fetchMock = mockIssuePage();

      await chooseAndAsk();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(issuePosts(fetchMock)).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Confirm issue' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Issue to athlete' })).toBeEnabled();
    });
  });

  describe('confirming', () => {
    it('sends ONE POST naming the open template and the chosen athlete, with the session cookie', async () => {
      const fetchMock = mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo('ath-1');
      await screen.findByText(/Issued to Dana Reyes/);

      const posts = issuePosts(fetchMock);
      expect(posts).toHaveLength(1);
      const init = posts[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init.body))).toEqual({ template_id: 'wt-1', athlete_id: 'ath-1' });
    });

    it('while the issue is running every control is disabled, and a second tap sends nothing more', async () => {
      let answer: (response: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(ISSUE_URL)) return pending;
        if (url.includes(ATHLETES_URL)) return jsonResponse({ ok: true, items: ATHLETES });
        if (url.includes('template_id')) return jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS] });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await issueTo();

      const running = await screen.findByRole('button', { name: 'Issuing...' });
      expect(running).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(screen.getByLabelText('Athlete')).toBeDisabled();
      expect(running).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(running);
      fireEvent.click(running);
      expect(issuePosts(fetchMock)).toHaveLength(1);

      await act(async () => {
        answer(statusResponse(201, ISSUED_BODY));
        await pending;
      });
      expect(await screen.findByText(/Issued to Dana Reyes/)).toBeInTheDocument();
      expect(issuePosts(fetchMock)).toHaveLength(1);
    });
  });

  describe('an issue that is running keeps its screen until it answers', () => {
    it('no template can be opened while an issue runs, so its answer always has somewhere to land', async () => {
      let answer: (response: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(ISSUE_URL)) return pending;
        if (url.includes(ATHLETES_URL)) return jsonResponse({ ok: true, items: ATHLETES });
        if (url.includes('template_id')) return jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV] });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await issueTo();
      await screen.findByRole('button', { name: 'Issuing...' });

      const openButtons = () => [
        screen.getByRole('button', { name: 'Showing template' }),
        screen.getByRole('button', { name: 'Open template' }),
      ];
      for (const button of openButtons()) expect(button).toBeDisabled();
      const detailReads = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('template_id')).length;
      const before = detailReads();
      for (const button of openButtons()) fireEvent.click(button);
      expect(detailReads()).toBe(before);

      await act(async () => {
        answer(statusResponse(201, ISSUED_BODY));
        await pending;
      });

      // The answer is on screen, and the other template can be opened again.
      expect(await issuedStatus()).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
      expect(screen.getByRole('button', { name: 'Open template' })).toBeEnabled();
    });

    it('two template reads that overlap: a late answer to the first never swaps the template under the issue control', async () => {
      // Tap A (slow), tap B (answers), pick an athlete and reach the confirm
      // step on B. Then A's answer arrives late. The screen must still be B's.
      let answerFirst: (response: Response) => void = () => {};
      const first = new Promise<Response>((resolve) => {
        answerFirst = resolve;
      });
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(ISSUE_URL)) return statusResponse(201, ISSUED_BODY);
        if (url.includes(ATHLETES_URL)) return jsonResponse({ ok: true, items: ATHLETES });
        if (url.includes('template_id=wt-1')) return first;
        if (url.includes('template_id=wt-2')) return jsonResponse({ template: CONDITIONING_ADV, items: [item({ template_id: 'wt-2' })] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV] });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<CoachWorkoutTemplatesPage />);
      const openButtons = await screen.findAllByRole('button', { name: 'Open template' });
      fireEvent.click(openButtons[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Open template' }));
      fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Issue to athlete' }));
      const sentence = 'Issue Conditioning Circuit 45 to Dana Reyes? Each step becomes a separate Coach Card.';
      expect(screen.getByText(sentence)).toBeInTheDocument();

      await act(async () => {
        answerFirst(jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] }));
        await first;
      });

      // Still the second template: heading, confirm sentence, and what Confirm sends.
      expect(screen.getByRole('heading', { level: 2, name: 'Conditioning Circuit 45' })).toBeInTheDocument();
      expect(screen.getByText(sentence)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }));
      });
      await issuedStatus();
      const posts = issuePosts(fetchMock);
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0] as unknown as [unknown, RequestInit])[1].body))).toEqual({ template_id: 'wt-2', athlete_id: 'ath-1' });
    });

    it('a late FAILED answer to an earlier read does not close the template that is open', async () => {
      let answerFirst: (response: Response) => void = () => {};
      const first = new Promise<Response>((resolve) => {
        answerFirst = resolve;
      });
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(ATHLETES_URL)) return jsonResponse({ ok: true, items: ATHLETES });
        if (url.includes('template_id=wt-1')) return first;
        if (url.includes('template_id=wt-2')) return jsonResponse({ template: CONDITIONING_ADV, items: [item({ template_id: 'wt-2' })] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV] });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click((await screen.findAllByRole('button', { name: 'Open template' }))[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Open template' }));
      await screen.findByLabelText('Athlete');

      await act(async () => {
        answerFirst(jsonResponse({}, false));
        await first;
      });

      expect(screen.getByRole('heading', { level: 2, name: 'Conditioning Circuit 45' })).toBeInTheDocument();
      expect(screen.getByLabelText('Athlete')).toBeInTheDocument();
      expect(screen.queryByText(/could not be opened/i)).not.toBeInTheDocument();
    });

    it('a showing template with no steps has no control to protect, so it can still be re-read', async () => {
      const fetchMock = mockIssuePage({ items: [] });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));
      await screen.findByText('This template has no items yet.');
      const showing = screen.getByRole('button', { name: 'Showing template' });
      expect(showing).toBeEnabled();
      const reads = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('template_id')).length;
      const before = reads();
      fireEvent.click(showing);

      await waitFor(() => expect(reads()).toBe(before + 1));
    });

    it('the template already showing cannot be re-opened by a stray tap, which would wipe the result being read', async () => {
      const fetchMock = mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo();
      await issuedStatus();
      const showing = screen.getByRole('button', { name: 'Showing template' });
      expect(showing).toBeDisabled();
      const detailReads = fetchMock.mock.calls.filter((call) => String(call[0]).includes('template_id')).length;
      fireEvent.click(showing);

      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('template_id'))).toHaveLength(detailReads);
      expect(screen.getByRole('status')).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
    });
  });

  describe('what came back', () => {
    it('issued: how many Coach Cards, and plainly that each step is a separate card', async () => {
      mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo();

      const status = await issuedStatus();
      expect(status).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
      expect(status).toHaveTextContent(
        'Each step is a separate Coach Card for now. The block, order, scale level, contact level and coach note are not carried.',
      );
      // Nothing adopted and nobody held: neither line is drawn.
      expect(status).not.toHaveTextContent(/Adopted for this gym/);
      expect(status).not.toHaveTextContent(/training hold/i);
      // The confirm step is over.
      expect(screen.queryByRole('button', { name: 'Confirm issue' })).not.toBeInTheDocument();
    });

    it('one step is one Coach Card, in the singular', async () => {
      mockIssuePage({ issue: () => statusResponse(201, { ...ISSUED_BODY, steps: [ISSUED_BODY.steps[0]] }) });

      await issueTo();

      expect(await issuedStatus()).toHaveTextContent('Issued to Dana Reyes: 1 Coach Card.');
    });

    it('with no step list in the answer the count comes from what the server says it created', async () => {
      const withoutSteps: Record<string, unknown> = { ...ISSUED_BODY, created: { assignments: 3, adopted_drills: 0 } };
      delete withoutSteps.steps;
      mockIssuePage({ issue: () => statusResponse(201, withoutSteps) });

      await issueTo();

      expect(await issuedStatus()).toHaveTextContent('Issued to Dana Reyes: 3 Coach Cards.');
    });

    it('an answer that gives no count is still an issue, and says the count could not be read rather than 0', async () => {
      mockIssuePage({ issue: () => statusResponse(201, { ok: true }) });

      await issueTo();

      const status = await issuedStatus();
      expect(status).toHaveTextContent('Issued to Dana Reyes. The number of Coach Cards could not be read.');
      expect(status).not.toHaveTextContent(/0 Coach Cards/);
    });

    it('a 201 whose body cannot be read IS an issue: said as issued, details unread, and not to issue it again', async () => {
      // The route answers 201 only after its transaction commits. Reading this
      // as "nothing was issued" is how an athlete ends up with every card twice.
      mockIssuePage({
        issue: () => ({ ok: true, status: 201, json: async () => { throw new Error('not json'); } }) as unknown as Response,
      });

      await issueTo();

      const status = await issuedStatus();
      expect(status).toHaveTextContent(
        "Issued to Dana Reyes, but the details could not be read here. Check the athlete's Coach Cards rather than issuing it again.",
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/Nothing was issued/)).not.toBeInTheDocument();
    });

    it('names the drills the gym adopted on the way', async () => {
      mockIssuePage({
        issue: () => statusResponse(201, {
          ...ISSUED_BODY,
          adopted_drills: [
            { drill_id: 'op-1', reference_drill_id: 'ref-1', name: 'Touch to Reposition' },
            { drill_id: 'op-2', reference_drill_id: 'ref-2', name: 'Pivot Out' },
          ],
        }),
      });

      await issueTo();

      expect(await issuedStatus()).toHaveTextContent('Adopted for this gym: Touch to Reposition, Pivot Out.');
    });

    it('a training hold is said beside the result, and says the issue was NOT blocked', async () => {
      mockIssuePage({
        issue: () => statusResponse(201, {
          ...ISSUED_BODY,
          hold_warning: {
            hold_id: 'hold-1',
            scope: 'contact_only',
            reason_category: 'medical',
            athlete_explanation: 'Resting this week.',
            lift_condition_text: 'Cleared by the coach.',
            expires_at: null,
          },
        }),
      });

      await issueTo();

      const status = await issuedStatus();
      // Issued all the same.
      expect(status).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
      expect(status).toHaveTextContent(
        "This athlete has an active training hold (CONTACT WORK). Issuing was NOT blocked; confirm the hold's scope covers these drills.",
      );
      // The category and the staff-facing texts are not repeated here.
      expect(status).not.toHaveTextContent(/medical|Resting this week|Cleared by the coach/);
    });

    it.each([
      ['the server could not read the hold', 'unreadable'],
      ['a hold this screen cannot read', { scope: 'something_new' }],
      ['a hold answer that is not an object', 7],
    ] as Array<[string, unknown]>)('%s is shown as unknown, never as no hold', async (_label, holdWarning) => {
      mockIssuePage({ issue: () => statusResponse(201, { ...ISSUED_BODY, hold_warning: holdWarning }) });

      await issueTo();

      const status = await issuedStatus();
      expect(status).toHaveTextContent(
        'Whether this athlete is under a training hold could not be read; check the training holds record.',
      );
      expect(status).not.toHaveTextContent(/has an active training hold/);
    });

    it('refused: the server sentence, then every named drill with its steps and reason, and nothing claimed issued', async () => {
      mockIssuePage({ issue: () => statusResponse(409, REFUSED_BODY) });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(REFUSED_BODY.error);
      const rows = within(alert).getAllByRole('listitem');
      expect(rows.map((row) => row.textContent)).toEqual([
        'Slip Rope Shuffle (step 2): It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.',
        'Jab Ladder (steps 3, 5): This gym already has a drill named "Jab Ladder", so this one cannot be adopted under that name.',
      ]);
      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('a refusal with a typed step, and with entries this screen cannot read, is still drawn: nothing crashes the page', async () => {
      mockIssuePage({
        issue: () => statusResponse(409, {
          error: 'Nothing was issued. Cannot be assigned as they stand: Jump rope, easy.',
          code: 'WORKOUT_TEMPLATE_ISSUE_REFUSED',
          drills: [
            { steps: [2], drill_id: null, name: 'Jump rope, easy', untested_draft: false, reason: 'This step is typed text, not a drill from the library, so it cannot be assigned.' },
            null,
            { name: 'No Steps Listed', reason: 'It has no stop rules.' },
            { steps: [4], name: '   ' },
            'not an object',
          ],
        }),
      });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(within(alert).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
        'Jump rope, easy (step 2): This step is typed text, not a drill from the library, so it cannot be assigned.',
        'No Steps Listed: It has no stop rules.',
        'A step with no name (step 4)',
      ]);
    });

    it('a refusal with no drill list still shows the server sentence', async () => {
      mockIssuePage({
        issue: () => statusResponse(409, { error: 'Nothing was issued.', code: 'WORKOUT_TEMPLATE_ISSUE_REFUSED' }),
      });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Nothing was issued.');
      expect(within(alert).queryAllByRole('listitem')).toHaveLength(0);
    });

    // The server refused before or inside the write: nothing exists, and the screen may say so.
    const NOT_ISSUED: Array<[string, () => Response, string]> = [
      [
        'an athlete or template the server will not name (404)',
        () => statusResponse(404, { error: 'Not found' }),
        'That athlete or template could not be found, or you can no longer reach that athlete. Nothing was issued.',
      ],
      [
        'a conflict that already says nothing was issued keeps the words the server used',
        () => statusResponse(409, {
          error: 'The drill library changed while this template was being issued. Nothing was issued; try again.',
          code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
        }),
        'The drill library changed while this template was being issued. Nothing was issued; try again.',
      ],
      [
        'a conflict that does not say so has it added',
        () => statusResponse(409, { error: 'This workout template has no steps to issue.', code: 'WORKOUT_TEMPLATE_EMPTY' }),
        'This workout template has no steps to issue. Nothing was issued.',
      ],
      [
        'a drill retired in the meantime (400), in the words the server used',
        () => statusResponse(400, {
          error: 'That drill is not an active drill in this gym, so it cannot be assigned.',
          code: 'DRILL_NOT_ASSIGNABLE',
        }),
        'That drill is not an active drill in this gym, so it cannot be assigned. Nothing was issued.',
      ],
      [
        'a 400 whose sentence has no full stop still reads as two sentences',
        () => statusResponse(400, { error: 'Missing athlete_id' }),
        'Missing athlete_id. Nothing was issued.',
      ],
      [
        'a 400 with nothing to read',
        () => ({ ok: false, status: 400, json: async () => { throw new Error('not json'); } }) as unknown as Response,
        'The template could not be issued. Nothing was issued.',
      ],
      [
        'a session that has ended (401)',
        () => statusResponse(401, { error: 'Unauthorized' }),
        'You are signed out, so nothing was issued. Sign in again.',
      ],
      [
        'a role that may not issue (403)',
        () => statusResponse(403, { error: 'Forbidden' }),
        'This account may not issue templates. Nothing was issued.',
      ],
    ];

    it.each(NOT_ISSUED)('not issued -- %s', async (_label, issue, message) => {
      mockIssuePage({ issue });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(message);
      expect(alert.textContent).toBe(message);
      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
    });

    // The answer does not say which way it went. The write may have landed, so
    // the screen must not say it did not -- and must not repeat a server error.
    const CANNOT_TELL: Array<[string, () => Response]> = [
      ['a server error (500)', () => statusResponse(500, { error: 'relation "pilot.drills" does not exist' })],
      ['a gateway error with no JSON (502)', () => ({ ok: false, status: 502, json: async () => { throw new Error('<html>'); } }) as unknown as Response],
      ['too many requests (429)', () => statusResponse(429, { error: 'Too many requests' })],
      ['a 200 that is not the route\'s own 201 (a sign-in page, a proxy)', () => ({ ok: true, status: 200, json: async () => { throw new Error('<html>'); } }) as unknown as Response],
      ['a 200 with a JSON body that is still not a 201', () => statusResponse(200, ISSUED_BODY)],
    ];

    it.each(CANNOT_TELL)('cannot tell -- %s: said as unknown, never as issued and never as nothing issued', async (_label, issue) => {
      mockIssuePage({ issue });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(UNKNOWN_SENTENCE);
      expect(screen.queryByText(/Nothing was issued/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
      expect(screen.queryByText(/does not exist|Too many requests/)).not.toBeInTheDocument();
    });

    it('no answer at all: says it may or may not have been issued, and to check before trying again', async () => {
      mockIssuePage({
        issue: () => {
          throw new TypeError('Failed to fetch');
        },
      });

      await issueTo();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        "No answer came back, so this template may or may not have been issued. Check the athlete's Coach Cards before trying again.",
      );
      expect(alert).not.toHaveTextContent(/Nothing was issued/);
      // The controls come back; the coach is not left on a dead screen.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Issue to athlete' })).toBeEnabled());
    });
  });

  describe('focus follows the step, so each one is read out and nobody is dropped at the top of the page', () => {
    it('tapping Issue moves focus to the confirm sentence; Cancel returns it to the Issue button', async () => {
      mockIssuePage();

      await chooseAndAsk();
      expect(
        screen.getByText('Issue Boxing Fundamentals 60 to Dana Reyes? Each step becomes a separate Coach Card.'),
      ).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Issue to athlete' })).toHaveFocus();
    });

    it('asking again for another athlete moves focus to the NEW confirm sentence', async () => {
      mockIssuePage();

      await chooseAndAsk('ath-1');
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Issue to athlete' }));

      expect(
        screen.getByText('Issue Boxing Fundamentals 60 to Sam Okafor? Each step becomes a separate Coach Card.'),
      ).toHaveFocus();
    });

    it.each([
      ['an issue', () => statusResponse(201, ISSUED_BODY)],
      ['a refusal', () => statusResponse(409, REFUSED_BODY)],
      ['an answer that cannot be told', () => statusResponse(500, {})],
    ] as Array<[string, () => Response]>)('when %s lands, focus is on the result', async (_label, issue) => {
      mockIssuePage({ issue });

      await issueTo();
      await waitFor(() => expect(screen.getByRole('status').parentElement).toHaveFocus());
    });
  });

  describe('a refusal or failure is drawn in the error ink, not the body ink', () => {
    // `.t-body` sets its own colour in the unlayered sheet, which outranks a
    // Tailwind colour utility. So the error text must NOT wear t-body, or it
    // renders exactly like a success.
    it.each([
      ['a refusal', () => statusResponse(409, REFUSED_BODY), REFUSED_BODY.error],
      ['a failure', () => statusResponse(404, {}), 'That athlete or template could not be found, or you can no longer reach that athlete. Nothing was issued.'],
    ] as Array<[string, () => Response, string]>)('%s', async (_label, issue, sentence) => {
      mockIssuePage({ issue });

      await issueTo();

      const text = await screen.findByText(sentence);
      expect(text).toHaveClass('text-[var(--locked-ink)]', 'text-[length:var(--t-md)]');
      expect(text).not.toHaveClass('t-body');
    });
  });

  describe('a result belongs to the question that was asked', () => {
    it('a stray tap on Issue, then Cancel, does not erase the result: it goes only when a new issue is sent', async () => {
      const fetchMock = mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo('ath-1');
      await issuedStatus();
      fireEvent.click(screen.getByRole('button', { name: 'Issue to athlete' }));
      expect(screen.getByRole('status')).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('status')).toHaveTextContent('Issued to Dana Reyes: 2 Coach Cards.');
      expect(issuePosts(fetchMock)).toHaveLength(1);
    });

    it('when a second issue is sent, the first result leaves the screen at once: it is not left standing as the answer to the new one', async () => {
      let sends = 0;
      let answer: (response: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(ISSUE_URL)) {
          sends += 1;
          return sends === 1 ? statusResponse(201, ISSUED_BODY) : pending;
        }
        if (url.includes(ATHLETES_URL)) return jsonResponse({ ok: true, items: ATHLETES });
        if (url.includes('template_id')) return jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] });
        return jsonResponse({ templates: [BOXING_FUNDAMENTALS] });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await issueTo('ath-1');
      await issuedStatus();
      fireEvent.click(screen.getByRole('button', { name: 'Issue to athlete' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }));
      });

      await screen.findByRole('button', { name: 'Issuing...' });
      expect(screen.getByRole('status')).toBeEmptyDOMElement();

      await act(async () => {
        answer(statusResponse(409, REFUSED_BODY));
        await pending;
      });
      expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED_BODY.error);
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('choosing a different athlete closes the confirm step, so Confirm can never send the athlete picked before', async () => {
      const fetchMock = mockIssuePage();

      await chooseAndAsk('ath-1');
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });

      expect(screen.queryByRole('button', { name: 'Confirm issue' })).not.toBeInTheDocument();
      expect(screen.queryByText(/to Dana Reyes\?/)).not.toBeInTheDocument();
      expect(issuePosts(fetchMock)).toHaveLength(0);
    });

    it('choosing a different athlete clears the result', async () => {
      mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo('ath-1');
      await screen.findByText(/Issued to Dana Reyes/);
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });

      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
    });

    it('opening another template starts clean: no athlete chosen, no result from the last one', async () => {
      mockIssuePage({
        templates: [BOXING_FUNDAMENTALS, CONDITIONING_ADV],
        issue: () => statusResponse(409, REFUSED_BODY),
      });

      await issueTo('ath-1');
      await screen.findByRole('alert');
      fireEvent.click(screen.getByRole('button', { name: 'Open template' }));

      const picker = await screen.findByLabelText('Athlete');
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Conditioning Circuit 45' })).toBeInTheDocument());
      expect(picker).toHaveValue('');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Issue to athlete' })).toBeDisabled();
    });
  });

  describe('gym-floor sizes (Law 5), by the classes that carry them', () => {
    // What this can prove: the control sits on the kiosk surface and every
    // control wears the 55px classes; no text inside steps below the 19.1px
    // voice. What it cannot: the rendered pixels on a tablet. That needs eyes.
    it('the whole control is on the kiosk surface, the picker and every button on the 55px classes', async () => {
      mockIssuePage({ issue: () => statusResponse(409, REFUSED_BODY) });

      await chooseAndAsk();

      const surface = screen.getByRole('heading', { name: 'Issue to athlete' }).closest('[data-surface="kiosk"]');
      expect(surface).not.toBeNull();
      const control = surface as HTMLElement;
      expect(within(control).getByLabelText('Athlete')).toHaveClass('select', 'input--kiosk');
      const buttons = within(control).getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual(['Issue to athlete', 'Confirm issue', 'Cancel']);
      for (const button of buttons) expect(button).toHaveClass('btn', 'btn--kiosk');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }));
      });
      await screen.findByRole('alert');
      expect(within(control).getByRole('button', { name: 'Issue to athlete' })).toHaveClass('btn', 'btn--kiosk');

      // No element in the control pins a size under the kiosk floor: not a
      // small rung of the ladder, not a pixel size, not an inline style.
      const smaller = Array.from(control.querySelectorAll('*')).filter((element) =>
        /--t-(xs|sm)\b|\btext-(xs|sm)\b|text-\[[\d.]/.test(element.getAttribute('class') ?? '')
        || (element.getAttribute('style') ?? '').includes('font-size'));
      expect(smaller).toHaveLength(0);
      // And every piece of text in it sits in an element that carries a floored voice or the floor itself.
      const textHolders = Array.from(control.querySelectorAll('p, li, label, h3'));
      expect(textHolders.length).toBeGreaterThan(0);
      for (const holder of textHolders) {
        expect(holder.getAttribute('class') ?? '').toMatch(/\bt-(body|label)\b|text-\[length:var\(--t-md\)\]/);
      }
    });
  });
});
