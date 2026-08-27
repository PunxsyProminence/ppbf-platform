/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';

import RoleStandaloneView from './RoleStandaloneView';

/* The trail has two halves that can each be right while the pair is wrong.
 *
 * Law 6 gives this shell two grounds, and every style constant in it is a pair
 * -- BAND/BAND_INK, LINK/LINK_INK. A breadcrumb rung written against only one
 * of them still renders: it just renders brass-800 on leather at 2.45:1, which
 * looks like a styling choice in review and like nothing at all on the screen.
 * So the ground-specific colours are asserted on both branches rather than the
 * markup being checked once.
 *
 * The other half is the omitted prop. This shell wraps 68 routes and none of
 * them pass breadcrumbs today, so "renders exactly what it rendered before" is
 * the load-bearing case, not an edge one.
 */

/* ONE router object for the life of the file.
 *
 * RoleSessionGate's effect depends on [router], so a mock that builds a fresh
 * object on every render re-runs that effect on every render. That was survivable
 * while this shell rendered nothing that reacted to the session: the effect
 * settled because persisting the same session twice changed no state anybody
 * was watching.
 *
 * It stopped being survivable when the band began reading the viewer's role to
 * decide whether to offer Operations (2026-08-26): the shell now subscribes to
 * the role-session store, so persist -> notify -> render -> new router ->
 * persist is a closed loop, and the suite hangs with no output and no timeout
 * -- a synchronous spin, not a slow await. The same note is written at the top
 * of app/shadow/page.test.tsx, which learned it the same way.
 */
const router = { push: jest.fn(), replace: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
}));

// The chat launcher opens a socket the shell's own markup has nothing to do with.
jest.mock('./ShadowChatButton', () => ({
  __esModule: true,
  default: () => null,
}));

const session = { role: 'coach' };

beforeEach(() => {
  session.role = 'coach';
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      authenticated: true,
      role: session.role,
      auth_provider: 'microsoft',
    }),
  })) as unknown as typeof fetch;
});

async function trail(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByLabelText('Breadcrumb')).toBeTruthy());
  return screen.getByLabelText('Breadcrumb');
}

describe('RoleStandaloneView breadcrumbs', () => {
  it('renders no trail at all when the prop is omitted', async () => {
    render(
      <RoleStandaloneView roleLabel="Coach" routeLabel="/coach/review-queue" allowedRoles={['coach']}>
        <p>body</p>
      </RoleStandaloneView>,
    );

    await waitFor(() => expect(screen.getByText('Coach')).toBeTruthy());
    expect(screen.queryByLabelText('Breadcrumb')).toBeNull();
  });

  it('links every rung but the last, which is marked as the current page', async () => {
    render(
      <RoleStandaloneView
        roleLabel="Coach"
        routeLabel="/coach/video-analysis"
        allowedRoles={['coach']}
        breadcrumbs={[
          { label: 'Coach', href: '/coach' },
          { label: 'Review Queue', href: '/coach/review-queue' },
          { label: 'Video Analysis', href: '/coach/video-analysis' },
        ]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    const nav = await trail();
    expect(nav.querySelector('ol')).not.toBeNull();

    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(2);
    expect(links[1].getAttribute('href')).toBe('/coach/review-queue');

    // Last rung: not a link even though it was handed an href -- a link to the
    // page you are on is a control that does nothing.
    const current = nav.querySelector('[aria-current="page"]');
    expect(current?.tagName).toBe('SPAN');
    expect(current?.textContent).toBe('Video Analysis');
  });

  it('hides the separators from the reader', async () => {
    render(
      <RoleStandaloneView
        roleLabel="Coach"
        routeLabel="/coach/video-analysis"
        allowedRoles={['coach']}
        breadcrumbs={[
          { label: 'Coach', href: '/coach' },
          { label: 'Review Queue', href: '/coach/review-queue' },
          { label: 'Video Analysis' },
        ]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    // Three rungs, two rules between them, none of them announced -- otherwise
    // the trail reads as "Coach slash Review Queue slash Video Analysis".
    const separators = (await trail()).querySelectorAll('[aria-hidden="true"]');
    expect(separators.length).toBe(2);
  });

  it('prints a rung with no href as text rather than as a dead link', async () => {
    render(
      <RoleStandaloneView
        roleLabel="Coach"
        routeLabel="/coach/video-analysis"
        allowedRoles={['coach']}
        breadcrumbs={[
          { label: 'Coach', href: '/coach' },
          // A grouping, not a route: /coach/review does not exist.
          { label: 'Review' },
          { label: 'Video Analysis' },
        ]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    const nav = await trail();
    expect(nav.querySelectorAll('a').length).toBe(1);
    expect(nav.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });

  it('takes the ink half of every colour pair on a staff surface', async () => {
    render(
      <RoleStandaloneView
        roleLabel="Coach"
        routeLabel="/coach/video-analysis"
        allowedRoles={['coach']}
        breadcrumbs={[{ label: 'Coach', href: '/coach' }, { label: 'Video Analysis' }]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    const nav = await trail();
    const link = nav.querySelector('a') as HTMLElement;
    const separator = nav.querySelector('[aria-hidden="true"]') as HTMLElement;
    const current = nav.querySelector('[aria-current="page"]') as HTMLElement;

    // brass-300 is 10.4:1 on leather; brass-800, the canvas rung, is 2.45:1.
    expect(link.className).toContain('text-[color:var(--brass-300)]');
    expect(separator.className).toContain('text-[color:var(--brass-400)]');
    expect(current.className).toContain('text-[color:var(--bone-300)]');
    // The tap floor this band already holds every other link to.
    expect(link.className).toContain('min-h-[var(--tap)]');
  });

  it('takes the canvas half on the family ground', async () => {
    session.role = 'parent';
    render(
      <RoleStandaloneView
        roleLabel="Parent Hub"
        routeLabel="/parent/progression-visibility"
        allowedRoles={['parent']}
        breadcrumbs={[{ label: 'Parent Hub', href: '/parent' }, { label: 'Progression' }]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    const nav = await trail();
    const link = nav.querySelector('a') as HTMLElement;
    const separator = nav.querySelector('[aria-hidden="true"]') as HTMLElement;
    const current = nav.querySelector('[aria-current="page"]') as HTMLElement;

    expect(link.className).toContain('text-[color:var(--brass-800)]');
    expect(separator.className).toContain('text-[color:var(--brass-700)]');
    expect(current.className).toContain('text-[color:var(--hide-800)]');
  });

  it('carries the trail with the band when the shell header is suppressed', async () => {
    // showShellHeader={false} is what the parent routes pass. The trail lives
    // in the band, so it goes with it -- a breadcrumb floating above a page
    // with no header is not a path back to anything.
    render(
      <RoleStandaloneView
        roleLabel="Coach"
        routeLabel="/coach/video-analysis"
        allowedRoles={['coach']}
        showShellHeader={false}
        breadcrumbs={[{ label: 'Coach', href: '/coach' }, { label: 'Video Analysis' }]}
      >
        <p>body</p>
      </RoleStandaloneView>,
    );

    await waitFor(() => expect(screen.getByText('body')).toBeTruthy());
    expect(screen.queryByLabelText('Breadcrumb')).toBeNull();
  });
});
