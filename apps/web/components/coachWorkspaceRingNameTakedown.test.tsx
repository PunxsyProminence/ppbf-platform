/**
 * @jest-environment jsdom
 */

/**
 * The ring-name takedown has a door.
 *
 * POST /api/pilot/profile/nickname/clear shipped with the ring-name slice and
 * nothing on any screen called it. profileIdentity.ts's own argument for not
 * running a wordlist over children's ring names rests on three legs -- bounded
 * shape, tiny audience, and "the adults who know the child can clear it
 * outright, immediately, with no appeal step" -- and the third leg was a route
 * with no caller. A capability an adult cannot reach is a capability the gym
 * does not have.
 *
 * These cases are about the ways that door can be built wrong: opening onto a
 * child it cannot act for, opening with one tap on a change that has no undo,
 * or reporting a takedown that did not happen.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

interface RosterFace {
  athlete_id: string;
  account_id: string | null;
  initials: string;
  ring_name: string | null;
  photo_available: boolean;
  is_mine: boolean;
}

/**
 * Three children, and the differences between them are the whole point.
 *
 * MINE has a ring name and this coach is the coach of record -- the only row
 * the takedown may appear on. COVERED has a ring name this coach can READ (an
 * adult athlete's ring name reaches any organization staff; a minor's never
 * leaves MINOR_CIRCLE) while resolveRelationship still answers
 * 'organization_staff' for them, so a takedown would be refused. PLAIN is this
 * coach's own and simply has no ring name to take down.
 */
const FACES: readonly RosterFace[] = [
  {
    athlete_id: 'ath_mine',
    account_id: 'acct_mine',
    initials: 'MV',
    ring_name: 'Thunder',
    photo_available: false,
    is_mine: true,
  },
  {
    athlete_id: 'ath_covered',
    account_id: 'acct_covered',
    initials: 'DP',
    ring_name: 'Hammer',
    photo_available: false,
    is_mine: false,
  },
  {
    athlete_id: 'ath_plain',
    account_id: 'acct_plain',
    initials: 'RO',
    ring_name: null,
    photo_available: false,
    is_mine: true,
  },
];

const ATHLETE_NAMES: Readonly<Record<string, string>> = {
  ath_mine: 'Marisol Vance',
  ath_covered: 'Devon Pike',
  ath_plain: 'Rosa Ortiz',
};

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

interface Routes {
  /** What POST /api/pilot/profile/nickname/clear answers. */
  clear?: (body: { account_id?: string }) => Promise<Response> | Response;
  roster?: () => Response;
}

function installFetch(routes: Routes = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/profile/nickname/clear')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { account_id?: string };
      return routes.clear ? routes.clear(body) : jsonResponse({ ok: true, locked_for_hours: 72 });
    }
    if (url.includes('/api/pilot/profile/roster')) {
      return routes.roster ? routes.roster() : jsonResponse({ ok: true, items: FACES });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: FACES.map((face) => ({
          athlete_id: face.athlete_id,
          full_name: ATHLETE_NAMES[face.athlete_id],
          gym_status: 'Foundations',
        })),
      });
    }
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/sessions/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/floor-plans')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/shadow/review-projection')) return jsonResponse({ queue: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/coach-reviews')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) {
      return jsonResponse({ ok: true, barrierReports: [], truncated: false });
    }
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: [] });

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: Routes = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  await screen.findByText('Marisol Vance');
  return fetchMock;
}

/** Clicks the roster row for an athlete -- the whole card is the select. */
async function selectAthlete(athleteId: string): Promise<void> {
  const name = ATHLETE_NAMES[athleteId];
  await act(async () => {
    fireEvent.click(screen.getByText(name).closest('button') as HTMLElement);
  });
}

function clearRequests(fetchMock: jest.Mock): unknown[] {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/nickname/clear'));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the takedown is offered exactly where it can work', () => {
  it('is absent until the coach selects the athlete', async () => {
    await renderWorkspace();

    // The name is on screen from first paint -- the control is not. A roster of
    // twenty children each carrying a live "remove" control, inches from a
    // readiness dot on a gym tablet, is a mis-tap on a change with no undo.
    expect(screen.getByText('“Thunder”')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Remove ring name/ })).toBeNull();

    await selectAthlete('ath_mine');
    expect(
      screen.getByRole('button', { name: 'Remove ring name “Thunder” from Marisol Vance' }),
    ).not.toBeNull();
  });

  it('is absent for an athlete this coach is not the coach of record for', async () => {
    // The covering coach can READ this ring name -- it is rendered on the row
    // above -- and resolveRelationship still calls them 'organization_staff',
    // which the clear route refuses. Offering the button here would offer a
    // 404, and a coach who is told "not found" about a child in front of them
    // learns the wrong thing.
    await renderWorkspace();
    await selectAthlete('ath_covered');

    expect(screen.getByText('“Hammer”')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Remove ring name/ })).toBeNull();
  });

  it('is absent for an athlete with no ring name', async () => {
    await renderWorkspace();
    await selectAthlete('ath_plain');

    expect(screen.queryByRole('button', { name: /Remove ring name/ })).toBeNull();
  });

  it('is absent when the roster read failed, rather than being offered blind', async () => {
    // No faces means no account ids. A control that posts an undefined
    // account_id is a control that can only 400 -- and the roster read is
    // best-effort by design, so this is a state the screen really reaches.
    await renderWorkspace({ roster: () => jsonResponse({ ok: false }, { ok: false, status: 500 }) });
    await selectAthlete('ath_mine');

    expect(screen.queryByRole('button', { name: /Remove ring name/ })).toBeNull();
  });
});

describe('taking a ring name down', () => {
  it('asks before it acts, and the first click sends nothing', async () => {
    const fetchMock = await renderWorkspace();
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });

    // Armed, not fired. The sentence names the child, the string, and the lock
    // -- none of which a browser confirm() could say.
    expect(clearRequests(fetchMock)).toHaveLength(0);
    expect(screen.getByText(/Removing “Thunder” takes it off every screen now/)).not.toBeNull();
    expect(screen.getByText(/Marisol Vance cannot set a new ring name for 72 hours/)).not.toBeNull();
    expect(screen.getByText(/This cannot be undone/)).not.toBeNull();
  });

  it('sends the account id and takes the name off the row', async () => {
    const fetchMock = await renderWorkspace();
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    const [request] = clearRequests(fetchMock) as Array<[unknown, RequestInit]>;
    expect(request).toBeDefined();
    expect(request[1].method).toBe('POST');
    // The route takes an ACCOUNT id, not the athlete id the roster is keyed by.
    // Sending the wrong one is a 404 that reads exactly like a refusal.
    expect(JSON.parse(String(request[1].body))).toEqual({ account_id: 'acct_mine' });

    await waitFor(() => {
      expect(screen.queryByText('“Thunder”')).toBeNull();
    });
    // The other child's name is untouched: this is a per-row action and the
    // local update must not sweep the list.
    expect(screen.getByText('“Hammer”')).not.toBeNull();
  });

  it('says what happened after the control that offered it is gone', async () => {
    // Once the name is cleared the block that offered to clear it unmounts. A
    // coach who looked away would otherwise see a row that appears never to
    // have had a ring name at all.
    await renderWorkspace({ clear: () => jsonResponse({ ok: true, locked_for_hours: 72 }) });
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Ring name removed. Marisol Vance cannot set a new one for 72 hours.'),
      ).not.toBeNull();
    });
  });

  it('reports the lock the server stated, not the one the screen assumed', async () => {
    // NICKNAME_LOCK_HOURS is imported for the WARNING, which is a prediction
    // made before any request. The receipt is a record, and it reads the
    // response. A server that starts answering 48 must not be reported as 72.
    await renderWorkspace({ clear: () => jsonResponse({ ok: true, locked_for_hours: 48 }) });
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Ring name removed. Marisol Vance cannot set a new one for 48 hours.'),
      ).not.toBeNull();
    });
    expect(screen.queryByText(/for 72 hours\.$/)).toBeNull();
  });

  it('invents no duration when the response carried none', async () => {
    await renderWorkspace({ clear: () => jsonResponse({ ok: true }) });
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    await waitFor(() => {
      expect(
        screen.getByText("Ring name removed. Marisol Vance cannot set a new one until the gym's lock expires."),
      ).not.toBeNull();
    });
  });

  it('backs out with the name intact and sends nothing', async () => {
    const fetchMock = await renderWorkspace();
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    });

    expect(clearRequests(fetchMock)).toHaveLength(0);
    expect(screen.getByText('“Thunder”')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Remove ring name/ })).not.toBeNull();
  });
});

describe('a takedown that did not happen is never reported as one', () => {
  it('keeps the ring name on screen and shows the refusal', async () => {
    await renderWorkspace({
      clear: () => jsonResponse({ error: 'Not found' }, { ok: false, status: 404 }),
    });
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Not found')).not.toBeNull();
    });
    // The name is still there because it is still there. A row that clears
    // optimistically tells a coach the job is done when the server refused.
    expect(screen.getByText('“Thunder”')).not.toBeNull();
    expect(screen.queryByText(/Ring name removed/)).toBeNull();
  });

  it('says the name was NOT cleared when the request never landed', async () => {
    await renderWorkspace({
      clear: () => {
        throw new Error('offline');
      },
    });
    await selectAthlete('ath_mine');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove ring name/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });

    await waitFor(() => {
      expect(
        screen.getByText('Network error -- the ring name was NOT cleared. Please try again.'),
      ).not.toBeNull();
    });
    expect(screen.getByText('“Thunder”')).not.toBeNull();
  });
});
