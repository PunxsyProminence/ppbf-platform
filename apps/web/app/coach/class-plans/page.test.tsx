/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ClassPlansPage from './page';
import type { ClubRole } from '@/components/roleRoutes';
import { mapPilotRoleToClubRole } from '@/components/roleSession';

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
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));
jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

const SUMMARY = { track_id: 'trk_1', name: '8-Week Non-Contact Boxing Pilot Program', lane: 'standard', track: 'fitness', duration_weeks: 8, age_band: 'all ages', block_count: 8, day_count: 40 };
const DETAIL = {
  ...SUMMARY,
  sources: [],
  details: { primary_cue: 'Get set first.', daily_domain_order: ['Footwork', 'Defense'], domain_roles: { Footwork: 'Positional control' } },
  weeks: [{
    week: 1, block_order: 1, title: 'Week 1: Hold Position',
    days: [
      { block_session_id: 'tbs_1', ordinal: 1, day: 'Monday', template_lineage_id: 'wtp_1', template: { state: 'not_ready', template_id: 'wt-1', name: 'Footwork 1', drill_count: 4, drills_to_complete: 4 } },
      { block_session_id: 'tbs_2', ordinal: 2, day: 'Tuesday', template_lineage_id: 'wtp_2', template: { state: 'missing', template_id: null, name: null, drill_count: null, drills_to_complete: null } },
      { block_session_id: 'tbs_3', ordinal: 3, day: 'Wednesday', template_lineage_id: 'wtp_3', template: { state: 'withdrawn', template_id: 'wt-3', name: 'Old Day', drill_count: null, drills_to_complete: null } },
      { block_session_id: 'tbs_4', ordinal: 4, day: 'Thursday', template_lineage_id: 'wtp_4', template: { state: 'ready', template_id: 'wt-4', name: 'Ready Day', drill_count: 2, drills_to_complete: 0 } },
    ],
  }],
};

describe('Class plans page', () => {
  it('sits behind the coach and gym-admin gate, and an organization admin is the client role that gate admits', () => {
    global.fetch = jest.fn(async () => json({ tracks: [] })) as unknown as typeof fetch;
    render(<ClassPlansPage />);
    expect(capturedRoles.at(-1)).toEqual(['coach', 'admin']);
    // components/roleSession.ts mapPilotRoleToClubRole: organization_admin and admin both become 'admin'.
    expect(mapPilotRoleToClubRole('organization_admin')).toBe('admin');
    expect(capturedRoles.at(-1)).toContain(mapPilotRoleToClubRole('organization_admin') as ClubRole);
    expect(capturedRoles.at(-1)).not.toContain(mapPilotRoleToClubRole('platform_owner') as ClubRole);
  });

  it('lists the plans, opens one, and shows every day: readiness, missing and withdrawn included, with links to open templates', async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.includes('?track=') ? json({ track: DETAIL }) : json({ tracks: [SUMMARY] })) as unknown as typeof fetch;
    render(<ClassPlansPage />);
    expect(await screen.findByText('8-Week Non-Contact Boxing Pilot Program')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));

    expect(await screen.findByText('Week 1: Hold Position')).toBeInTheDocument();
    expect(screen.getByText('Not ready: 4 of 4 drills need completing')).toBeInTheDocument();
    expect(screen.getByText('Ready to issue')).toBeInTheDocument();
    expect(screen.getByText('Template missing')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Open template' }).map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      '/coach/workout-templates?template=wt-1',
      '/coach/workout-templates?template=wt-3',
      '/coach/workout-templates?template=wt-4',
    ]);
    // Detail fields read-only, as text.
    expect(screen.getByText('Get set first.')).toBeInTheDocument();
    expect(screen.getByText('Defense')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says a failed load is a failure, not an empty list; and says empty when empty', async () => {
    global.fetch = jest.fn(async () => json({}, false)) as unknown as typeof fetch;
    const { unmount } = render(<ClassPlansPage />);
    expect(await screen.findByText(/failure to load, not an empty list/)).toBeInTheDocument();
    unmount();
    global.fetch = jest.fn(async () => json({ tracks: [] })) as unknown as typeof fetch;
    render(<ClassPlansPage />);
    await waitFor(() => expect(screen.getByText(/No class plans are loaded/)).toBeInTheDocument());
  });
});
