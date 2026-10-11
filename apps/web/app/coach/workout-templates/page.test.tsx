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
    const fetchMock = mockFetch((url) => (url.includes('template_id')
      ? jsonResponse({ template: BOXING_FUNDAMENTALS, items: [item()] })
      : jsonResponse({ templates: [BOXING_FUNDAMENTALS] })));

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

    it('a failed athlete read says so, and is not shown as having no athletes', async () => {
      mockIssuePage({ athletes: jsonResponse({}, false) });

      render(<CoachWorkoutTemplatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: /open template/i }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/The athletes could not be loaded/);
      expect(alert).toHaveTextContent(/not an empty list of athletes/);
      expect(screen.queryByText(/no athletes you can issue this to/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Athlete')).not.toBeInTheDocument();
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

  describe('what came back', () => {
    it('issued: how many Coach Cards, and plainly that each step is a separate card', async () => {
      mockIssuePage({ issue: () => statusResponse(201, ISSUED_BODY) });

      await issueTo();

      const status = await screen.findByRole('status');
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

      expect(await screen.findByRole('status')).toHaveTextContent('Issued to Dana Reyes: 1 Coach Card.');
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

      expect(await screen.findByRole('status')).toHaveTextContent('Adopted for this gym: Touch to Reposition, Pivot Out.');
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

      const status = await screen.findByRole('status');
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

      const status = await screen.findByRole('status');
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
        'Jab Ladder (step 3, 5): This gym already has a drill named "Jab Ladder", so this one cannot be adopted under that name.',
      ]);
      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it.each([
      [
        'an athlete or template the server will not name (404)',
        () => statusResponse(404, { error: 'Not found' }),
        'That athlete or template could not be found, or you can no longer reach that athlete. Nothing was issued.',
      ],
      [
        'another conflict, in the words the server used',
        () => statusResponse(409, {
          error: 'The drill library changed while this template was being issued. Nothing was issued; try again.',
          code: 'WORKOUT_TEMPLATE_ISSUE_STATE_CHANGED',
        }),
        'The drill library changed while this template was being issued. Nothing was issued; try again.',
      ],
      [
        'a server failure, without repeating whatever it said',
        () => statusResponse(500, { error: 'relation "pilot.drills" does not exist' }),
        'The template could not be issued. Nothing was issued.',
      ],
      [
        'a 201 this screen cannot read is not announced as issued',
        () => ({ ok: true, status: 201, json: async () => { throw new Error('not json'); } }) as unknown as Response,
        'The template could not be issued. Nothing was issued.',
      ],
    ] as Array<[string, () => Response, string]>)('%s', async (_label, issue, message) => {
      mockIssuePage({ issue });

      await issueTo();

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByText(/Issued to/)).not.toBeInTheDocument();
      expect(screen.queryByText(/does not exist/)).not.toBeInTheDocument();
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

  describe('a result belongs to the question that was asked', () => {
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
      expect(buttons.map((button) => button.textContent)).toEqual(['Confirm issue', 'Cancel']);
      for (const button of buttons) expect(button).toHaveClass('btn', 'btn--kiosk');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }));
      });
      await screen.findByRole('alert');
      expect(within(control).getByRole('button', { name: 'Issue to athlete' })).toHaveClass('btn', 'btn--kiosk');

      // No element in the control pins a size under the kiosk floor.
      const smaller = Array.from(control.querySelectorAll('*')).filter((element) =>
        /--t-(xs|sm)\b|\btext-(xs|sm)\b/.test(element.getAttribute('class') ?? ''));
      expect(smaller).toHaveLength(0);
    });
  });
});
