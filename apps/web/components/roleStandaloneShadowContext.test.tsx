/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';

import RoleStandaloneView from './RoleStandaloneView';

/* AS-13 CS-16c: the page context SHADOW is handed is the page's door name, not
 * a web address. Where a page has no door it is the page's own heading
 * (roleLabel), OVERWATCH answer Q3 A on #2157. */

const router = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => router }));

jest.mock('./ShadowChatButton', () => ({
  __esModule: true,
  default: ({ context }: { context?: string }) => <span data-testid="shadow-context">{context}</span>,
}));

beforeEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: true, role: 'coach', auth_provider: 'microsoft' }),
  })) as unknown as typeof fetch;
});

test('a page with a door hands SHADOW the door name', async () => {
  render(
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/performance-analytics" allowedRoles={['coach']}>
      <p>body</p>
    </RoleStandaloneView>,
  );
  await waitFor(() => expect(screen.getByTestId('shadow-context')).toBeTruthy());
  expect(screen.getByTestId('shadow-context').textContent).toBe('Who to See First');
});

test('a page with no door hands SHADOW its own heading, never the address', async () => {
  render(
    <RoleStandaloneView roleLabel="Review Queue" routeLabel="/not/a/door" allowedRoles={['coach']}>
      <p>body</p>
    </RoleStandaloneView>,
  );
  await waitFor(() => expect(screen.getByTestId('shadow-context')).toBeTruthy());
  expect(screen.getByTestId('shadow-context').textContent).toBe('Review Queue');
});
