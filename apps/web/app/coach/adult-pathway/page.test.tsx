/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';

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

describe('/coach/adult-pathway', () => {
  it('shows the adults-only scope and the rough-estimate caveat', () => {
    render(<CoachAdultPathwayPage />);
    expect(screen.getByText(ADULT_PATHWAY_SCOPE)).toBeInTheDocument();
    expect(screen.getByText(ADULT_PATHWAY_CAVEAT)).toBeInTheDocument();
  });

  it('shows every stage in order with its range and every checkpoint', () => {
    render(<CoachAdultPathwayPage />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(ADULT_PATHWAY_STAGES.map((s) => s.name));

    const stageList = screen.getAllByRole('list')[0];
    const stageItems = within(stageList).getAllByRole('listitem').filter((li) => li.parentElement === stageList);
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
});
