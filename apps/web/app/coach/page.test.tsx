import { redirect } from 'next/navigation';

import CoachHomeRedirectPage from './page';
import CoachDashboardRedirectPage from './dashboard/page';
import CoachIntakeRouterPage from './environment/intake-router/page';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

jest.mock('next/navigation', () => ({ redirect: jest.fn() }));
// The home page is only imported to prove the redirect lands on a real page.
jest.mock('@/components/CoachWorkspace', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/RoleStandaloneView', () => ({ __esModule: true, default: () => null }));

// #1482 item 6: /coach was a 404. It sends a coach to their home, read from
// the same table sign-in routes by.
test('/coach redirects to the coach home', () => {
  CoachHomeRedirectPage();
  expect(redirect).toHaveBeenCalledWith('/coach/environment/intake-router');
  expect(getPilotRoleDestination('coach')).toBe('/coach/environment/intake-router');
  expect(typeof CoachIntakeRouterPage).toBe('function');
});

test('/coach/dashboard redirects to the coach home too', () => {
  (redirect as unknown as jest.Mock).mockClear();
  CoachDashboardRedirectPage();
  expect(redirect).toHaveBeenCalledWith('/coach/environment/intake-router');
});
