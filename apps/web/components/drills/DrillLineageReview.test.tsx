/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import DrillLineageReview from './DrillLineageReview';
import type { DrillLineageResponse } from '@/app/api/pilot/drills/lineage/route';
import type { DrillChangeProposalListResponse } from '@/app/api/pilot/drills/proposals/route';
import type { DrillChangeProposalReviewResponse } from '@/app/api/pilot/drills/proposals/review/route';
import type { DrillChangeProposalListing, PilotDrillVersionRow } from '@/src/server/pilot/drillVersioning';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

// Account ids are on every proposal row the route sends. None may reach the screen.
const PROPOSER = 'acct-secret-proposer';
const REVIEWER = 'acct-secret-reviewer';

function version(n: number, overrides: Partial<PilotDrillVersionRow> = {}): PilotDrillVersionRow {
  return {
    organization_id: 'org-1',
    drill_id: `jab-${n}`,
    name: 'Jab return',
    category: 'Striking',
    focus: `Focus as of version ${n}.`,
    cues: [`Cue ${n}`],
    difficulty: 'beginner',
    active: false,
    version: n,
    lineage_id: 'jab-1',
    supersedes_drill_id: n > 1 ? `jab-${n - 1}` : null,
    superseded_at: null,
    superseded_by_drill_id: null,
    reference_drill_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function proposal(id: string, overrides: Partial<DrillChangeProposalListing>): DrillChangeProposalListing {
  return {
    proposal_id: id,
    organization_id: 'org-1',
    lineage_id: 'jab-1',
    based_on_drill_id: 'jab-2',
    proposed_by_account_id: PROPOSER,
    proposed_by_role: 'coach',
    rationale: `Rationale ${id}.`,
    proposed_change: { name: 'Jab snap' },
    observation_note_ids: [],
    review_state: 'proposed',
    reviewed_by_account_id: null,
    reviewed_at: null,
    review_note: null,
    resulting_drill_id: null,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
    current_drill_id: 'jab-2',
    base_is_current: true,
    lineage_retired: false,
    ...overrides,
  };
}

const adoptedEarlier = proposal('p-adopted', {
  based_on_drill_id: 'jab-1',
  proposed_change: { cues: ['Cue 2'] },
  review_state: 'adopted',
  reviewed_by_account_id: REVIEWER,
  reviewed_at: '2026-10-02T09:00:00.000Z',
  review_note: 'Good catch.',
  resulting_drill_id: 'jab-2',
});
// Written against v1 while the drill is at v2: an adopt would be refused.
const stale = proposal('p-stale', {
  based_on_drill_id: 'jab-1',
  proposed_change: { focus: 'Return, then reset.' },
  base_is_current: false,
});
const onCurrent = proposal('p-current', {});

interface Server {
  versions: PilotDrillVersionRow[];
  items: DrillChangeProposalListing[];
  review?: (body: { proposal_id: string; action: string; review_note?: string }) => Response;
  reinstate?: (body: { drill_id: string; reinstate: boolean }) => Response;
}

function json(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status < 400, status, json: async () => JSON.parse(text) as unknown } as Response;
}

function serve(server: Server) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/pilot/drills/lineage?drill_id=')) {
      const body: DrillLineageResponse = { ok: true, organization_id: 'org-1', lineage_id: 'jab-1', versions: server.versions };
      return json(body);
    }
    if (url === '/api/pilot/drills/proposals?lineage_id=jab-1') {
      const body: DrillChangeProposalListResponse = { ok: true, organization_id: 'org-1', items: server.items };
      return json(body);
    }
    if (url === '/api/pilot/drills/proposals/review' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { proposal_id: string; action: string; review_note?: string };
      if (server.review) return server.review(body);
    }
    if (url === '/api/pilot/drills' && init?.method === 'PATCH' && server.reinstate) {
      return server.reinstate(JSON.parse(String(init.body)) as { drill_id: string; reinstate: boolean });
    }
    return json({ error: 'unexpected' }, 500);
  });
}

function reads(fetchMock: ReturnType<typeof serve>, prefix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length;
}

function proposalItem(rationale: string) {
  return screen.getByText(rationale).closest('li') as HTMLElement;
}

const twoVersions = () => [version(1), version(2, { active: true, focus: 'Focus as of version 2.' })];

async function renderPanel(server: Server, canReview = true, canReinstate = false) {
  const fetchMock = serve(server);
  global.fetch = fetchMock as unknown as typeof fetch;
  const onChanged = jest.fn();
  render(<DrillLineageReview drillId="jab-2" canReview={canReview} canReinstate={canReinstate} onClose={() => {}} onChanged={onChanged} />);
  // Versions and proposals are set together, so the versions list means both are in.
  await screen.findByRole('list', { name: 'Versions, oldest first' });
  return { fetchMock, onChanged };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('DrillLineageReview', () => {
  test('renders every version oldest first, with the active one marked Current, and opens each one', async () => {
    await renderPanel({ versions: twoVersions(), items: [] });

    const items = within(screen.getByRole('list', { name: 'Versions, oldest first' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Version 1: Jab return'),
      expect.stringContaining('Version 2: Jab return'),
    ]);
    expect(items[0]).toHaveTextContent('Earlier version');
    expect(items[1]).toHaveTextContent('Current');

    const toggle = within(items[0]).getByRole('button', { name: 'Show version 1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(items[0]).toHaveTextContent('Focus as of version 1.');
    expect(items[0]).toHaveTextContent('Cue 1');
  });

  test('Was / Proposed compares against the version the proposal was written against, not the head', async () => {
    await renderPanel({ versions: twoVersions(), items: [stale] });

    const row = within(proposalItem('Rationale p-stale.')).getByRole('row', { name: /What it is for/ });
    expect(row).toHaveTextContent('Focus as of version 1.');
    expect(row).not.toHaveTextContent('Focus as of version 2.');
    expect(row).toHaveTextContent('Return, then reset.');
  });

  test('a stale proposal offers no Adopt, says why, and can still be declined', async () => {
    const server: Server = {
      versions: twoVersions(),
      items: [stale],
      review: (body) => {
        server.items = [{ ...stale, review_state: 'declined', review_note: body.review_note ?? null, reviewed_at: '2026-10-04T12:00:00.000Z' }];
        const answer: DrillChangeProposalReviewResponse = { ok: true, organization_id: 'org-1', proposal: server.items[0] };
        return json(answer);
      },
    };
    const { fetchMock, onChanged } = await renderPanel(server);

    const item = proposalItem('Rationale p-stale.');
    expect(item).toHaveTextContent('Written against version 1. The drill is now at version 2.');
    expect(within(item).queryByRole('button', { name: /^Adopt the proposal/ })).not.toBeInTheDocument();

    fireEvent.change(within(item).getByLabelText('Review note'), { target: { value: 'Please re-propose against v2.' } });
    fireEvent.click(within(item).getByRole('button', { name: /^Decline the proposal/ }));

    expect(await screen.findByText('Declined on 2026-10-04.')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => String(url) === '/api/pilot/drills/proposals/review');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      proposal_id: 'p-stale',
      action: 'decline',
      review_note: 'Please re-propose against v2.',
    });
    expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
    expect(onChanged).toHaveBeenCalled();
  });

  test('a retired drill offers no Adopt and says it is retired', async () => {
    await renderPanel({
      versions: [version(1), version(2)],
      items: [{ ...onCurrent, lineage_retired: true }],
    });

    const item = proposalItem('Rationale p-current.');
    expect(item).toHaveTextContent('This drill is retired.');
    expect(within(item).queryByRole('button', { name: /^Adopt the proposal/ })).not.toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /^Decline the proposal/ })).toBeInTheDocument();
    const versions = within(screen.getByRole('list', { name: 'Versions, oldest first' })).getAllByRole('listitem');
    expect(versions[1]).toHaveTextContent('Retired');
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
  });

  test('an adopt that succeeds reads the panel again and shows the version it became', async () => {
    const server: Server = {
      versions: twoVersions(),
      items: [onCurrent],
      review: () => {
        const v3 = version(3, { active: true, name: 'Jab snap' });
        server.versions = [version(1), version(2), v3];
        server.items = [{ ...onCurrent, review_state: 'adopted', resulting_drill_id: 'jab-3', // 00:00 UTC on the 5th is the evening of the 4th at the gym, and is dated that way.
        reviewed_at: '2026-10-05T00:00:00.000Z', current_drill_id: 'jab-3' }];
        const answer: DrillChangeProposalReviewResponse = { ok: true, organization_id: 'org-1', proposal: server.items[0], drill: v3 };
        return json(answer);
      },
    };
    const { fetchMock } = await renderPanel(server);

    fireEvent.click(within(proposalItem('Rationale p-current.')).getByRole('button', { name: /^Adopt the proposal/ }));

    expect(await screen.findByText('Adopted on 2026-10-04. Became version 3.')).toBeInTheDocument();
    expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
    expect(within(proposalItem('Rationale p-current.')).queryByRole('button', { name: /^Adopt the proposal/ })).not.toBeInTheDocument();
  });

  test("a 409 shows the server's own wording and reads the panel again", async () => {
    const { fetchMock } = await renderPanel({
      versions: twoVersions(),
      items: [onCurrent],
      review: () => json({ error: 'DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION' }, 409),
    });

    fireEvent.click(within(proposalItem('Rationale p-current.')).getByRole('button', { name: /^Adopt the proposal/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
    expect(alert).toHaveTextContent("Nothing was changed. This drill's versions and proposals were read again.");
    expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
  });

  test('a fault after the request left says the outcome is not known, and reads the panel again', async () => {
    const { fetchMock } = await renderPanel({
      versions: twoVersions(),
      items: [onCurrent],
      review: () => json({ error: 'Internal error' }, 500),
    });

    fireEvent.click(within(proposalItem('Rationale p-current.')).getByRole('button', { name: /^Adopt the proposal/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("It is not known whether this was saved. This drill's versions and proposals were read again");
    expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
  });

  test('Adopt and Decline name the proposal they act on', async () => {
    await renderPanel({ versions: twoVersions(), items: [onCurrent] });
    const item = proposalItem('Rationale p-current.');
    expect(within(item).getByRole('button', { name: 'Adopt the proposal from 2026-10-03 against version 2' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Decline the proposal from 2026-10-03 against version 2' })).toBeInTheDocument();
  });

  test('a coach reads the same history and proposals without Adopt or Decline', async () => {
    await renderPanel({ versions: twoVersions(), items: [onCurrent] }, false);
    expect(proposalItem('Rationale p-current.')).toHaveTextContent('Waiting for review');
    expect(screen.queryByRole('button', { name: /^Adopt the proposal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Decline the proposal/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Review note')).not.toBeInTheDocument();
  });

  test('a reviewer is offered Adopt and Decline on a proposal written against the current version', async () => {
    await renderPanel({ versions: twoVersions(), items: [onCurrent] }, true);
    const item = proposalItem('Rationale p-current.');
    expect(within(item).getByRole('button', { name: /^Adopt the proposal/ })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /^Decline the proposal/ })).toBeInTheDocument();
  });

  test('names the proposer and reviewer by role and date, never by account id', async () => {
    await renderPanel({ versions: twoVersions(), items: [adoptedEarlier, stale, onCurrent] });

    const adopted = proposalItem('Rationale p-adopted.');
    expect(adopted).toHaveTextContent('Proposed by Coach on 2026-10-03, against version 1');
    expect(adopted).toHaveTextContent('Adopted on 2026-10-02. Became version 2.');
    expect(adopted).toHaveTextContent('Review note: Good catch.');
    expect(document.body.textContent).not.toContain(PROPOSER);
    expect(document.body.textContent).not.toContain(REVIEWER);
    await waitFor(() => expect(document.body.innerHTML).not.toContain('acct-secret'));
  });

  describe('Reinstate', () => {
    const threeVersions = () => [version(1), version(2), version(3, { active: true })];

    function versionItems() {
      return within(screen.getByRole('list', { name: 'Versions, oldest first' })).getAllByRole('listitem');
    }

    test('is offered on each earlier version, never on the current one', async () => {
      await renderPanel({ versions: threeVersions(), items: [] }, false, true);
      const items = versionItems();
      expect(within(items[0]).getByRole('button', { name: 'Reinstate version 1' })).toHaveTextContent('Reinstate version 1');
      expect(within(items[1]).getByRole('button', { name: 'Reinstate version 2' })).toBeInTheDocument();
      expect(within(items[2]).queryByRole('button', { name: /^Reinstate/ })).not.toBeInTheDocument();
    });

    test('is not offered on a retired drill', async () => {
      await renderPanel({ versions: [version(1), version(2)], items: [] }, true, true);
      expect(screen.queryByRole('button', { name: /^Reinstate/ })).not.toBeInTheDocument();
    });

    test('is not offered to a role the route does not admit', async () => {
      await renderPanel({ versions: threeVersions(), items: [] }, true, false);
      expect(screen.queryByRole('button', { name: /^Reinstate/ })).not.toBeInTheDocument();
    });

    test('sends that version, reads the panel again and tells the page', async () => {
      const server: Server = {
        versions: threeVersions(),
        items: [],
        reinstate: () => {
          server.versions = [version(1), version(2), version(3), version(4, { active: true })];
          return json({ ok: true, organization_id: 'org-1', drill: server.versions[3], reinstated_from_drill_id: 'jab-1', previous_drill_id: 'jab-3' });
        },
      };
      const { fetchMock, onChanged } = await renderPanel(server, false, true);

      const button = within(versionItems()[0]).getByRole('button', { name: 'Reinstate version 1' });
      fireEvent.click(button);
      expect(button).toBeDisabled();
      expect(within(versionItems()[1]).getByRole('button', { name: 'Reinstate version 2' })).toBeDisabled();

      // The reinstate writes a NEW latest version, so the notice names it (here version 4).
      expect(await screen.findByText("Reinstated version 1 as version 4, now the drill's current version.")).toHaveAttribute('role', 'status');
      const patches = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patches.map(([url, init]) => [String(url), JSON.parse(String((init as RequestInit).body))])).toEqual([
        ['/api/pilot/drills', { drill_id: 'jab-1', reinstate: true }],
      ]);
      expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(versionItems()).toHaveLength(4);
      expect(within(versionItems()[3]).queryByRole('button', { name: /^Reinstate/ })).not.toBeInTheDocument();
      expect(within(versionItems()[2]).getByRole('button', { name: 'Reinstate version 3' })).toBeEnabled();
    });

    test("a 409 shows the server's own wording and reads the panel again", async () => {
      const { fetchMock } = await renderPanel({
        versions: threeVersions(),
        items: [],
        reinstate: () => json({ error: 'This drill already has a newer version. Reload and try again.', code: 'DRILL_VERSION_CONFLICT' }, 409),
      }, false, true);

      fireEvent.click(screen.getByRole('button', { name: 'Reinstate version 2' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('This drill already has a newer version. Reload and try again.');
      expect(alert).toHaveTextContent("Nothing was changed. This drill's versions and proposals were read again.");
      expect(versionItems()[1]).toContainElement(alert);
      expect(reads(fetchMock, '/api/pilot/drills/lineage')).toBe(2);
    });

    test('a fault says the outcome is not known', async () => {
      await renderPanel({ versions: threeVersions(), items: [], reinstate: () => json({ error: 'Internal error' }, 500) }, false, true);

      fireEvent.click(screen.getByRole('button', { name: 'Reinstate version 1' }));

      expect(await screen.findByRole('alert')).toHaveTextContent("It is not known whether this was saved. This drill's versions and proposals were read again");
    });
  });
});
