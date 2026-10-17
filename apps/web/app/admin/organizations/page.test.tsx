/**
 * @jest-environment jsdom
 */

// F-094: each step of the onboarding wizard wrote at one press. Creating a
// gym and making someone its admin now arm on the first press, and the armed
// button names the gym before the second press sends anything -- the Cancel
// Class pattern, as on the platform desk (F-084). Lane L31 took the feature
// step out: it saved checkboxes no feature reads (Overwatch Q2 A).

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SetupWizard from './page';
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

const EXISTING_GYMS = [{ organization_id: 'punxsy_prominence', organization_name: 'Punxsy Prominence' }];

/** The gym-list GET answers with EXISTING_GYMS; every POST is recorded. */
async function mountWizard() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, organizations: EXISTING_GYMS }) } as Response;
    }
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
  // Let the gym-list GET settle inside act(), so its state update is not
  // reported as an un-acted-on one.
  await act(async () => {
    render(<SetupWizard />);
  });
  return { posts };
}

function fillGym() {
  fireEvent.change(screen.getByPlaceholderText('golden_boxing'), { target: { value: 'golden_boxing' } });
  fireEvent.change(screen.getByPlaceholderText('Golden Boxing Studio'), { target: { value: 'Golden Boxing Studio' } });
}

async function finishStep1() {
  fillGym();
  fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));
  fireEvent.click(screen.getByRole('button', { name: /^Press again: save/ }));
  await screen.findByRole('button', { name: 'Add Gym Admin & Finish' });
}

async function finishStep2() {
  fireEvent.change(screen.getByPlaceholderText('owner@goldenboxing.org'), { target: { value: 'owner@golden.org' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Gym Admin & Finish' }));
  fireEvent.click(screen.getByRole('button', { name: /^Press again: make/ }));
  await screen.findByText('Gym Setup Complete!');
}

beforeEach(() => {
  mockUsePilotSession.mockReturnValue(OWNER);
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('F-094: no onboarding write without the gym named at the press', () => {
  test('creating a gym: the first press sends nothing and names the gym', async () => {
    const { posts } = await mountWizard();
    fillGym();

    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));

    expect(screen.getByRole('button', { name: 'Press again: save Golden Boxing Studio (golden_boxing)' })).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  test('an id that is already taken is refused at the first press, naming the gym that holds it', async () => {
    const { posts } = await mountWizard();
    fireEvent.change(screen.getByPlaceholderText('golden_boxing'), { target: { value: 'punxsy_prominence' } });
    fireEvent.change(screen.getByPlaceholderText('Golden Boxing Studio'), { target: { value: 'New Name' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));

    expect(screen.getByText(/A gym with the id punxsy_prominence already exists \(Punxsy Prominence\)\. Nothing was changed\. For a new gym, choose another id; to add this gym's admin, use the Platform Desk\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Press again/ })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  test('creating a gym: the second press creates that gym, once', async () => {
    const { posts } = await mountWizard();
    await finishStep1();

    expect(posts).toEqual([
      {
        url: expect.stringMatching(/\/api\/pilot\/platform\/organizations$/),
        body: { organization_id: 'golden_boxing', organization_name: 'Golden Boxing Studio' },
      },
    ]);
  });

  test('adding the gym admin: the first press sends nothing and names the gym', async () => {
    const { posts } = await mountWizard();
    await finishStep1();
    fireEvent.change(screen.getByPlaceholderText('owner@goldenboxing.org'), { target: { value: 'owner@golden.org' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Gym Admin & Finish' }));

    expect(screen.getByRole('button', { name: 'Press again: make owner@golden.org admin of Golden Boxing Studio' })).toBeInTheDocument();
    expect(posts.filter((post) => post.url.endsWith('/api/pilot/platform/staff'))).toHaveLength(0);
  });

  test('adding the gym admin: the second press maps them onto that gym, once', async () => {
    const { posts } = await mountWizard();
    await finishStep1();
    await finishStep2();

    const staff = posts.filter((post) => post.url.endsWith('/api/pilot/platform/staff'));
    expect(staff).toHaveLength(1);
    expect(staff[0].body).toEqual({ organization_id: 'golden_boxing', login_email: 'owner@golden.org', role: 'organization_admin' });
  });

  test('lane L31: there is no feature step; the admin is the last write and nothing reaches gym-capabilities', async () => {
    const { posts } = await mountWizard();
    expect(screen.queryByText(/Choose Your Features/)).toBeNull();
    expect(screen.getByText(/Follow these 2 simple steps/)).toBeInTheDocument();
    await finishStep1();
    await finishStep2();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save & Complete Setup/ })).toBeNull();
    expect(posts.map((post) => post.url.replace(/^.*\/api\//, '/api/'))).toEqual([
      '/api/pilot/platform/organizations',
      '/api/pilot/platform/staff',
    ]);
  });

  test('changing what the step would send disarms it', async () => {
    const { posts } = await mountWizard();
    fillGym();
    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));
    fireEvent.change(screen.getByPlaceholderText('Golden Boxing Studio'), { target: { value: 'Silver Boxing Studio' } });

    expect(screen.getByRole('button', { name: 'Create Gym & Continue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));
    expect(screen.getByRole('button', { name: 'Press again: save Silver Boxing Studio (golden_boxing)' })).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  test('changing the admin email disarms step 2', async () => {
    const { posts } = await mountWizard();
    await finishStep1();
    fireEvent.change(screen.getByPlaceholderText('owner@goldenboxing.org'), { target: { value: 'owner@golden.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Gym Admin & Finish' }));
    fireEvent.change(screen.getByPlaceholderText('owner@goldenboxing.org'), { target: { value: 'other@golden.org' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Gym Admin & Finish' }));
    expect(screen.getByRole('button', { name: 'Press again: make other@golden.org admin of Golden Boxing Studio' })).toBeInTheDocument();
    expect(posts.filter((post) => post.url.endsWith('/api/pilot/platform/staff'))).toHaveLength(0);
  });

  test('a double-click arms and does not write', async () => {
    const { posts } = await mountWizard();
    fillGym();
    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }), { detail: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Press again: save/ }), { detail: 2 });

    expect(screen.getByRole('button', { name: /^Press again: save/ })).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  test('a held Enter key does not repeat a press into a write', async () => {
    await mountWizard();
    fillGym();
    const button = screen.getByRole('button', { name: 'Create Gym & Continue' });

    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.keyDown(button, { key: 'Enter', repeat: true })).toBe(false);
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(true);
  });

  test('a refused create leaves the step disarmed and on step 1', async () => {
    await mountWizard();
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => (
      init?.method === 'POST'
        ? { ok: false, status: 400, json: async () => ({ error: 'Unsupported organization_id' }) } as Response
        : { ok: true, status: 200, json: async () => ({ ok: true, organizations: [] }) } as Response
    )) as unknown as typeof fetch;
    fillGym();
    fireEvent.click(screen.getByRole('button', { name: 'Create Gym & Continue' }));
    fireEvent.click(screen.getByRole('button', { name: /^Press again: save/ }));

    expect(await screen.findByText(/Unsupported organization_id/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Gym & Continue' })).toBeEnabled());
  });
});
