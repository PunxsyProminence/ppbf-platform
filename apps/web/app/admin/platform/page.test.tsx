/**
 * @jest-environment jsdom
 */

// Closing a gym is the most consequential thing on this desk and there is no
// delete behind it -- this control IS what people go looking for a delete to
// do. Every assertion here is one of the four things that made it safe to
// name it in the owner's words:
//
//   1. the POST does not fire until somebody confirms;
//   2. the session revocation is stated BEFORE the click, not only after it;
//   3. the copy says plainly that closing is not a deletion;
//   4. `pending` and `suspended` are still reachable.
//
// The server side is untouched by that work and is not exercised here: the
// route is platform_owner-only via requireRole and writes its own audit event,
// and this page is a UI affordance over machinery that was already correct.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import PlatformConsole from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;
const originalFetch = global.fetch;

const OWNER: PilotSessionState = {
  role: 'platform_owner',
  organizationId: 'ppbf',
  authProvider: 'microsoft',
  accountId: 'owner@punxsyprominence.org',
  mustChangePin: false,
  loading: false,
};

const GYMS = [
  { organization_id: 'org-punxsy', organization_name: 'Punxsy Prominence', status: 'active' },
  { organization_id: 'org-second', organization_name: 'Second Street Boxing', status: 'pending' },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Every GET this page makes on load, plus a recording POST spy. */
function mountDesk() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: target, body: JSON.parse(String(init.body ?? '{}')) });
      const sent = JSON.parse(String(init.body ?? '{}'));
      return jsonResponse({ ok: true, ...sent });
    }
    if (target.includes('/api/pilot/platform/organizations')) {
      return jsonResponse({ organizations: GYMS });
    }
    return jsonResponse({ ok: true });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  const view = render(<PlatformConsole />);
  return { posts, fetchMock, view };
}

/** The desk does nothing until a gym is chosen, so every test starts here. */
async function chooseGym(name = 'Punxsy Prominence') {
  const option = GYMS.find((gym) => gym.organization_name === name);
  // Wait for the roster fetch, not just for the label: changing a <select> to
  // a value it does not yet carry an <option> for silently leaves it on ''.
  await screen.findByRole('option', { name: new RegExp(name, 'i') });
  fireEvent.change(screen.getByLabelText(/choose a gym/i), { target: { value: option?.organization_id } });
  // Let the gym-summary effect settle inside act() before the test asserts,
  // so its state update is not reported as an un-acted-on one.
  await waitFor(() => expect(screen.queryByText(/Loading summary/i)).toBeNull());
  return option;
}

function statusPosts(posts: { url: string; body: Record<string, unknown> }[]) {
  return posts.filter((post) => post.url.includes('/api/pilot/platform/organizations/status'));
}

beforeEach(() => {
  mockUsePilotSession.mockReturnValue(OWNER);
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('closing a gym is a named action', () => {
  test('the desk names the job in the owner’s words, not as a status field', async () => {
    mountDesk();
    await chooseGym();

    expect(screen.getByRole('heading', { name: 'Close A Gym' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close This Gym' })).toBeInTheDocument();

    // The generic status list this replaced. If "Set inactive" ever comes
    // back, closing a gym has gone back to being a value in a dropdown.
    expect(screen.queryByRole('button', { name: /^Set (active|inactive|suspended|pending)$/i })).toBeNull();
  });

  test('the current standing carries a glyph and an uppercase label, not just a colour', async () => {
    const { view } = mountDesk();
    await chooseGym();

    const badge = view.container.querySelector('.badge');
    expect(badge).toBeTruthy();
    // Law 3: colour is never the only channel.
    expect(badge?.querySelector('i')).toBeTruthy();
    expect(badge?.textContent).toContain('open');
    expect(badge && getComputedStyle(badge)).toBeTruthy();
    expect(badge?.className).toContain('badge--cleared');
  });
});

describe('the warning comes before the action, not after it', () => {
  test('session revocation is on screen before anything is clicked', async () => {
    mountDesk();
    await chooseGym();

    // Present with no click at all -- this is the whole point. The old page
    // only ever said this in the success message, after the sessions were
    // already gone.
    const form = screen.getByText(/Everyone is signed out\./i).closest('li');
    expect(form).toBeTruthy();
    expect(form?.textContent).toMatch(/Every session scoped to this gym is revoked/i);
    expect(form?.textContent).toMatch(/nobody can sign back in while it is closed/i);
  });

  test('the copy says plainly that closing is not a deletion', async () => {
    mountDesk();
    await chooseGym();

    const notADelete = screen.getByText(/Nothing is deleted\./i).closest('li');
    expect(notADelete).toBeTruthy();
    expect(notADelete?.textContent).toMatch(/Closing is not a delete/i);
    expect(notADelete?.textContent).toMatch(/there is no delete on this desk/i);
    expect(notADelete?.textContent).toMatch(/stay exactly where they are/i);
  });

  test('the copy says closing is reversible, before it is done', async () => {
    mountDesk();
    await chooseGym();

    const reversible = screen.getByText(/You can open it again\./i).closest('li');
    expect(reversible).toBeTruthy();
    expect(reversible?.textContent).toMatch(/Set the gym open whenever you want it back/i);
  });
});

describe('a deliberate confirmation is required', () => {
  test('pressing Close This Gym asks first and posts nothing', async () => {
    const { posts } = mountDesk();
    await chooseGym();

    fireEvent.click(screen.getByRole('button', { name: 'Close This Gym' }));

    const slip = await screen.findByRole('alertdialog');
    expect(within(slip).getByText('Close Punxsy Prominence?')).toBeInTheDocument();
    // Nothing has been written. The click armed the confirmation, it did not
    // take a gym offline.
    expect(statusPosts(posts)).toHaveLength(0);
  });

  test('the confirmation restates all three facts', async () => {
    mountDesk();
    await chooseGym();
    fireEvent.click(screen.getByRole('button', { name: 'Close This Gym' }));

    const slip = await screen.findByRole('alertdialog');
    expect(slip.textContent).toMatch(/not a delete/i);
    expect(slip.textContent).toMatch(/Every session scoped to this gym is revoked/i);
    expect(slip.textContent).toMatch(/No records are deleted/i);
    expect(slip.textContent).toMatch(/Reversible/i);
  });

  test('backing out of the confirmation posts nothing', async () => {
    const { posts } = mountDesk();
    await chooseGym();
    fireEvent.click(screen.getByRole('button', { name: 'Close This Gym' }));

    const slip = await screen.findByRole('alertdialog');
    fireEvent.click(within(slip).getByRole('button', { name: /KEEP IT AS IT IS/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(statusPosts(posts)).toHaveLength(0);
  });

  test('confirming posts inactive to the existing status route, once', async () => {
    const { posts } = mountDesk();
    await chooseGym();
    fireEvent.click(screen.getByRole('button', { name: 'Close This Gym' }));

    const slip = await screen.findByRole('alertdialog');
    fireEvent.click(within(slip).getByRole('button', { name: /YES, CLOSE THIS GYM/i }));

    await waitFor(() => expect(statusPosts(posts)).toHaveLength(1));
    expect(statusPosts(posts)[0].body).toEqual({ organization_id: 'org-punxsy', status: 'inactive' });
    // Same route, same shape. This ticket added no API surface.
    expect(statusPosts(posts)[0].url).toContain('/api/pilot/platform/organizations/status');
  });

  test('the done message still says what happened, and still says nothing was deleted', async () => {
    mountDesk();
    await chooseGym();
    fireEvent.click(screen.getByRole('button', { name: 'Close This Gym' }));
    const slip = await screen.findByRole('alertdialog');
    fireEvent.click(within(slip).getByRole('button', { name: /YES, CLOSE THIS GYM/i }));

    const done = await screen.findByText(/Punxsy Prominence is closed\./i);
    expect(done.textContent).toMatch(/signed out/i);
    expect(done.textContent).toMatch(/Nothing was deleted/i);
  });
});

describe('nothing was taken away', () => {
  test('suspended is still reachable, through the same confirmation', async () => {
    const { posts } = mountDesk();
    await chooseGym();

    fireEvent.click(screen.getByRole('button', { name: 'Put This Gym On Hold' }));
    const slip = await screen.findByRole('alertdialog');
    expect(statusPosts(posts)).toHaveLength(0);
    fireEvent.click(within(slip).getByRole('button', { name: /YES, PUT IT ON HOLD/i }));

    await waitFor(() => expect(statusPosts(posts)).toHaveLength(1));
    expect(statusPosts(posts)[0].body).toEqual({ organization_id: 'org-punxsy', status: 'suspended' });
  });

  test('pending is still reachable, through the same confirmation', async () => {
    const { posts } = mountDesk();
    await chooseGym();

    fireEvent.click(screen.getByRole('button', { name: 'Mark Not Open Yet' }));
    const slip = await screen.findByRole('alertdialog');
    expect(statusPosts(posts)).toHaveLength(0);
    fireEvent.click(within(slip).getByRole('button', { name: /YES, MARK IT NOT OPEN YET/i }));

    await waitFor(() => expect(statusPosts(posts)).toHaveLength(1));
    expect(statusPosts(posts)[0].body).toEqual({ organization_id: 'org-punxsy', status: 'pending' });
  });

  test('opening a gym is the way back and is not gated behind a confirmation', async () => {
    const { posts } = mountDesk();
    await chooseGym('Second Street Boxing');

    fireEvent.click(screen.getByRole('button', { name: 'Open This Gym' }));

    await waitFor(() => expect(statusPosts(posts)).toHaveLength(1));
    expect(statusPosts(posts)[0].body).toEqual({ organization_id: 'org-second', status: 'active' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('every standing the route accepts is named on the desk', async () => {
    mountDesk();
    await chooseGym();

    // The four values setOrganizationStatus and the status route accept. If a
    // standing stops being reachable from this page, it stops being listed.
    for (const status of ['active', 'inactive', 'suspended', 'pending']) {
      expect(screen.getByText(status, { selector: '.t-data' })).toBeInTheDocument();
    }
  });
});

describe('room DNA -- Front Office', () => {
  test('the page paints the office wall and nothing paints over it', async () => {
    const { view } = mountDesk();
    await chooseGym();

    // #498: the base .room class is required. --plate is declared by the
    // modifier but consumed by .room::after, and the light is .room::before,
    // so a modifier-only page gets neither.
    const room = view.container.querySelector('main');
    expect(room?.className).toContain('room');
    expect(room?.className).toContain('room--office');

    // A child full-viewport background wins over the unlayered wall, because
    // ppbf.css is unlayered and Tailwind's utilities sit in @layer utilities.
    const painters = Array.from(view.container.querySelectorAll('*')).filter(
      (node) => node !== room
        && node.className
        && typeof node.className === 'string'
        && node.className.includes('min-h-screen')
        && /bg-\[/.test(node.className),
    );
    expect(painters).toEqual([]);
  });

  test('the buttons on the paper form are levers, not ghosts', async () => {
    mountDesk();
    await chooseGym();

    // ppbf.css documents ghost-on-light as grey-on-grey.
    const close = screen.getByRole('button', { name: 'Close This Gym' });
    expect(close.className).toContain('btn--lever');
    expect(close.className).not.toContain('btn--ghost');
    expect(close.closest('.mat-paper')).toBeTruthy();
  });
});
