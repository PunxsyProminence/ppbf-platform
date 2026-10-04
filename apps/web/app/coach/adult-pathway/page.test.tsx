/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';

import CoachAdultPathwayPage from './page';
import { ADULT_PATHWAY_CAVEAT, ADULT_PATHWAY_SCOPE, ADULT_PATHWAY_STAGES } from '@/src/shared/adultPathwayStages';

const gateRoles: string[][] = [];

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: React.ReactNode; readonly allowedRoles: string[] }) => {
    gateRoles.push(allowedRoles);
    return <>{children}</>;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: React.ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/AdultPathwayPanel', () => ({
  __esModule: true,
  default: ({ athleteId }: { athleteId: string }) => <div data-panel-for={athleteId} />,
}));

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Ana Adult' },
  { athlete_id: 'ath-2', full_name: 'Not Mine' },
];

function mockFetch(opts: { rosterOk?: boolean; allowed?: string[] } = {}) {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/pilot/athletes/list')) {
      return { ok: opts.rosterOk ?? true, json: async () => ({ items: ROSTER }) } as Response;
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body).toEqual({ action: 'accessible_athletes', athlete_ids: ['ath-1', 'ath-2'] });
    return { ok: true, json: async () => ({ athlete_ids: opts.allowed ?? ['ath-1'] }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => mockFetch());

describe('/coach/adult-pathway', () => {
  it('shows the adults-only scope and the rough-estimate caveat', () => {
    render(<CoachAdultPathwayPage />);
    expect(screen.getByText(ADULT_PATHWAY_SCOPE)).toBeInTheDocument();
    expect(screen.getByText(ADULT_PATHWAY_CAVEAT)).toBeInTheDocument();
  });

  it('shows every stage in order with its range and every checkpoint', () => {
    const { container } = render(<CoachAdultPathwayPage />);
    const ladder = container.querySelector('[data-pathway-ladder]') as HTMLElement;
    const headings = within(ladder).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(ADULT_PATHWAY_STAGES.map((s) => s.name));

    const stageItems = within(ladder).getAllByRole('listitem').filter((li) => li.parentElement === ladder);
    expect(stageItems).toHaveLength(ADULT_PATHWAY_STAGES.length);
    ADULT_PATHWAY_STAGES.forEach((stage, i) => {
      const item = within(stageItems[i]);
      expect(item.getByText(stage.typicalRange)).toBeInTheDocument();
      for (const goal of stage.goals) expect(item.getByText(goal.text)).toBeInTheDocument();
    });
  });

  it('is gated to coaches and admins only', () => {
    gateRoles.length = 0;
    render(<CoachAdultPathwayPage />);
    expect(gateRoles).toEqual([['coach', 'admin']]);
  });

  it('labels goals as coach-confirmed checkpoints, not automatic steps', () => {
    render(<CoachAdultPathwayPage />);
    expect(screen.getAllByText('Checkpoints a coach confirms')).toHaveLength(ADULT_PATHWAY_STAGES.length);
  });

  it('lists only the athletes the pathway route will open, each with a panel', async () => {
    const { container } = render(<CoachAdultPathwayPage />);
    await waitFor(() => expect(container.querySelector('[data-pathway-roster]')).not.toBeNull());
    expect(screen.getByText('Ana Adult')).toBeInTheDocument();
    expect(screen.queryByText('Not Mine')).toBeNull();
    expect(container.querySelector('[data-panel-for="ath-1"]')).not.toBeNull();
    expect(container.querySelector('[data-panel-for="ath-2"]')).toBeNull();
  });

  it('says a roster that failed to load failed, never "no athletes"', async () => {
    mockFetch({ rosterOk: false });
    render(<CoachAdultPathwayPage />);
    expect(await screen.findByText('Your roster could not be loaded. Reload to try again.')).toBeInTheDocument();
    expect(screen.queryByText('No athletes you can open.')).toBeNull();
  });
});
